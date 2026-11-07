import { describe, expect, it } from 'vitest';
import {
  SYMPTOMS,
  applyAction,
  applyFailure,
  compileTopology,
  computeBalance,
  defaultDemoConfig,
  detect,
  makeRng,
  setFanReading,
  step,
  type FacilityState,
  type Failure,
  type FailureKind,
  type IncidentDraft,
  type Symptom,
  type TelemetryPoint,
} from '../src/index.js';

function fail(kind: FailureKind, target_id: string, params: Failure['params'] = {}, id = 1): Failure {
  return { id, kind, target_id, params, start_tick: 0, active: true };
}
const def = (): FacilityState => compileTopology(defaultDemoConfig()).state;
const rng = makeRng(42);
const run = (s: FacilityState, n: number): FacilityState => {
  let cur = s;
  for (let i = 0; i < n; i++) cur = step(cur, 1, rng);
  return cur;
};
const find = (ds: IncidentDraft[], sym: Symptom) => ds.find((d) => d.symptom === sym);
const syms = (ds: IncidentDraft[]) => ds.map((d) => d.symptom);
/** Test-only copy (JSON round trip is fine outside src/). */
const copy = (s: FacilityState): FacilityState => JSON.parse(JSON.stringify(s)) as FacilityState;

describe('detect (LANE-S §3.2 symptom table)', () => {
  it('a healthy facility emits nothing', () => {
    expect(detect(run(def(), 30), [], [])).toEqual([]);
  });

  it('reads OBSERVED temps only: a frozen sensor at 22 with a true 50 °C does not fire rack_temp_warning', () => {
    const s = copy(run(def(), 1));
    const r5 = s.components.rack_5;
    r5.true_temp_c = 50;
    r5.true_status = 'degraded';
    r5.sensor_frozen = true;
    r5.observed_temp_c = 22;
    r5.observed_status = 'online';
    const ds = detect(s, [], []);
    expect(find(ds, 'rack_temp_warning')).toBeUndefined();
    expect(ds).toEqual([]);
  });

  it('rack_temp_warning from the observed temp: high at ≥ 35, critical at ≥ 45', () => {
    const s = copy(run(def(), 1));
    s.components.rack_2.observed_temp_c = 36;
    expect(find(detect(s, [], []), 'rack_temp_warning')).toEqual({
      symptom: 'rack_temp_warning', component_ids: ['rack_2'], severity: 'high',
    });
    s.components.rack_4.observed_temp_c = 46;
    expect(find(detect(s, [], []), 'rack_temp_warning')).toEqual({
      symptom: 'rack_temp_warning', component_ids: ['rack_2', 'rack_4'], severity: 'critical',
    });
  });

  it('sensor_freeze rack_5 (both pumps failed): thermal_imbalance within ≤ 16 ticks, observed frozen, true evolves', () => {
    let s = applyFailure(def(), fail('pump_fail', 'pump_A', {}, 1));
    s = applyFailure(s, fail('pump_fail', 'pump_B', {}, 2));
    s = applyFailure(s, fail('sensor_freeze', 'rack_5', {}, 3));
    const frozenAt = s.components.rack_5.observed_temp_c;
    let firedAt = -1;
    for (let k = 1; k <= 16; k++) {
      s = step(s, 1, rng);
      expect(s.components.rack_5.sensor_age_s).toBeCloseTo(k, 5);
      expect(s.components.rack_5.observed_temp_c).toBe(frozenAt);
      const d = find(detect(s, [], []), 'thermal_imbalance');
      if (d && firedAt < 0) {
        firedAt = k;
        expect(d).toEqual({ symptom: 'thermal_imbalance', component_ids: ['rack_5'], severity: 'high' });
      }
    }
    expect(firedAt).toBeGreaterThan(0);
    expect(firedAt).toBeLessThanOrEqual(16);
    expect(s.components.rack_5.true_temp_c).toBeGreaterThan(frozenAt + 1);
  });

  it('thermal_imbalance (b): a flat reported temp over 20 history points while under-cooled', () => {
    const s = copy(run(def(), 1));
    s.components.rack_2.load_kw = 6;
    s.components.rack_2.cooling_kw = 2;
    const history: TelemetryPoint[] = Array.from({ length: 20 }, (_, i) => ({
      component_id: 'rack_2', tick: i + 1, temp_c: 30 + (i % 2) * 0.02, power_kw: 6, cooling_kw: 2,
    }));
    expect(find(detect(s, history, []), 'thermal_imbalance')?.component_ids).toEqual(['rack_2']);
    expect(find(detect(s, history.slice(1), []), 'thermal_imbalance')).toBeUndefined();
  });

  it('load_spike rack_7 +4 kW with pump_B failed: cooling_margin_negative (high, offline pumps + all racks)', () => {
    let s = applyFailure(def(), fail('pump_fail', 'pump_B', {}, 1));
    s = applyFailure(s, fail('load_spike', 'rack_7', { extra_kw: 4 }, 2));
    s = run(s, 1);
    expect(computeBalance(s, 'observed').margin_kw).toBeCloseTo(-2, 5);
    const d = find(detect(s, [], []), 'cooling_margin_negative');
    expect(d?.severity).toBe('high');
    expect(d?.component_ids).toEqual(['pump_B', 'rack_1', 'rack_2', 'rack_3', 'rack_4', 'rack_5', 'rack_6', 'rack_7', 'rack_8']);
  });

  it('both pumps down: cooling_margin_negative is critical', () => {
    let s = applyFailure(def(), fail('pump_fail', 'pump_A', {}, 1));
    s = applyFailure(s, fail('pump_fail', 'pump_B', {}, 2));
    expect(find(detect(run(s, 1), [], []), 'cooling_margin_negative')?.severity).toBe('critical');
  });

  it('utility_loss util_1: power_on_ups (high, then critical below 25% energy)', () => {
    let s = run(applyFailure(def(), fail('utility_loss', 'util_1')), 1);
    expect(find(detect(s, [], []), 'power_on_ups')).toEqual({
      symptom: 'power_on_ups', component_ids: ['util_1', 'ups_1'], severity: 'high',
    });
    s = run(s, 1100); // ≈ 18.3 min of a ≈ 22.6 min runtime → below 25%
    expect(find(detect(s, [], []), 'power_on_ups')?.severity).toBe('critical');
  });

  it('fan_vibration_anomaly on a real-fan reading ≥ 0.5, suppressed by openSymptoms', () => {
    const s0 = run(def(), 1);
    const s = setFanReading(s0, 'rack_3', 0.9, s0.tick);
    expect(find(detect(s, [], []), 'fan_vibration_anomaly')).toEqual({
      symptom: 'fan_vibration_anomaly', component_ids: ['rack_3'], severity: 'high',
    });
    expect(find(detect(s, [], ['fan_vibration_anomaly']), 'fan_vibration_anomaly')).toBeUndefined();
    expect(find(detect(setFanReading(s0, 'rack_3', 0.4, s0.tick), [], []), 'fan_vibration_anomaly')).toBeUndefined();
  });

  it('fan_offline only after the first bridge reading, then a timeout', () => {
    expect(find(detect(run(def(), 20), [], []), 'fan_offline')).toBeUndefined();
    const s0 = run(def(), 1);
    let s = setFanReading(s0, 'rack_3', 0.1, s0.tick);
    s = run(s, 7);
    expect(find(detect(s, [], []), 'fan_offline')).toEqual({
      symptom: 'fan_offline', component_ids: ['rack_3'], severity: 'low',
    });
    expect(find(detect(s, [], ['fan_offline']), 'fan_offline')).toBeUndefined();
  });

  it('only emits SYMPTOMS values (never operator_question) and at most one draft per symptom', () => {
    let s = applyFailure(def(), fail('pump_fail', 'pump_A', {}, 1));
    s = applyFailure(s, fail('pump_fail', 'pump_B', {}, 2));
    s = applyFailure(s, fail('utility_loss', 'util_1', {}, 3));
    s = run(s, 200);
    const ds = detect(s, [], []);
    expect(ds.length).toBeGreaterThan(0);
    for (const sym of syms(ds)) expect(SYMPTOMS as readonly string[]).toContain(sym);
    expect(new Set(syms(ds)).size).toBe(ds.length);
    expect(detect(s, [], [...SYMPTOMS])).toEqual([]);
  });
});
