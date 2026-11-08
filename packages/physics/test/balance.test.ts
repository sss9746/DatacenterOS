import { describe, expect, it } from 'vitest';
import { applyAction, computeBalance, facilityStatus } from '../src/v0/index.js';
import { defaultState, fail, failPump, run } from './helpers.js';

describe('computeBalance', () => {
  it('default facility: margin +52, powered from utility, demand 48 + 5', () => {
    const b = computeBalance(defaultState(), 'true');
    expect(b).toEqual({ supply_kw: 200, demand_kw: 53, powered: true, cooling_kw: 100, load_kw: 48, margin_kw: 52 });
    expect(computeBalance(defaultState(), 'observed')).toEqual(b);
  });

  it('pump_B failed: margin +2', () => {
    expect(computeBalance(failPump(defaultState(), 'pump_B'), 'true').margin_kw).toBeCloseTo(2, 6);
  });

  it('both pumps failed: cooling 0, margin −48', () => {
    const b = computeBalance(failPump(failPump(defaultState(), 'pump_A'), 'pump_B'), 'true');
    expect(b.cooling_kw).toBe(0);
    expect(b.margin_kw).toBe(-48);
  });

  it('load_spike rack_7 (+4) with pump_B failed: margin −2 in both views', () => {
    const s = fail(failPump(defaultState(), 'pump_B'), 'load_spike', 'rack_7', { extra_kw: 4, tenant: 'Vision team · training job' });
    expect(computeBalance(s, 'true').margin_kw).toBeCloseTo(-2, 6);
    expect(computeBalance(s, 'observed').margin_kw).toBeCloseTo(-2, 6);
  });

  it('utility_loss: powered by UPS while energy > 0, unpowered at 0', () => {
    const s = fail(defaultState(), 'utility_loss', 'util_1');
    const b = computeBalance(s, 'true');
    expect(b.supply_kw).toBe(0);
    expect(b.powered).toBe(true);
    const empty = { ...s, components: { ...s.components, ups_1: { ...s.components['ups_1']!, ups_energy_kwh: 0 } } };
    const e = computeBalance(empty, 'true');
    expect(e.powered).toBe(false);
    expect(e.cooling_kw).toBe(0);
  });

  it('a shut-down rack carries no load', () => {
    const s = applyAction(defaultState(), { kind: 'shutdown_component', target_id: 'rack_8', params: {} });
    expect(computeBalance(s, 'true').load_kw).toBe(42);
  });
});

describe('facilityStatus', () => {
  it('normal / degraded / critical', () => {
    expect(facilityStatus(defaultState())).toBe('normal');
    const spike = fail(failPump(defaultState(), 'pump_B'), 'load_spike', 'rack_7', { extra_kw: 4 });
    expect(facilityStatus(spike)).toBe('degraded'); // margin −2
    const none = failPump(failPump(defaultState(), 'pump_A'), 'pump_B');
    expect(facilityStatus(none)).toBe('critical'); // margin −48
    const shut = applyAction(defaultState(), { kind: 'shutdown_component', target_id: 'rack_1', params: {} });
    expect(facilityStatus(shut)).toBe('critical');
  });

  it('a rack at the 35 °C warning makes the facility degraded', () => {
    const none = failPump(failPump(defaultState(), 'pump_A'), 'pump_B');
    const s = run(none, 140); // ~0.1 °C/s → ~35.6 °C, margin −48 still → critical; check warning on a healthy margin instead
    const restored = { ...s, failures: [], components: { ...s.components } };
    for (const p of ['pump_A', 'pump_B']) {
      restored.components[p] = { ...s.components[p]!, true_status: 'online', observed_status: 'online' };
    }
    expect(s.components['rack_1']!.observed_temp_c).toBeGreaterThanOrEqual(35);
    expect(facilityStatus(restored)).toBe('degraded');
  });
});
