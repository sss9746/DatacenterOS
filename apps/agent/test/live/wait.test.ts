import { describe, expect, it } from 'vitest';
import { Budget, waitFor, WaitTimeoutError } from '../../scripts/live/wait.js';

/** Manual clock + timer queue so the tests never sleep. */
function fakeTime() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let seq = 0;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (h: unknown) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    /** Let every pending microtask (async evaluate -> re-arm timer) settle before the clock moves. */
    settle: () => new Promise<void>((r) => setImmediate(r)),
    /** Advance, firing due timers in order; drains microtasks after each so the next poll is armed. */
    async advance(ms: number) {
      const target = now + ms;
      await new Promise<void>((r) => setImmediate(r));
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > target) break;
        timers.shift();
        now = next.at;
        next.fn();
        await new Promise<void>((r) => setImmediate(r));
      }
      now = target;
    },
  };
}

describe('waitFor', () => {
  it('resolves as soon as a nudge makes the predicate true (no fixed sleep)', async () => {
    const t = fakeTime();
    let value = 0;
    let fire: (() => void) | null = null;
    const p = waitFor<number, number>({
      what: 'value 3',
      timeoutMs: 10_000,
      pollMs: 500,
      now: t.now,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      nudge: (f) => {
        fire = f;
        return () => (fire = null);
      },
      read: () => value,
      until: (v) => (v >= 3 ? v : null),
    });
    await Promise.resolve();
    value = 3;
    fire!();
    const r = await p;
    expect(r.value).toBe(3);
    expect(r.waitedMs).toBe(0);
    expect(fire).toBeNull(); // unsubscribed
  });

  it('polls when no nudge arrives and times out with the last summary', async () => {
    const t = fakeTime();
    let reads = 0;
    const p = waitFor<string>({
      what: 'never',
      timeoutMs: 2_000,
      pollMs: 500,
      now: t.now,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      read: () => `read#${++reads}`,
      until: () => null,
      summarize: (s) => s,
    });
    const settled = p.then(() => 'ok', (e: unknown) => e);
    await t.advance(3_000);
    const e = await settled;
    expect(e).toBeInstanceOf(WaitTimeoutError);
    expect((e as WaitTimeoutError).message).toMatch(/timed out after 2 s waiting for: never \(last: read#\d+\)/);
    expect(reads).toBeGreaterThanOrEqual(4);
  });

  it('aborts early when abortIf reports a reason (e.g. agent child died)', async () => {
    const t = fakeTime();
    let dead = false;
    const p = waitFor<number>({ what: 'x', timeoutMs: 10_000, pollMs: 100, now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer, read: () => 1, until: () => null, abortIf: () => (dead ? 'agent exited (code 1)' : null) });
    const settled = p.then(() => 'ok', (e: unknown) => (e as Error).message);
    dead = true;
    await t.advance(200);
    expect(await settled).toMatch(/aborted while waiting for x: agent exited/);
  });

  it('propagates read errors', async () => {
    const t = fakeTime();
    await expect(waitFor<number>({ what: 'x', timeoutMs: 1_000, now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer, read: () => { throw new Error('boom'); }, until: () => null })).rejects.toThrow('boom');
  });
});

describe('Budget', () => {
  it('never hands out more than what is left, floor 1 s', () => {
    let now = 0;
    const b = new Budget(10_000, () => now);
    expect(b.slice(4_000)).toBe(4_000);
    now = 9_500;
    expect(b.slice(4_000)).toBe(1_000);
    now = 20_000;
    expect(b.remainingMs).toBe(0);
    expect(b.slice(4_000)).toBe(1_000);
  });
});
