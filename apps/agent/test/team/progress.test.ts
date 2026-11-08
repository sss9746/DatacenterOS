import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChooserInput, ChooserResult, OptionChooser } from '../../src/planner.js';
import { TEAM_HISTORY_ROUNDS, createTeamProgressSink, teamStatePatch, withTeamProgress } from '../../src/team/progress.js';
import { TEAM_LIMITS, type TeamTrace } from '../../src/team/protocol.js';

afterEach(() => {
  vi.useRealTimers();
});

const v2 = (round_id: string, over: Partial<TeamTrace> = {}): TeamTrace => ({
  version: 2,
  round_id,
  snapshot_sim_ms: 0,
  model: null,
  calls_used: 0,
  wall_ms: 0,
  outcome: 'deterministic',
  messages: [],
  covers: [],
  missing_roles: [],
  status: 'running',
  phase: 'findings',
  started_unix_ms: 1_000,
  budget: { max_calls: 6, round_ms: 30_000, call_timeout_ms: 12_000 },
  calls: [],
  ...over,
});

const v1 = (round_id: string): TeamTrace => ({
  version: 1,
  round_id,
  snapshot_sim_ms: 0,
  model: 'm',
  calls_used: 5,
  wall_ms: 9,
  outcome: 'lead',
  messages: [],
  covers: [],
  missing_roles: [],
});

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('progress sink', () => {
  it('writes the first trace at once, coalesces the rest (latest wins) and spaces writes apart', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const writes: { id: string; at: number }[] = [];
    let inFlight = 0;
    let peak = 0;
    const sink = createTeamProgressSink({
      write: async (t) => {
        peak = Math.max(peak, ++inFlight);
        writes.push({ id: t.round_id, at: Date.now() });
        await new Promise((r) => setTimeout(r, 50));
        inFlight -= 1;
      },
      minIntervalMs: 300,
    });
    sink.push(v2('a'));
    sink.push(v2('b'));
    sink.push(v2('c'));
    await vi.advanceTimersByTimeAsync(100);
    sink.push(v2('d'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writes.map((w) => w.id)).toEqual(['a', 'd']);
    expect(writes[1]!.at - writes[0]!.at).toBeGreaterThanOrEqual(300);
    expect(peak).toBe(1);
  });

  it('keeps writing at most once per interval under a steady stream', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const at: number[] = [];
    const sink = createTeamProgressSink({ write: async () => void at.push(Date.now()), minIntervalMs: 300 });
    for (let i = 0; i < 20; i++) {
      sink.push(v2(`r${i}`));
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(1_000);
    expect(at.length).toBeGreaterThan(2);
    expect(at.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(300);
  });

  it('logs and ignores a throwing or rejecting write, and keeps going', async () => {
    const logs: string[] = [];
    const written: string[] = [];
    let n = 0;
    const sink = createTeamProgressSink({
      write: (t) => {
        n += 1;
        if (n === 1) throw new Error('sync boom');
        if (n === 2) return Promise.reject(new Error('async boom'));
        written.push(t.round_id);
        return Promise.resolve();
      },
      minIntervalMs: 0,
      log: (m) => logs.push(m),
    });
    sink.push(v2('a'));
    await sink.drain();
    sink.push(v2('b'));
    await sink.drain();
    sink.push(v2('c'));
    await sink.drain();
    expect(written).toEqual(['c']);
    expect(logs.filter((l) => l.includes('ignored'))).toHaveLength(2);
  });

  it('stops for good when the write reports lost ownership, or after stop()', async () => {
    const written: string[] = [];
    const sink = createTeamProgressSink({ write: async (t) => (written.push(t.round_id), false), minIntervalMs: 0 });
    sink.push(v2('a'));
    await sink.drain();
    sink.push(v2('b'));
    await sink.drain();
    expect(written).toEqual(['a']);

    const other: string[] = [];
    const stopped = createTeamProgressSink({ write: async (t) => void other.push(t.round_id), minIntervalMs: 0 });
    stopped.stop();
    stopped.push(v2('x'));
    await stopped.drain();
    expect(other).toEqual([]);
  });

  it('drain waits for the write in flight and drops a queued one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const gate = deferred();
    const written: string[] = [];
    const sink = createTeamProgressSink({
      write: async (t) => {
        written.push(t.round_id);
        await gate.promise;
      },
      minIntervalMs: 300,
    });
    sink.push(v2('a'));
    sink.push(v2('b'));
    let drained = false;
    const d = sink.drain().then(() => (drained = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(drained).toBe(false);
    gate.resolve();
    await d;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(written).toEqual(['a']);
  });
});

describe('withTeamProgress', () => {
  const input = {} as ChooserInput;
  const result: ChooserResult = { choices: null, team: v2('r', { status: 'closed', phase: 'closed' }) };

  it('injects onProgress and returns only after the progress write in flight has settled', async () => {
    const gate = deferred();
    const order: string[] = [];
    const sink = createTeamProgressSink({
      write: async () => {
        order.push('write start');
        await gate.promise;
        order.push('write end');
      },
      minIntervalMs: 0,
    });
    const chooser: OptionChooser = async (i) => {
      i.onProgress!(v2('r'));
      await Promise.resolve();
      return result;
    };
    const running = withTeamProgress(chooser, sink)(input).then((r) => {
      order.push('returned');
      return r;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(['write start']);
    gate.resolve();
    expect(await running).toBe(result);
    expect(order).toEqual(['write start', 'write end', 'returned']);
  });

  it('drains before rethrowing a chooser error', async () => {
    const gate = deferred();
    let settled = false;
    const sink = createTeamProgressSink({
      write: async () => {
        await gate.promise;
        settled = true;
      },
      minIntervalMs: 0,
    });
    const chooser: OptionChooser = async (i) => {
      i.onProgress!(v2('r'));
      await Promise.resolve();
      throw new Error('round crashed');
    };
    const running = withTeamProgress(chooser, sink)(input);
    setTimeout(() => gate.resolve(), 5);
    await expect(running).rejects.toThrow('round crashed');
    expect(settled).toBe(true);
  });
});

describe('round history (teamStatePatch)', () => {
  it('replaces the current trace for the same run of the same round, with no history', () => {
    const running = v2('wf:a1:e1');
    const closed = v2('wf:a1:e1', { status: 'closed', phase: 'closed' });
    expect(teamStatePatch({}, running)).toEqual({ team: running });
    expect(teamStatePatch({ team: running }, closed)).toEqual({ team: closed });
  });

  it('moves the previous round into history, oldest first, keeping the last 4 and counting the rest', () => {
    expect(TEAM_HISTORY_ROUNDS).toBe(TEAM_LIMITS.historyRounds);
    let state: Record<string, unknown> = {};
    for (let i = 1; i <= 7; i++) state = { ...state, ...teamStatePatch(state, v2(`wf:a${i}:e1`, { status: 'closed', phase: 'closed', started_unix_ms: i })) };
    expect((state.team as TeamTrace).round_id).toBe('wf:a7:e1');
    const history = state.team_rounds as { rounds: TeamTrace[]; dropped: number };
    expect(history.rounds.map((r) => r.round_id)).toEqual(['wf:a3:e1', 'wf:a4:e1', 'wf:a5:e1', 'wf:a6:e1']);
    expect(history.dropped).toBe(2);
  });

  it('archives a previous round still running as interrupted (the agent died mid-round)', () => {
    const killed = v2('wf:a1:e1', { calls: [{ role: 'cooling', phase: 'findings', started_ms: 0, ended_ms: null, status: 'running' }] });
    const next = v2('wf:a2:e1', { started_unix_ms: 9_000 });
    const patch = teamStatePatch({ team: killed }, next);
    expect(patch.team).toBe(next);
    expect(patch.team_rounds!.rounds).toEqual([{ ...killed, status: 'interrupted' }]);
    expect(killed.status).toBe('running'); // the input is not mutated
  });

  it('a crash rerun of the same round_id archives the interrupted run, then the finished rerun replaces that entry', () => {
    const killed = v2('wf:a1:e1', { started_unix_ms: 1_000 });
    const rerun = v2('wf:a1:e1', { started_unix_ms: 20_000 });
    let state: Record<string, unknown> = { team: killed };
    state = { ...state, ...teamStatePatch(state, rerun) };
    expect((state.team_rounds as { rounds: TeamTrace[] }).rounds.map((r) => [r.round_id, r.status])).toEqual([['wf:a1:e1', 'interrupted']]);

    const rerunClosed = { ...rerun, status: 'closed' as const, phase: 'closed' as const };
    state = { ...state, ...teamStatePatch(state, rerunClosed) };
    expect(state.team).toEqual(rerunClosed);
    state = { ...state, ...teamStatePatch(state, v2('wf:a2:e1', { started_unix_ms: 40_000 })) };
    const rounds = (state.team_rounds as { rounds: TeamTrace[]; dropped: number }).rounds;
    expect(rounds.map((r) => [r.round_id, r.status])).toEqual([['wf:a1:e1', 'closed']]);
    expect((state.team_rounds as { dropped: number }).dropped).toBe(0);
  });

  it('archives v1 traces unchanged and tolerates a missing or malformed history', () => {
    const old = v1('wf:a1:e1');
    const patch = teamStatePatch({ team: old, team_rounds: 'garbage' }, v2('wf:a2:e1'));
    expect(patch.team_rounds).toEqual({ rounds: [old], dropped: 0 });
    // A v1 trace with the same round_id is still a different run (it has no start time).
    expect(teamStatePatch({ team: old }, v2('wf:a1:e1')).team_rounds!.rounds).toEqual([old]);
  });
});
