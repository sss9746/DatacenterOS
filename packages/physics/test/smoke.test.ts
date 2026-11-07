import { describe, expect, it } from 'vitest';
import * as physics from '../src/index.js';

const FUNCTION_EXPORTS = [
  'defaultDemoConfig',
  'compileTopology',
  'step',
  'applyAction',
  'applyFailure',
  'setFanReading',
  'simulate',
  'checkAction',
  'detect',
  'makeRng',
  'computeBalance',
  'facilityStatus',
] as const;

const CONSTANT_EXPORTS = [
  'COMPONENT_KINDS', 'STATUSES', 'FAILURE_KINDS', 'ACTION_KINDS', 'ACTION_STATUSES', 'SYMPTOMS', 'SEVERITIES',
  'INCIDENT_STATUSES', 'AGENT_NAMES', 'STEP_KINDS', 'FAULT_CLASSES', 'ROLES', 'METRIC_KEYS',
  'T_AMBIENT_C', 'T_WARNING_C', 'T_DEGRADED_C', 'T_SHUTDOWN_C', 'PASSIVE_K_PER_S', 'DEFAULT_THERMAL_MASS_KJ_PER_C',
  'SAFETY_HORIZON_TICKS', 'TECH_REPAIR_TICKS', 'HISTORY_PER_COMPONENT', 'FAN_ONLINE_TIMEOUT_TICKS', 'REAL_FAN_RACK_ID',
] as const;

const api = physics as unknown as Record<string, unknown>;

describe('smoke: public API surface', () => {
  it('exports every frozen function', () => {
    for (const name of FUNCTION_EXPORTS) {
      expect(typeof api[name], name).toBe('function');
    }
  });

  it('exports every constant and PRESET_CONFIGS', () => {
    for (const name of CONSTANT_EXPORTS) {
      expect(api[name], name).toBeDefined();
    }
    expect(typeof physics.PRESET_CONFIGS).toBe('object');
  });

  it('pins key constant values from CONTRACTS §1', () => {
    expect(physics.PASSIVE_K_PER_S).toBe(0.0005);
    expect(physics.REAL_FAN_RACK_ID).toBe('rack_3');
    expect(physics.METRIC_KEYS).toHaveLength(7);
  });
});

describe('smoke: makeRng', () => {
  it('is deterministic and in [0,1)', () => {
    const a = physics.makeRng(1);
    const b = physics.makeRng(1);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('differs across seeds and handles negative / huge seeds', () => {
    expect(physics.makeRng(1)()).not.toBe(physics.makeRng(2)());
    for (const seed of [-1, -123456789, 2 ** 53, 42 * 1_000_003 + 600]) {
      const v = physics.makeRng(seed)();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
