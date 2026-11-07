import { describe, expect, it } from 'vitest';
import { applyAction, computeBalance, setFanReading, step } from '../src/index.js';
import type { FacilityState } from '../src/index.js';
import { RACKS, deepFreeze, defaultState, fail, failPump, fanEvery, rng, run, ticksUntil } from './helpers.js';

const rackTemps = (s: FacilityState) => RACKS.map((id) => s.components[id]!.true_temp_c);
const bothPumpsDown = () => failPump(failPump(defaultState(), 'pump_A'), 'pump_B');

describe('step: §3.3 expected numbers', () => {
  it('healthy: every rack stays at 22.0 ± 0.1 for 600 ticks; margin +52', () => {
    let s = defaultState();
    for (let i = 0; i < 600; i++) {
      s = step(s, 1, rng);
      for (const t of rackTemps(s)) expect(Math.abs(t - 22)).toBeLessThanOrEqual(0.1);
    }
    expect(s.tick).toBe(600);
    expect(s.sim_time_s).toBe(600);
    expect(computeBalance(s, 'true').margin_kw).toBe(52);
    expect(s.components['pump_A']!.cooling_kw).toBe(50);
    expect(s.components['pump_A']!.load_kw).toBeCloseTo(2.5, 9);
    expect(s.components['rack_1']!.cooling_kw).toBeCloseTo(6, 9);
  });

  it('pump_B failed: margin +2 and every rack < 23 °C for 600 ticks', () => {
    let s = failPump(defaultState(), 'pump_B');
    expect(computeBalance(s, 'true').margin_kw).toBeCloseTo(2, 9);
    for (let i = 0; i < 600; i++) {
      s = step(s, 1, rng);
      for (const t of rackTemps(s)) expect(t).toBeLessThan(23);
    }
    expect(s.components['pump_B']!.cooling_kw).toBe(0);
  });

  it('both pumps down: ~0.1 °C/s, degraded ≤ 260 s, shutdown ≤ 380 s', () => {
    const s0 = bothPumpsDown();
    const s1 = step(s0, 1, rng);
    expect(s1.components['rack_1']!.true_temp_c - 22).toBeCloseTo(0.1, 3);
    const degraded = ticksUntil(s0, 600, (s) => s.components['rack_1']!.true_status === 'degraded');
    const shutdown = ticksUntil(s0, 600, (s) => RACKS.every((id) => s.components[id]!.true_status === 'shutdown'));
    console.log(`[measured] both pumps down: degraded at ${degraded} s, all 8 racks shut down at ${shutdown} s`);
    expect(degraded).toBeGreaterThan(200);
    expect(degraded).toBeLessThanOrEqual(260);
    expect(shutdown).toBeGreaterThan(300);
    expect(shutdown).toBeLessThanOrEqual(380);
    // degraded keeps full load (S-D1) and shutdown latches with load 0
    const end = run(s0, 450);
    for (const id of RACKS) {
      expect(end.components[id]!.true_status).toBe('shutdown');
      expect(end.components[id]!.observed_status).toBe('shutdown');
      expect(end.components[id]!.load_kw).toBe(6); // design load is kept so restore resumes it
    }
    expect(computeBalance(end, 'true').load_kw).toBe(0);
  });

  it('real fan anomaly 0.9: only rack_3 heats (~0.07 °C/s) and passes 35 °C in 150–220 s', () => {
    const s0 = defaultState();
    const each = fanEvery(0.9);
    const one = step(each(s0), 1, rng);
    expect(one.components['rack_3']!.fan_health).toBeCloseTo(0.3, 9);
    expect(one.components['rack_3']!.cooling_kw).toBeCloseTo(1.8, 9);
    expect(one.components['rack_3']!.true_temp_c - 22).toBeCloseTo(0.07, 3);
    const t35 = ticksUntil(s0, 600, (s) => s.components['rack_3']!.true_temp_c >= 35, each);
    console.log(`[measured] fan anomaly 0.9: rack_3 reaches 35 °C at ${t35} s`);
    expect(t35).toBeGreaterThanOrEqual(150);
    expect(t35).toBeLessThanOrEqual(220);
    const s = run(s0, t35, each);
    for (const id of RACKS.filter((r) => r !== 'rack_3')) expect(s.components[id]!.true_temp_c).toBeCloseTo(22, 1);
  });

  it('fan fault then migrate_load rack_3 → rack_1 3 kW: rack_3 back below 35, rack_1 stays < 30', () => {
    const each = fanEvery(0.9);
    let s = run(defaultState(), 200, each);
    expect(s.components['rack_3']!.true_temp_c).toBeGreaterThan(35);
    s = applyAction(s, { kind: 'migrate_load', target_id: 'rack_3', params: { kw: 3, to: 'rack_1' } });
    let r1Max = 0;
    for (let i = 0; i < 600; i++) {
      s = step(each(s), 1, rng);
      r1Max = Math.max(r1Max, s.components['rack_1']!.true_temp_c);
    }
    expect(s.components['rack_3']!.true_temp_c).toBeLessThan(35);
    expect(r1Max).toBeLessThan(30);
  });

  it('fan timeout: no reading for > 5 ticks → fan_online false, health 1, anomaly kept', () => {
    let s = setFanReading(defaultState(), 'rack_3', 0.9, 1, 'imbalance', 0.7);
    s = run(s, 6); // tick 6: 6 − 1 = 5, not yet
    expect(s.components['rack_3']!.fan_online).toBe(true);
    s = run(s, 1);
    const c = s.components['rack_3']!;
    expect(c.fan_online).toBe(false);
    expect(c.fan_health).toBe(1);
    expect(c.fan_anomaly).toBe(0.9);
    expect(c.fan_fault_class).toBe('imbalance');
    // never-seen fan (last_seen 0) never times out
    expect(run(defaultState(), 20).components['rack_3']!.fan_online).toBe(true);
  });

  it('sensor_freeze rack_5 (both pumps down): observed fixed, age +1/tick, true temp rises', () => {
    let s = fail(bothPumpsDown(), 'sensor_freeze', 'rack_5');
    const observed0 = s.components['rack_5']!.observed_temp_c;
    for (let i = 1; i <= 120; i++) {
      s = step(s, 1, rng);
      const c = s.components['rack_5']!;
      expect(c.observed_temp_c).toBe(observed0);
      expect(c.sensor_age_s).toBe(i);
      expect(s.components['rack_4']!.sensor_age_s).toBe(0);
      expect(s.components['rack_4']!.observed_temp_c).toBe(s.components['rack_4']!.true_temp_c);
    }
    expect(s.components['rack_5']!.true_temp_c).toBeGreaterThan(32);
    expect(s.components['rack_5']!.sensor_frozen).toBe(true);
  });

  it('load_spike rack_7 {extra_kw: 4} with pump_B failed: margin −2 and rack_7 heats', () => {
    let s = fail(failPump(defaultState(), 'pump_B'), 'load_spike', 'rack_7', { extra_kw: 4 });
    s = run(s, 60);
    expect(computeBalance(s, 'true').margin_kw).toBeCloseTo(-2, 9);
    expect(s.components['rack_7']!.true_temp_c).toBeGreaterThan(24);
    expect(s.components['rack_1']!.true_temp_c).toBeLessThan(23);
  });

  it('utility_loss: UPS drains ~53 kW, lasts ≈ 22.6 min, then all 8 racks shut down', () => {
    const s0 = fail(defaultState(), 'utility_loss', 'util_1');
    const s1 = step(s0, 1, rng);
    expect(s1.components['ups_1']!.load_kw).toBeCloseTo(53, 9);
    expect(20 - s1.components['ups_1']!.ups_energy_kwh).toBeCloseTo(53 / 3600, 9);
    const empty = ticksUntil(s0, 3000, (s) => s.components['ups_1']!.ups_energy_kwh <= 0);
    const down = ticksUntil(s0, 3000, (s) => RACKS.every((id) => s.components[id]!.true_status === 'shutdown'));
    console.log(`[measured] utility_loss: UPS empty at ${empty} s (${(empty / 60).toFixed(2)} min), all racks shut down at ${down} s`);
    expect(empty / 60).toBeCloseTo(22.6, 0);
    expect(down).toBe(empty + 1);
    const before = run(s0, empty);
    for (const id of RACKS) expect(before.components[id]!.true_status).toBe('online');
    for (const t of rackTemps(before)) expect(t).toBeLessThan(23);
    const after = run(before, 5);
    for (const id of RACKS) expect(after.components[id]!.true_status).toBe('shutdown');
    expect(after.components['pump_A']!.cooling_kw).toBe(0);
  });

  it('a degraded rack recovers to online below 40 °C once cooling returns', () => {
    let s = run(bothPumpsDown(), 280);
    expect(s.components['rack_1']!.true_status).toBe('degraded');
    for (const p of ['pump_A', 'pump_B']) s = applyAction(s, { kind: 'dispatch_tech', target_id: p, params: {} });
    s = run(s, 600);
    expect(s.components['rack_1']!.true_status).toBe('online');
    expect(s.components['rack_1']!.true_temp_c).toBeLessThan(25);
  });
});

describe('step: purity, determinism, JSON safety, perf', () => {
  it('runs on a deep-frozen input and never mutates it', () => {
    const frozen = deepFreeze(fail(fail(bothPumpsDown(), 'sensor_freeze', 'rack_5'), 'load_spike', 'rack_7', { extra_kw: 4 }));
    const snapshot = JSON.stringify(frozen);
    const next = step(frozen, 1, rng);
    expect(next).not.toBe(frozen);
    expect(JSON.stringify(frozen)).toBe(snapshot);
    const fanned = setFanReading(frozen, 'rack_3', 0.9, 1);
    expect(fanned.components['rack_3']!.fan_health).toBeCloseTo(0.3, 9);
    applyAction(frozen, { kind: 'migrate_load', target_id: 'rack_3', params: { kw: 3, to: 'rack_1' } });
    applyAction(frozen, { kind: 'dispatch_tech', target_id: 'pump_B', params: {} });
    fail(frozen, 'utility_loss', 'util_1');
    expect(JSON.stringify(frozen)).toBe(snapshot);
  });

  it('same input → byte-identical JSON after 600 steps; no NaN/Infinity', () => {
    const scenario = () => fail(fail(failPump(defaultState(), 'pump_B'), 'load_spike', 'rack_7', { extra_kw: 4 }), 'utility_loss', 'util_1');
    const a = JSON.stringify(run(scenario(), 600, fanEvery(0.8)));
    const b = JSON.stringify(run(scenario(), 600, fanEvery(0.8)));
    expect(a).toBe(b);
    expect(a).not.toMatch(/null|NaN|Infinity/);
  });

  it('step perf (12 components)', () => {
    let s = defaultState();
    for (let i = 0; i < 200; i++) s = step(s, 1, rng); // warm-up
    const N = 5000;
    let t = bothPumpsDown();
    const t0 = performance.now();
    for (let i = 0; i < N; i++) t = step(t, 1, rng);
    const per = (performance.now() - t0) / N;
    console.log(`[measured] step: ${(per * 1000).toFixed(1)} µs/step`);
    expect(per).toBeLessThan(100);
  });

  it('rejects a bad dtSec', () => {
    expect(() => step(defaultState(), Number.NaN, rng)).toThrow('INVALID');
    expect(() => step(defaultState(), -1, rng)).toThrow('INVALID');
  });
});
