import { describe, expect, it } from 'vitest';
import {
  applyFailure,
  checkAction,
  compileTopology,
  defaultDemoConfig,
  makeRng,
  simulate,
  step,
  type FacilityState,
} from '../src/index.js';

// S-4 step 1: needs S-2 (step) and S-3 (compile). Skipped until they land.
const READY = (() => {
  try {
    step(compileTopology(defaultDemoConfig()).state, 1, makeRng(1));
    return true;
  } catch {
    return false;
  }
})();

const LIMIT_MS = 100; // targets (LANE-S §3.3): step < 0.2, simulate(300) < 10, checkAction < 25 ms

function timeMs(n: number, fn: () => void): number {
  for (let i = 0; i < Math.min(n, 5); i++) fn(); // warm up
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  return (performance.now() - t0) / n;
}

describe.skipIf(!READY)('perf (Node, 12 components)', () => {
  it('step / simulate(300) / checkAction stay within budget', () => {
    const s: FacilityState = applyFailure(compileTopology(defaultDemoConfig()).state, {
      id: 1, kind: 'pump_fail', target_id: 'pump_B', params: {}, start_tick: 0, active: true,
    });
    const rng = makeRng(42);
    const stepMs = timeMs(2000, () => step(s, 1, rng));
    const simMs = timeMs(50, () => simulate(s, [], 300, rng));
    const checkMs = timeMs(30, () =>
      checkAction(s, { kind: 'shutdown_component', target_id: 'pump_A', params: {} }, rng));
    console.log(
      `[perf] step ${stepMs.toFixed(4)} ms (target < 0.2) | simulate(300) ${simMs.toFixed(3)} ms (target < 10) | ` +
        `checkAction ${checkMs.toFixed(3)} ms (target < 25)`,
    );
    expect(stepMs).toBeLessThan(LIMIT_MS);
    expect(simMs).toBeLessThan(LIMIT_MS);
    expect(checkMs).toBeLessThan(LIMIT_MS);
  });
});

describe('perf: gating', () => {
  it.skipIf(READY)('perf tests are skipped until S-2 + S-3 land (remove this gate in S-4 step 5)', () => {
    expect(READY).toBe(false);
  });
});
