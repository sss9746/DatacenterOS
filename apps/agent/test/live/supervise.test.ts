import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, decideAfterExit, EXIT_GAVE_UP, EXIT_NOT_READY, runSupervisor, type ChildHandle, type StopSignal, type SupervisorPolicy } from '../../scripts/supervise.js';

const policy: SupervisorPolicy = { maxRestarts: 3, restartDelayMs: 1_000, stableResetMs: 60_000, stopGraceMs: 5_000 };
const exit = (over: Partial<Parameters<typeof decideAfterExit>[2]> = {}) => ({ code: null, signal: null, runMs: 500, stopRequested: false, ...over });

describe('decideAfterExit', () => {
  it('relaunches after a crash exit code or a signal such as SIGKILL', () => {
    expect(decideAfterExit(policy, 0, exit({ code: 1 }))).toMatchObject({ kind: 'restart', delayMs: 1_000, restartsUsed: 1 });
    expect(decideAfterExit(policy, 1, exit({ signal: 'SIGKILL' }))).toMatchObject({ kind: 'restart', restartsUsed: 2 });
    expect(decideAfterExit(policy, 0, exit({ code: 137 }))).toMatchObject({ kind: 'restart' });
  });

  it('never relaunches after a requested stop, however the child ended', () => {
    expect(decideAfterExit(policy, 0, exit({ code: 0, stopRequested: true }))).toMatchObject({ kind: 'stop', exitCode: 0 });
    expect(decideAfterExit(policy, 0, exit({ code: 1, stopRequested: true }))).toMatchObject({ kind: 'stop', exitCode: 1 });
    expect(decideAfterExit(policy, 0, exit({ signal: 'SIGKILL', stopRequested: true }))).toMatchObject({ kind: 'stop', exitCode: 0 });
  });

  it('does not relaunch after a clean exit or an adapter-not-ready exit', () => {
    expect(decideAfterExit(policy, 0, exit({ code: 0 }))).toMatchObject({ kind: 'stop', exitCode: 0 });
    expect(decideAfterExit(policy, 0, exit({ code: EXIT_NOT_READY }))).toMatchObject({ kind: 'stop', exitCode: EXIT_NOT_READY });
  });

  it('enforces the restart bound', () => {
    expect(decideAfterExit(policy, 2, exit({ code: 1 }))).toMatchObject({ kind: 'restart', restartsUsed: 3 });
    expect(decideAfterExit(policy, 3, exit({ code: 1 }))).toMatchObject({ kind: 'stop', exitCode: EXIT_GAVE_UP });
  });

  it('a stable run clears the count; a shorter one does not', () => {
    expect(decideAfterExit(policy, 3, exit({ code: 1, runMs: 60_000 }))).toMatchObject({ kind: 'restart', restartsUsed: 1 });
    expect(decideAfterExit(policy, 3, exit({ code: 1, runMs: 59_999 }))).toMatchObject({ kind: 'stop' });
  });

  it('ships a short delay and a bounded count', () => {
    expect(DEFAULT_POLICY.maxRestarts).toBeGreaterThan(0);
    expect(DEFAULT_POLICY.restartDelayMs).toBeLessThanOrEqual(2_000);
  });
});

class FakeChild implements ChildHandle {
  readonly killed: NodeJS.Signals[] = [];
  private cb: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
  constructor(readonly pid: number) {}
  kill(signal: NodeJS.Signals) {
    this.killed.push(signal);
  }
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void) {
    this.cb = cb;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.cb?.(code, signal);
  }
}

function harness(overrides: Partial<SupervisorPolicy> = {}) {
  let clock = 0;
  let nextTimer = 1;
  const timers = new Map<number, { fn: () => void; at: number }>();
  const children: FakeChild[] = [];
  const logs: string[] = [];
  let signalHandler: ((s: StopSignal) => void) | null = null;
  let unregistered = false;
  const result = runSupervisor({
    spawnChild: () => {
      const c = new FakeChild(100 + children.length);
      children.push(c);
      return c;
    },
    log: (m) => logs.push(m),
    onStopSignal: (h) => {
      signalHandler = h;
      return () => {
        unregistered = true;
      };
    },
    policy: { ...policy, ...overrides },
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimer: (h) => void timers.delete(h as number),
  });
  return {
    result,
    children,
    logs,
    timers,
    signal: (s: StopSignal) => signalHandler?.(s),
    isUnregistered: () => unregistered,
    advance(ms: number) {
      clock += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= clock) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

describe('runSupervisor', () => {
  it('relaunches after SIGKILL, once the delay passes, one child at a time, and logs it', () => {
    const h = harness();
    expect(h.children).toHaveLength(1);
    h.children[0]!.exit(null, 'SIGKILL');
    expect(h.children).toHaveLength(1);
    h.advance(999);
    expect(h.children).toHaveLength(1);
    h.advance(1);
    expect(h.children).toHaveLength(2);
    expect(h.logs.join('\n')).toMatch(/signal SIGKILL.*restart 1\/3 in 1000 ms/);
  });

  it('forwards SIGINT and SIGTERM, then exits without a relaunch', async () => {
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      const h = harness();
      h.signal(sig);
      expect(h.children[0]!.killed).toEqual([sig]);
      h.children[0]!.exit(0);
      await expect(h.result).resolves.toBe(0);
      h.advance(60_000);
      expect(h.children).toHaveLength(1);
      expect(h.isUnregistered()).toBe(true);
    }
  });

  it('SIGHUP stops the agent gracefully with SIGTERM', () => {
    const h = harness();
    h.signal('SIGHUP');
    expect(h.children[0]!.killed).toEqual(['SIGTERM']);
  });

  it('forwards only the first signal, so a relayed duplicate cannot cut the agent shutdown short', () => {
    const h = harness();
    h.signal('SIGINT');
    h.signal('SIGINT');
    expect(h.children[0]!.killed).toEqual(['SIGINT']);
  });

  it('a stop during the restart delay cancels the relaunch', async () => {
    const h = harness();
    h.children[0]!.exit(1);
    h.signal('SIGTERM');
    await expect(h.result).resolves.toBe(0);
    h.advance(60_000);
    expect(h.children).toHaveLength(1);
  });

  it('gives up at the bound with a failing exit code', async () => {
    const h = harness();
    for (let i = 0; i < 3; i += 1) {
      h.children[i]!.exit(1);
      h.advance(1_000);
    }
    expect(h.children).toHaveLength(4);
    h.children[3]!.exit(1);
    await expect(h.result).resolves.toBe(EXIT_GAVE_UP);
    expect(h.logs.join('\n')).toMatch(/giving up after 3 restarts/);
    h.advance(60_000);
    expect(h.children).toHaveLength(4);
  });

  it('a stable run resets the count, so later crashes get the full allowance', () => {
    const h = harness();
    h.children[0]!.exit(1);
    h.advance(1_000);
    h.children[1]!.exit(1);
    h.advance(1_000);
    h.advance(60_000);
    h.children[2]!.exit(1);
    expect(h.logs.at(-1)).toMatch(/restart 1\/3/);
  });

  it('SIGKILLs an agent that ignores the stop signal, after the grace period', async () => {
    const h = harness();
    h.signal('SIGTERM');
    h.advance(4_999);
    expect(h.children[0]!.killed).toEqual(['SIGTERM']);
    h.advance(1);
    expect(h.children[0]!.killed).toEqual(['SIGTERM', 'SIGKILL']);
    h.children[0]!.exit(null, 'SIGKILL');
    await expect(h.result).resolves.toBe(0);
  });

  it('a prompt exit cancels the grace timer', () => {
    const h = harness();
    h.signal('SIGTERM');
    h.children[0]!.exit(0);
    expect(h.timers.size).toBe(0);
  });

  it('exits with a failure if the agent cannot be launched', async () => {
    const result = runSupervisor({ spawnChild: () => { throw new Error('secret-value-in-message'); }, log: (m) => expect(m).not.toContain('secret-value-in-message'), onStopSignal: () => () => undefined });
    await expect(result).resolves.toBe(EXIT_GAVE_UP);
  });
});
