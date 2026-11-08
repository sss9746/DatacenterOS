// L5 needs the sim tick a running checkpoint is due on, to land the source Xid exactly then. The live
// ActionDetail sometimes carries due_sim_time_ms = null for a running checkpoint, so derive it the way
// physics does (simulate.ts: due = start + checkpoint_duration_ms) from the best observable start time.
// Pure: no I/O, so test/live/due.test.ts covers every branch.

import type { Checkpoint } from '@dcos/contracts';
import type { ActionDetail } from '@dcos/db-client';
import { CHECKPOINT_DURATION_MS } from '@dcos/physics';

export type DueSource =
  /** The ledger row already carried due_sim_time_ms. */
  | 'ledger_due'
  /** The snapshot's writing/requested checkpoint row for the key: requested_sim_time_ms + duration (physics' own formula). */
  | 'checkpoint_row'
  /** The action's lifecycle history: the sim time it entered `running` + duration. */
  | 'history_running'
  /** status.result.started_sim_time_ms (or started_sim_ms) + duration, when the reducer recorded one. */
  | 'status_result'
  /** status.updated_sim_time_ms while the action is `running` (its last transition was the start) + duration. */
  | 'status_updated'
  /** Nothing observable: first sim time the harness saw it running + duration. An ESTIMATE. */
  | 'observed_estimate';

export interface DueDerivation {
  due_sim_time_ms: number;
  start_sim_time_ms: number;
  source: DueSource;
  /** True only for `observed_estimate`: the start may be up to one poll interval late, so the due may be too. */
  estimate: boolean;
  duration_ms: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Due tick of a checkpoint action. Sources are tried in confidence order; `observedRunningSimMs` is the sim
 * clock at the first read in which the harness saw the action `running` (the last resort, labeled estimate).
 */
export function deriveCheckpointDue(
  detail: ActionDetail,
  checkpoints: readonly Checkpoint[],
  observedRunningSimMs: number,
  durationMs: number = CHECKPOINT_DURATION_MS,
): DueDerivation {
  const key = detail.command.command_key;
  const mk = (start: number, source: DueSource): DueDerivation => ({
    due_sim_time_ms: start + durationMs,
    start_sim_time_ms: start,
    source,
    estimate: source === 'observed_estimate',
    duration_ms: durationMs,
  });

  if (finite(detail.due_sim_time_ms)) {
    return { due_sim_time_ms: detail.due_sim_time_ms, start_sim_time_ms: detail.due_sim_time_ms - durationMs, source: 'ledger_due', estimate: false, duration_ms: durationMs };
  }

  const row = checkpoints.find((c) => c.command_key === key && (c.status === 'writing' || c.status === 'requested'));
  if (row && finite(row.requested_sim_time_ms)) return mk(row.requested_sim_time_ms, 'checkpoint_row');

  const running = detail.history.find((h) => h.status === 'running');
  if (running && finite(running.sim_time_ms)) return mk(running.sim_time_ms, 'history_running');

  const res = detail.status.result as { started_sim_time_ms?: unknown; started_sim_ms?: unknown } | undefined;
  const started = res?.started_sim_time_ms ?? res?.started_sim_ms;
  if (finite(started)) return mk(started, 'status_result');

  if (detail.status.status === 'running' && finite(detail.status.updated_sim_time_ms)) return mk(detail.status.updated_sim_time_ms, 'status_updated');

  return mk(observedRunningSimMs, 'observed_estimate');
}

/** One-line description for logs and failure messages. */
export const describeDue = (d: DueDerivation): string =>
  `due ${d.due_sim_time_ms} = start ${d.start_sim_time_ms} + ${d.duration_ms} (source ${d.source}${d.estimate ? ', ESTIMATE' : ''})`;
