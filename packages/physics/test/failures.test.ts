import { describe, expect, it } from 'vitest';
import { applyFailure, setFanReading } from '../src/v0/index.js';
import { defaultState, fail } from './helpers.js';

describe('applyFailure', () => {
  it('pump_fail / utility_loss set the target offline and record the failure', () => {
    const s = fail(fail(defaultState(), 'pump_fail', 'pump_B'), 'utility_loss', 'util_1');
    expect(s.components['pump_B']!.true_status).toBe('offline');
    expect(s.components['pump_B']!.observed_status).toBe('offline');
    expect(s.components['util_1']!.true_status).toBe('offline');
    expect(s.failures).toHaveLength(2);
  });

  it('sensor_freeze sets sensor_frozen; load_spike and ticket_lie change nothing physical', () => {
    const base = defaultState();
    expect(fail(base, 'sensor_freeze', 'rack_5').components['rack_5']!.sensor_frozen).toBe(true);
    const spike = fail(base, 'load_spike', 'rack_7', { extra_kw: 4 });
    expect(spike.components).toEqual(base.components);
    const lie = fail(base, 'ticket_lie', 'pump_B');
    expect(lie.components).toEqual(base.components);
    expect(lie.failures[0]!.kind).toBe('ticket_lie');
  });

  it('wrong target kind → INVALID, unknown id → NOT_FOUND', () => {
    const s = defaultState();
    const f = (kind: 'pump_fail' | 'utility_loss' | 'sensor_freeze' | 'load_spike', target: string) =>
      applyFailure(s, { id: 1, kind, target_id: target, params: {}, start_tick: 0, active: true });
    expect(() => f('pump_fail', 'rack_1')).toThrow('INVALID: pump_fail needs a pump target');
    expect(() => f('utility_loss', 'pump_A')).toThrow('INVALID: utility_loss needs a utility target');
    expect(() => f('sensor_freeze', 'pump_A')).toThrow('INVALID: sensor_freeze needs a rack target');
    expect(() => f('load_spike', 'util_1')).toThrow('INVALID: load_spike needs a rack target');
    expect(() => f('pump_fail', 'pump_Z')).toThrow('NOT_FOUND: component pump_Z');
  });
});

describe('setFanReading', () => {
  it('maps anomaly to fan_health (0.9 → 0.3, 0.6 → 0.65, 0.3 → 1.0) and clamps', () => {
    const h = (a: number) => setFanReading(defaultState(), 'rack_3', a, 1).components['rack_3']!.fan_health;
    expect(h(0.9)).toBeCloseTo(0.3, 9);
    expect(h(0.6)).toBeCloseTo(0.65, 9);
    expect(h(0.3)).toBeCloseTo(1.0, 9);
    expect(h(5)).toBeCloseTo(0.3, 9);
    const c = setFanReading(defaultState(), 'rack_3', -1, 7, 'replay:imbalance', 0.42).components['rack_3']!;
    expect(c.fan_anomaly).toBe(0);
    expect(c.fan_fault_class).toBe('replay:imbalance');
    expect(c.fan_rms).toBe(0.42);
    expect(c.fan_online).toBe(true);
    expect(c.fan_last_seen_tick).toBe(7);
  });

  it('defaults faultClass to "" and rms to 0', () => {
    const c = setFanReading(defaultState(), 'rack_3', 0.5, 3).components['rack_3']!;
    expect(c.fan_fault_class).toBe('');
    expect(c.fan_rms).toBe(0);
  });

  it('a rack without the real fan → INVALID; unknown → NOT_FOUND', () => {
    expect(() => setFanReading(defaultState(), 'rack_1', 0.9, 1)).toThrow('INVALID: rack_1 is not the real-fan rack');
    expect(() => setFanReading(defaultState(), 'rack_99', 0.9, 1)).toThrow('NOT_FOUND');
  });
});
