import { describe, expect, it } from 'vitest';
import { applyAction, TECH_REPAIR_TICKS } from '../src/index.js';
import type { Action } from '../src/index.js';
import { defaultState, failPump, run } from './helpers.js';

const act = (kind: Action['kind'], target_id: string, params: Action['params'] = {}): Action => ({ kind, target_id, params });

describe('applyAction', () => {
  it('shutdown_component / restore_component', () => {
    const off = applyAction(defaultState(), act('shutdown_component', 'pump_A'));
    expect(off.components['pump_A']!.true_status).toBe('shutdown');
    expect(off.components['pump_A']!.observed_status).toBe('shutdown');
    const on = applyAction(off, act('restore_component', 'pump_A'));
    expect(on.components['pump_A']!.true_status).toBe('online');
  });

  it('restore_component on a pump_fail target → INVALID (dispatch_tech required)', () => {
    expect(() => applyAction(failPump(defaultState(), 'pump_B'), act('restore_component', 'pump_B'))).toThrow(
      'INVALID: pump_B has an active fault; dispatch_tech required',
    );
  });

  it('shed_load with and without kw', () => {
    expect(applyAction(defaultState(), act('shed_load', 'rack_8', { kw: 2 })).components['rack_8']!.load_kw).toBe(4);
    expect(applyAction(defaultState(), act('shed_load', 'rack_8', { kw: 99 })).components['rack_8']!.load_kw).toBe(0);
    expect(applyAction(defaultState(), act('shed_load', 'rack_8')).components['rack_8']!.load_kw).toBe(0);
  });

  it('migrate_load moves min(kw, load)', () => {
    const s = applyAction(defaultState(), act('migrate_load', 'rack_3', { kw: 3, to: 'rack_1' }));
    expect(s.components['rack_3']!.load_kw).toBe(3);
    expect(s.components['rack_1']!.load_kw).toBe(9);
    const all = applyAction(defaultState(), act('migrate_load', 'rack_3', { kw: 50, to: 'rack_1' }));
    expect(all.components['rack_3']!.load_kw).toBe(0);
    expect(all.components['rack_1']!.load_kw).toBe(12);
  });

  it('migrate_load to a missing, non-rack or shut-down rack → INVALID: migrate target', () => {
    expect(() => applyAction(defaultState(), act('migrate_load', 'rack_3', { kw: 3, to: 'rack_99' }))).toThrow('INVALID: migrate target');
    expect(() => applyAction(defaultState(), act('migrate_load', 'rack_3', { kw: 3, to: 'pump_A' }))).toThrow('INVALID: migrate target');
    expect(() => applyAction(defaultState(), act('migrate_load', 'rack_3', { kw: 3 }))).toThrow('INVALID: migrate target');
    const shut = applyAction(defaultState(), act('shutdown_component', 'rack_1'));
    expect(() => applyAction(shut, act('migrate_load', 'rack_3', { kw: 3, to: 'rack_1' }))).toThrow('INVALID: migrate target');
  });

  it('set_load requires kw >= 0', () => {
    expect(applyAction(defaultState(), act('set_load', 'rack_2', { kw: 12 })).components['rack_2']!.load_kw).toBe(12);
    expect(() => applyAction(defaultState(), act('set_load', 'rack_2'))).toThrow('INVALID');
    expect(() => applyAction(defaultState(), act('set_load', 'rack_2', { kw: -1 }))).toThrow('INVALID');
  });

  it('unknown target → NOT_FOUND', () => {
    expect(() => applyAction(defaultState(), act('shutdown_component', 'pump_Z'))).toThrow('NOT_FOUND: component pump_Z');
  });

  it('dispatch_tech pump_B after pump_fail: online at tick + 60 and the failure is inactive', () => {
    let s = run(failPump(defaultState(), 'pump_B'), 10);
    s = applyAction(s, act('dispatch_tech', 'pump_B'));
    const eta = s.tick + TECH_REPAIR_TICKS;
    expect(s.components['pump_B']!.repair_eta_tick).toBe(eta);
    const before = run(s, TECH_REPAIR_TICKS - 1);
    expect(before.components['pump_B']!.true_status).toBe('offline');
    const after = run(before, 1);
    expect(after.tick).toBe(eta);
    expect(after.components['pump_B']!.true_status).toBe('online');
    expect(after.components['pump_B']!.repair_eta_tick).toBe(0);
    expect(after.failures.every((f) => !f.active)).toBe(true);
    expect(after.components['pump_B']!.cooling_kw).toBe(50);
  });
});
