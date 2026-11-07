import { describe, expect, it } from 'vitest';
import {
  applyAction,
  applyFailure,
  compileTopology,
  computeBalance,
  defaultDemoConfig,
  makeRng,
  setFanReading,
  simulate,
  step,
  type Action,
  type FacilityState,
  type Failure,
  type FailureKind,
} from '../src/index.js';

// S-4 step 1: these need S-2 (step/balance/actions/failures) and S-3 (compile). Skipped until they land.
const READY = (() => {
  try {
    const s = compileTopology(defaultDemoConfig()).state;
    step(s, 1, makeRng(1));
    computeBalance(s, 'true');
    applyAction(s, { kind: 'dispatch_tech', target_id: 'pump_A', params: {} });
    applyFailure(s, fail('pump_fail', 'pump_B'));
    setFanReading(s, 'rack_3', 0.5, 1);
    return true;
  } catch {
    return false;
  }
})();

function fail(kind: FailureKind, target_id: string, params: Failure['params'] = {}, id = 1): Failure {
  return { id, kind, target_id, params, start_tick: 0, active: true };
}
const def = (): FacilityState => compileTopology(defaultDemoConfig()).state;
const rng = () => makeRng(42);

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

describe.skipIf(!READY)('simulate: Outcome definitions (LANE-S §3.2/§3.3)', () => {
  it('healthy facility: margin +52, racks stay at 22 °C, no downtime', () => {
    const o = simulate(def(), [], 600, rng());
    expect(o.min_cooling_margin_kw).toBeCloseTo(52, 5);
    expect(o.peak_temp_c).toBeLessThanOrEqual(22.1);
    expect(o).toMatchObject({ racks_degraded: 0, racks_shutdown: 0, downtime_rack_s: 0 });
  });

  it('pump_B failed: margin +2, every rack < 23 °C', () => {
    const o = simulate(applyFailure(def(), fail('pump_fail', 'pump_B')), [], 600, rng());
    expect(o.min_cooling_margin_kw).toBeCloseTo(2, 5);
    expect(o.peak_temp_c).toBeLessThan(23);
    expect(o.racks_shutdown).toBe(0);
  });

  it('both pumps down: all 8 shut down, degraded racks that later shut down count only as shutdown', () => {
    const s = applyFailure(applyFailure(def(), fail('pump_fail', 'pump_A', {}, 1)), fail('pump_fail', 'pump_B', {}, 2));
    const o = simulate(s, [], 600, rng());
    expect(o.racks_shutdown).toBe(8);
    expect(o.racks_degraded).toBe(0);
    expect(o.min_cooling_margin_kw).toBeCloseTo(-48, 5);
    // degraded from ~245 s, shut down from ~360 s, counted until 600 s → about 8 × 355 rack-s
    expect(o.downtime_rack_s).toBeGreaterThan(8 * 330);
    expect(o.downtime_rack_s).toBeLessThan(8 * 380);
  });

  it('counts a rack already shut down at the start', () => {
    const s = applyAction(def(), { kind: 'shutdown_component', target_id: 'rack_8', params: {} });
    const o = simulate(s, [], 10, rng());
    expect(o.racks_shutdown).toBe(1);
    expect(o.downtime_rack_s).toBe(10);
  });

  it('ticks = 0 measures only the post-action state', () => {
    const o = simulate(def(), [{ kind: 'shutdown_component', target_id: 'pump_A', params: {} }], 0, rng());
    expect(o.min_cooling_margin_kw).toBeCloseTo(2, 5);
    expect(o.downtime_rack_s).toBe(0);
  });

  it('throws INVALID on an invalid action and rejects bad ticks', () => {
    const bad: Action = { kind: 'migrate_load', target_id: 'rack_3', params: { kw: 3, to: 'rack_99' } };
    expect(() => simulate(def(), [bad], 10, rng())).toThrow(/^(INVALID|NOT_FOUND): /);
    expect(() => simulate(def(), [], -1, rng())).toThrow(/^INVALID: /);
  });

  it('is pure (deep-frozen input) and deterministic', () => {
    const s = deepFreeze(applyFailure(def(), fail('pump_fail', 'pump_B')));
    const before = JSON.stringify(s);
    const a = simulate(s, [{ kind: 'shed_load', target_id: 'rack_8', params: { kw: 6 } }], 300, rng());
    const b = simulate(s, [{ kind: 'shed_load', target_id: 'rack_8', params: { kw: 6 } }], 300, rng());
    expect(JSON.stringify(s)).toBe(before);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a).sort()).toEqual(
      ['downtime_rack_s', 'min_cooling_margin_kw', 'peak_temp_c', 'racks_degraded', 'racks_shutdown'],
    );
  });

  it('real fan at 0.9: migrating 3 kW off rack_3 beats doing nothing', () => {
    const s = setFanReading(step(def(), 1, rng()), 'rack_3', 0.9, 1);
    const migrate: Action = { kind: 'migrate_load', target_id: 'rack_3', params: { kw: 3, to: 'rack_1' } };
    const none = simulate(s, [], 300, rng());
    const plan = simulate(s, [migrate], 300, rng());
    expect(none.peak_temp_c).toBeGreaterThan(35);
    expect(plan.peak_temp_c).toBeLessThan(none.peak_temp_c);
  });

  it('pump_B failed + fan 0.9: dispatch_tech pump_B + migrate beats doing nothing over 300 s', () => {
    const s = setFanReading(step(applyFailure(def(), fail('pump_fail', 'pump_B')), 1, rng()), 'rack_3', 0.9, 1);
    const plan: Action[] = [
      { kind: 'dispatch_tech', target_id: 'pump_B', params: {} },
      { kind: 'migrate_load', target_id: 'rack_3', params: { kw: 3, to: 'rack_1' } },
    ];
    const none = simulate(s, [], 300, rng());
    const fixed = simulate(s, plan, 300, rng());
    expect(fixed.peak_temp_c).toBeLessThan(none.peak_temp_c);
    expect(fixed.downtime_rack_s).toBeLessThanOrEqual(none.downtime_rack_s);
    expect(fixed.min_cooling_margin_kw).toBeGreaterThanOrEqual(none.min_cooling_margin_kw);
  });
});

describe('simulate: gating', () => {
  it.skipIf(READY)('real simulate tests are skipped until S-2 + S-3 land (remove this gate in S-4 step 5)', () => {
    expect(READY).toBe(false);
  });
});
