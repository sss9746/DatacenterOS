import { describe, expect, it } from 'vitest';
import { initialState, step, type DebounceState, type FanEvent } from '../src/debounce.js';

function feed(lines: Array<[string, number]>, start: DebounceState = initialState): { events: FanEvent[]; state: DebounceState } {
  let state = start;
  const events: FanEvent[] = [];
  for (const [line, t] of lines) {
    const r = step(state, line, t);
    state = r.state;
    if (r.event) events.push(r.event);
  }
  return { events, state };
}
const repeat = (line: string, n: number, t0: number, dt = 100): Array<[string, number]> =>
  Array.from({ length: n }, (_, i) => [line, t0 + i * dt]);

describe('fan debounce', () => {
  it('emits exactly one stall and one recover for SPINNING -> STOPPED -> SPINNING', () => {
    const { events } = feed([...repeat('SPINNING', 15, 0), ...repeat('STOPPED', 30, 1500), ...repeat('SPINNING', 30, 4500)]);
    expect(events.map((e) => e.type)).toEqual(['stall', 'recover']);
  });

  it('does not stall on a short STOPPED blip', () => {
    const { events } = feed([...repeat('SPINNING', 5, 0), ...repeat('STOPPED', 5, 500), ...repeat('SPINNING', 20, 1000)]);
    expect(events).toEqual([]);
  });

  it('stalls after 10 consecutive lines even if timestamps are close together', () => {
    const { events } = feed(repeat('STOPPED', 10, 0, 1));
    expect(events.map((e) => e.type)).toEqual(['stall']);
  });

  it('stalls after 1000 ms even with few lines', () => {
    const { events } = feed([['STOPPED', 0], ['STOPPED', 1000]]);
    expect(events.map((e) => e.type)).toEqual(['stall']);
  });

  it('never re-emits stall while stalled, and ignores unknown lines', () => {
    const { events } = feed([...repeat('STOPPED', 50, 0), ['garbage', 5100], ['', 5200], ...repeat('STOPPED', 20, 5300)]);
    expect(events.map((e) => e.type)).toEqual(['stall']);
  });

  it('does not emit recover when never stalled', () => {
    const { events } = feed(repeat('SPINNING', 40, 0));
    expect(events).toEqual([]);
  });

  it('handles a second stall after a recover', () => {
    const { events } = feed([...repeat('STOPPED', 15, 0), ...repeat('SPINNING', 15, 2000), ...repeat('STOPPED', 15, 4000)]);
    expect(events.map((e) => e.type)).toEqual(['stall', 'recover', 'stall']);
  });
});
