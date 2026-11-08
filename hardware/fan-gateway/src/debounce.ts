// Pure debounce for the Pico's SPINNING / STOPPED lines. A state must be sustained for HOLD_MS (or
// HOLD_LINES consecutive lines, whichever comes first) before it counts. Emits "stall" once on entering
// a sustained STOPPED, "recover" once on a sustained SPINNING while stalled. Unknown lines are ignored.

export type FanReading = 'SPINNING' | 'STOPPED';
export type FanEvent = { type: 'stall' | 'recover'; heldMs: number; lines: number };

export const HOLD_MS = 1000;
export const HOLD_LINES = 10;

export interface DebounceState {
  readonly stalled: boolean;
  readonly current: FanReading | null;
  readonly since: number;
  readonly lines: number;
}

export const initialState: DebounceState = { stalled: false, current: null, since: 0, lines: 0 };

export function parseLine(line: string): FanReading | null {
  const s = line.trim();
  return s === 'SPINNING' || s === 'STOPPED' ? s : null;
}

export function step(state: DebounceState, line: string, nowMs: number): { state: DebounceState; event: FanEvent | null } {
  const reading = parseLine(line);
  if (!reading) return { state, event: null };
  const run = reading === state.current
    ? { ...state, lines: state.lines + 1 }
    : { ...state, current: reading, since: nowMs, lines: 1 };
  const heldMs = nowMs - run.since;
  const sustained = heldMs >= HOLD_MS || run.lines >= HOLD_LINES;
  if (!sustained) return { state: run, event: null };
  if (reading === 'STOPPED' && !run.stalled) {
    return { state: { ...run, stalled: true }, event: { type: 'stall', heldMs, lines: run.lines } };
  }
  if (reading === 'SPINNING' && run.stalled) {
    return { state: { ...run, stalled: false }, event: { type: 'recover', heldMs, lines: run.lines } };
  }
  return { state: run, event: null };
}
