// Live team-round progress (plans/WORKFLOW-TAB-INTEGRATION.md, Stage 2): the round reports a copy of its trace as it
// goes; this sink persists those copies to `workflow.state.team` without ever racing the round's final save.
// `coord.updateStage` is compare-and-swap on the workflow version and is not serialized, so: one write in flight,
// latest wins, writes spaced out, and `withTeamProgress` drains the sink before the chooser returns.
//
// No runtime import from ./protocol.js on purpose: the agent-loop tests mock that module.

import type { OptionChooser } from '../planner.js';
import type { TeamRoundHistory, TeamTrace } from './protocol.js';

export const DEFAULT_PROGRESS_INTERVAL_MS = 300;
/** Earlier rounds kept in `state.team_rounds.rounds` (same value as TEAM_LIMITS.historyRounds). */
export const TEAM_HISTORY_ROUNDS = 4;

export interface TeamProgressSinkOptions {
  /**
   * Persists one progress trace. Resolving `false` means ownership is gone: the sink stops for good. A throw or a
   * rejection is logged and ignored (the round and its final save are unaffected).
   */
  write: (trace: TeamTrace) => Promise<unknown>;
  minIntervalMs?: number;
  log?: (msg: string) => void;
  /** Injected by tests; defaults to Date.now. */
  now?: () => number;
}

export interface TeamProgressSink {
  /** Queue the latest trace; an unwritten earlier one is replaced. Never throws, never blocks. */
  push(trace: TeamTrace): void;
  /**
   * Resolves once no write is in flight. A queued trace that has not started is dropped: the caller's final save
   * supersedes it. The sink stays usable afterwards.
   */
  drain(): Promise<void>;
  /** No further writes (ownership lost). A write already in flight still settles. */
  stop(): void;
}

export function createTeamProgressSink(opts: TeamProgressSinkOptions): TeamProgressSink {
  const minIntervalMs = Math.max(0, opts.minIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS);
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now;
  let pending: TeamTrace | null = null;
  let inflight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastStart = Number.NEGATIVE_INFINITY;
  let stopped = false;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const start = () => {
    const trace = pending!;
    pending = null;
    lastStart = now();
    inflight = Promise.resolve()
      .then(() => opts.write(trace))
      .then(
        (r) => {
          if (r === false) {
            log('team progress: workflow ownership lost; no further progress writes');
            stop();
          }
        },
        (e: unknown) => log(`team progress write failed (ignored): ${e instanceof Error ? e.message : String(e)}`),
      )
      .finally(() => {
        inflight = null;
        schedule();
      });
  };

  const schedule = () => {
    if (stopped || !pending || inflight || timer) return;
    const wait = lastStart + minIntervalMs - now();
    if (wait <= 0) {
      start();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      schedule();
    }, wait);
    (timer as { unref?: () => void }).unref?.();
  };

  function stop(): void {
    stopped = true;
    pending = null;
    clearTimer();
  }

  return {
    push(trace) {
      if (stopped) return;
      pending = trace;
      try {
        schedule();
      } catch (e) {
        log(`team progress scheduling failed (ignored): ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    async drain() {
      pending = null;
      clearTimer();
      while (inflight) await inflight;
    },
    stop,
  };
}

/**
 * Wraps a chooser so the round reports into `sink`, and ALWAYS drains the sink before returning or throwing: the
 * caller's final save (a CAS on the workflow version) then never overlaps a progress write.
 */
export function withTeamProgress(chooser: OptionChooser, sink: TeamProgressSink): OptionChooser {
  return async (input) => {
    try {
      return await chooser({ ...input, onProgress: (trace) => sink.push(trace) });
    } finally {
      await sink.drain();
    }
  };
}

// ---------------------------------------------------------------------------------------------- round history

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const asTrace = (v: unknown): TeamTrace | null => (isRecord(v) && typeof v.round_id === 'string' ? (v as unknown as TeamTrace) : null);

function readHistory(v: unknown): TeamRoundHistory | null {
  if (!isRecord(v) || !Array.isArray(v.rounds)) return null;
  return { rounds: v.rounds.map(asTrace).filter((t): t is TeamTrace => t !== null), dropped: typeof v.dropped === 'number' ? v.dropped : 0 };
}

/** The same run of the same round: progress and final save of one round share `started_unix_ms`. v1 has none. */
const sameRun = (a: TeamTrace, b: TeamTrace): boolean =>
  a.round_id === b.round_id && a.started_unix_ms !== undefined && a.started_unix_ms === b.started_unix_ms;

/**
 * The `{ team, team_rounds }` patch that writes `trace` as the current round. When `trace` is a different round (or
 * a rerun of the same round_id after a crash), the previous `state.team` moves into history first; a previous v2
 * trace still `running` is archived as `interrupted` (the agent died mid-round). A history entry with the same
 * round_id is replaced in place, not appended. History keeps the last TEAM_HISTORY_ROUNDS, oldest first, and counts
 * the rest in `dropped`. v1 traces are archived unchanged.
 */
export function teamStatePatch(state: Record<string, unknown>, trace: TeamTrace): { team: TeamTrace; team_rounds?: TeamRoundHistory } {
  const prev = asTrace(state.team);
  const history = readHistory(state.team_rounds);
  if (!prev || sameRun(prev, trace)) return history ? { team: trace, team_rounds: history } : { team: trace };

  const archived: TeamTrace = prev.version !== 1 && prev.status === 'running' ? { ...prev, status: 'interrupted' } : prev;
  let rounds = history?.rounds ?? [];
  let dropped = history?.dropped ?? 0;
  const at = rounds.findIndex((r) => r.round_id === archived.round_id);
  rounds = at >= 0 ? rounds.map((r, i) => (i === at ? archived : r)) : [...rounds, archived];
  while (rounds.length > TEAM_HISTORY_ROUNDS) {
    rounds = rounds.slice(1);
    dropped += 1;
  }
  return { team: trace, team_rounds: { rounds, dropped } };
}
