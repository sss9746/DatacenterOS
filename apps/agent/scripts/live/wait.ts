// Bounded waits. Correctness never depends on a fixed sleep: `waitFor` re-evaluates a predicate whenever a
// subscription nudges it and on a short poll, and gives up at a wall-time deadline with the last observed
// summary so the failure artifact says what the DB looked like.

export class WaitTimeoutError extends Error {
  readonly lastSummary: string;
  readonly waitedMs: number;
  constructor(what: string, waitedMs: number, lastSummary: string) {
    super(`timed out after ${Math.round(waitedMs / 1000)} s waiting for: ${what} (last: ${lastSummary})`);
    this.name = 'WaitTimeoutError';
    this.lastSummary = lastSummary;
    this.waitedMs = waitedMs;
  }
}

export interface WaitOptions<T> {
  what: string;
  timeoutMs: number;
  /** Re-evaluation interval while no nudge arrives (default 500 ms). */
  pollMs?: number;
  /** Subscribe to change nudges; return an unsubscribe. Optional: polling alone is correct, just slower. */
  nudge?: (fire: () => void) => () => void;
  /** Reads current state; may be async (snapshot fetch). */
  read: () => Promise<T> | T;
  /** Return a non-null value to finish. */
  until: (state: T) => unknown;
  /** One-line description of `state` for timeout messages. Never include secrets. */
  summarize?: (state: T) => string;
  /** Abort early with a reason (e.g. the agent child died when it should be alive). */
  abortIf?: () => string | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export interface WaitResult<T, R> {
  state: T;
  value: R;
  waitedMs: number;
}

export async function waitFor<T, R = unknown>(opts: WaitOptions<T>): Promise<WaitResult<T, NonNullable<R>>> {
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const pollMs = opts.pollMs ?? 500;
  const started = now();
  const deadline = started + opts.timeoutMs;
  let last: T | undefined;
  let lastSummary = '(never read)';
  let evaluating = false;
  let pending = false;

  return new Promise<WaitResult<T, NonNullable<R>>>((resolve, reject) => {
    let done = false;
    let timer: unknown = null;
    let unsub: (() => void) | null = null;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      if (timer) clearTimer(timer);
      unsub?.();
      fn();
    };
    const evaluate = async () => {
      if (done) return;
      if (evaluating) {
        pending = true;
        return;
      }
      evaluating = true;
      try {
        const abort = opts.abortIf?.();
        if (abort) return finish(() => reject(new Error(`aborted while waiting for ${opts.what}: ${abort}`)));
        const state = await opts.read();
        last = state;
        lastSummary = opts.summarize ? opts.summarize(state) : '(no summary)';
        const v = opts.until(state) as R;
        if (v !== null && v !== undefined && v !== false) {
          return finish(() => resolve({ state, value: v as NonNullable<R>, waitedMs: now() - started }));
        }
        if (now() >= deadline) return finish(() => reject(new WaitTimeoutError(opts.what, now() - started, lastSummary)));
      } catch (e) {
        return finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      } finally {
        evaluating = false;
        if (pending && !done) {
          pending = false;
          void evaluate();
        }
      }
    };
    const schedule = () => {
      if (done) return;
      timer = setTimer(() => {
        void evaluate().then(schedule);
      }, pollMs);
    };
    unsub = opts.nudge ? opts.nudge(() => void evaluate()) : null;
    void evaluate().then(schedule);
    void last;
  });
}

/** Sleep that is only ever used for pacing (never for correctness). */
export const pace = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wall-clock budget shared by a case: hands out per-phase timeouts that never exceed what is left. */
export class Budget {
  private readonly started: number;
  constructor(readonly totalMs: number, private readonly now: () => number = Date.now) {
    this.started = now();
  }
  get remainingMs(): number {
    return Math.max(0, this.totalMs - (this.now() - this.started));
  }
  /** At most `wantMs`, never more than what is left (minimum 1 s so a wait fails fast with a clear message). */
  slice(wantMs: number): number {
    return Math.max(1_000, Math.min(wantMs, this.remainingMs));
  }
}
