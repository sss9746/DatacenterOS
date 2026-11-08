import { describe, expect, it } from 'vitest';
import {
  applyAction,
  applyFailure,
  checkAction,
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
} from '../src/v0/index.js';

function fail(kind: FailureKind, target_id: string, params: Failure['params'] = {}, id = 1): Failure {
  return { id, kind, target_id, params, start_tick: 0, active: true };
}
const def = (): FacilityState => compileTopology(defaultDemoConfig()).state;
const rng = () => makeRng(42);
const pumpBFailed = () => applyFailure(def(), fail('pump_fail', 'pump_B'));
const SHUT_PUMP_A: Action = { kind: 'shutdown_component', target_id: 'pump_A', params: {} };
const PREFIX = /^(OK: |BLOCKED: )/;

describe('checkAction (LANE-S §3.2, CONTRACTS §2 reason prefixes)', () => {
  it('the Pump A trap is BLOCKED with the cooling reason and an 8-rack projection', () => {
    const r = checkAction(pumpBFailed(), SHUT_PUMP_A, rng());
    console.log('[pump A trap]', r.reason);
    expect(r.ok).toBe(false);
    expect(r.reason.startsWith('BLOCKED: cooling 0 kW < load 48 kW')).toBe(true);
    expect(r.reason).toContain('; projected: 8 racks shut down within');
    expect(r.predicted).toEqual(simulate(pumpBFailed(), [SHUT_PUMP_A], 120, rng()));
  });

  it('the same action with both pumps healthy is OK', () => {
    const r = checkAction(def(), SHUT_PUMP_A, rng());
    console.log('[pump A, healthy]', r.reason);
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('OK: margin 2 kW, peak 22 °C over 120 s');
  });

  it('a helpful action in a bad state is NOT blocked (dispatch_tech pump_B with pump_B failed + fan fault)', () => {
    const s = setFanReading(step(pumpBFailed(), 1, rng()), 'rack_3', 0.9, 1);
    const r = checkAction(s, { kind: 'dispatch_tech', target_id: 'pump_B', params: {} }, rng());
    console.log('[dispatch_tech pump_B]', r.reason);
    expect(r.ok).toBe(true);
    expect(r.reason.startsWith('OK: margin ')).toBe(true);
  });

  it('a long horizon turns the trap into the shutdown reason (check 1 first)', () => {
    const r = checkAction(pumpBFailed(), SHUT_PUMP_A, rng(), 600);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^BLOCKED: 8 racks shut down within \d+(\.\d)? s; projected: 8 racks shut down within/);
  });

  it('overloading one rack is BLOCKED by the 45 °C check', () => {
    const r = checkAction(def(), { kind: 'set_load', target_id: 'rack_3', params: { kw: 26.5 } }, rng());
    console.log('[set_load rack_3 26.5]', r.reason);
    expect(r.ok).toBe(false);
    expect(r.reason.startsWith('BLOCKED: rack rack_3 exceeds 45 °C; projected: ')).toBe(true);
  });

  it('an invalid action returns ok:false with predicted = baseline, and never throws', () => {
    const s = pumpBFailed();
    const r = checkAction(s, { kind: 'migrate_load', target_id: 'rack_3', params: { kw: 3, to: 'rack_99' } }, rng());
    expect(r.ok).toBe(false);
    expect(r.reason.startsWith('BLOCKED: invalid action: ')).toBe(true);
    expect(r.predicted).toEqual(simulate(s, [], 120, rng()));
  });

  it('every reason uses a frozen prefix and the result is JSON-safe', () => {
    const s = pumpBFailed();
    const actions: Action[] = [
      SHUT_PUMP_A,
      { kind: 'shed_load', target_id: 'rack_8', params: { kw: 6 } },
      { kind: 'restore_component', target_id: 'pump_B', params: {} },
      { kind: 'set_load', target_id: 'rack_1', params: { kw: 60 } },
    ];
    for (const a of actions) {
      const r = checkAction(s, a, rng());
      expect(r.reason).toMatch(PREFIX);
      expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    }
  });
});
