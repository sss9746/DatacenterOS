import { describe, expect, it } from 'vitest';
import { compileTopology, defaultDemoConfig } from '../src/compile.js';
import type { FacilityConfig } from '../src/types.js';


function withCfg(patch: (c: FacilityConfig) => FacilityConfig): FacilityConfig {
  return patch(defaultDemoConfig());
}

function pumps(count: number, capacity_kw: number, cooling: 'N' | 'N+1'): FacilityConfig {
  const c = defaultDemoConfig();
  return { ...c, components: { ...c.components, pump: { count, capacity_kw } }, redundancy: { cooling } };
}

function deepFreeze<T>(o: T): T {
  if (typeof o === 'object' && o !== null) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

describe('compileTopology(defaultDemoConfig())', () => {
  const { state, warnings } = compileTopology(defaultDemoConfig());

  it('has 12 components and 27 edges', () => {
    expect(Object.keys(state.components)).toHaveLength(12);
    expect(state.edges).toHaveLength(27);
    expect(state.edges.filter((e) => e.kind === 'cooling')).toHaveLength(16);
  });

  it('uses the CONTRACTS §1 ID formats', () => {
    expect(Object.keys(state.components).sort()).toEqual(
      ['pump_A', 'pump_B', 'rack_1', 'rack_2', 'rack_3', 'rack_4', 'rack_5', 'rack_6', 'rack_7', 'rack_8', 'ups_1', 'util_1'].sort(),
    );
    expect(state.components.pump_A.label).toBe('Pump A');
    expect(state.components.util_1.label).toBe('Utility 1');
    expect(state.components.ups_1.label).toBe('UPS 1');
  });

  it('marks only rack_3 as real hardware', () => {
    const real = Object.values(state.components).filter((c) => c.is_real_hardware).map((c) => c.id);
    expect(real).toEqual(['rack_3']);
    expect(state.components.rack_3.label).toBe('Rack 3 (real fan)');
  });

  it('initializes the default facility values', () => {
    expect(state.components.util_1.params).toEqual({ capacity_kw: 200 });
    expect(state.components.ups_1.params).toEqual({ energy_kwh: 20, max_output_kw: 120 });
    expect(state.components.ups_1.ups_energy_kwh).toBe(20);
    expect(state.components.pump_B.params).toEqual({ capacity_kw: 50 });
    expect(state.components.rack_5.params).toEqual({ base_load_kw: 6, thermal_mass_kj_per_c: 60 });
    expect(state.components.rack_5.load_kw).toBe(6);
    for (const c of Object.values(state.components)) {
      expect(c.true_temp_c).toBe(22);
      expect(c.observed_temp_c).toBe(22);
      expect(c.true_status).toBe('online');
      expect(c.fan_fault_class).toBe('');
      expect(c.fan_rms).toBe(0);
    }
    expect(state.tick).toBe(0);
    expect(state.sim_time_s).toBe(0);
    expect(state.failures).toEqual([]);
    expect(state.seed).toBe(42);
  });

  it('lays out deterministically', () => {
    expect([state.components.util_1.x, state.components.ups_1.x, state.components.pump_B.x]).toEqual([0, 220, 440]);
    expect(state.components.pump_B.y).toBe(130);
    expect([state.components.rack_1.x, state.components.rack_1.y]).toEqual([700, 0]);
    expect([state.components.rack_4.x, state.components.rack_4.y]).toEqual([1210, 0]);
    expect([state.components.rack_5.x, state.components.rack_5.y]).toEqual([700, 130]);
  });

  it('emits the N+1-met, power and UPS warnings', () => {
    expect(warnings).toEqual([
      'Requested N+1 cooling: 2×50 kW = 100 kW, minus the largest pump = 50 kW ≥ 48 kW IT load ✔',
      'Utility 200 kW ≥ demand 53 kW ✔',
      'UPS runtime at full load ≈ 22.6 min',
    ]);
  });

  it('is deterministic and JSON-safe', () => {
    const a = JSON.stringify(compileTopology(defaultDemoConfig()));
    const b = JSON.stringify(compileTopology(deepFreeze(defaultDemoConfig())));
    expect(a).toBe(b);
    expect(JSON.parse(a).state.components.rack_3.is_real_hardware).toBe(true);
  });
});

describe('compileTopology warnings (verbatim)', () => {
  it('N+1 met with 3×30 kW', () => {
    expect(compileTopology(pumps(3, 30, 'N+1')).warnings[0]).toBe(
      'Requested N+1 cooling: 3×30 kW = 90 kW, minus the largest pump = 60 kW ≥ 48 kW IT load ✔',
    );
  });
  it('N+1 not met with 2×30 kW', () => {
    expect(compileTopology(pumps(2, 30, 'N+1')).warnings[0]).toBe(
      'N+1 NOT met: 2×30 kW minus 30 = 30 kW < 48 kW. Suggest pump capacity ≥ 48 kW.',
    );
  });
  it('N+1 with a single pump suggests a second pump', () => {
    expect(compileTopology(pumps(1, 50, 'N+1')).warnings[0]).toBe(
      'N+1 NOT met: 1×50 kW minus 50 = 0 kW < 48 kW. Suggest: add a second pump.',
    );
  });
  it('N OK and N not sufficient', () => {
    expect(compileTopology(pumps(2, 50, 'N')).warnings[0]).toBe('Cooling OK: 2×50 kW = 100 kW ≥ 48 kW IT load ✔');
    expect(compileTopology(pumps(1, 30, 'N')).warnings[0]).toMatch(/^Cooling NOT sufficient: 1×30 kW = 30 kW < 48 kW IT load/);
  });
  it('no UPS and weak utility', () => {
    const cfg = withCfg((c) => ({
      ...c,
      components: { ...c.components, utility: { count: 1, capacity_kw: 40 }, ups: { count: 0, energy_kwh: 0, max_output_kw: 0 } },
    }));
    const { state, warnings } = compileTopology(cfg);
    expect(warnings).toContain('Utility 40 kW NOT sufficient: demand 53 kW');
    expect(warnings).toContain('No UPS: a utility loss shuts every rack down immediately');
    // util → 8 racks + 2 pumps, plus 16 cooling edges
    expect(state.edges).toHaveLength(26);
  });
  it('out-of-range real fan rack → warning and no real rack', () => {
    const cfg = withCfg((c) => ({ ...c, components: { ...c.components, rack: { count: 2, load_kw: 6, real_fan_rack: 3 } } }));
    const { state, warnings } = compileTopology(cfg);
    expect(Object.values(state.components).some((c) => c.is_real_hardware)).toBe(false);
    expect(warnings.some((w) => w.startsWith('Real fan rack 3 is out of range'))).toBe(true);
  });
});

describe('compileTopology validation', () => {
  const bad: Array<[string, FacilityConfig]> = [
    ['25 racks', withCfg((c) => ({ ...c, components: { ...c.components, rack: { ...c.components.rack, count: 25 } } }))],
    ['0 pumps', withCfg((c) => ({ ...c, components: { ...c.components, pump: { count: 0, capacity_kw: 50 } } }))],
    ['7 pumps', withCfg((c) => ({ ...c, components: { ...c.components, pump: { count: 7, capacity_kw: 50 } } }))],
    ['4 utilities', withCfg((c) => ({ ...c, components: { ...c.components, utility: { count: 4, capacity_kw: 50 } } }))],
    ['NaN load', withCfg((c) => ({ ...c, components: { ...c.components, rack: { ...c.components.rack, load_kw: NaN } } }))],
    ['negative capacity', withCfg((c) => ({ ...c, components: { ...c.components, pump: { count: 2, capacity_kw: -1 } } }))],
    ['zero ups energy with a UPS', withCfg((c) => ({ ...c, components: { ...c.components, ups: { count: 1, energy_kwh: 0, max_output_kw: 10 } } }))],
    ['bad redundancy', withCfg((c) => ({ ...c, redundancy: { cooling: 'N+2' as 'N' } }))],
  ];
  for (const [name, cfg] of bad) {
    it(`throws INVALID for ${name}`, () => {
      expect(() => compileTopology(cfg)).toThrow(/^INVALID: /);
    });
  }
});

describe('PRESET_CONFIGS', () => {
  it('every preset compiles', async () => {
    const { PRESET_CONFIGS } = await import('../src/presets.js');
    expect(Object.keys(PRESET_CONFIGS).sort()).toEqual(['ai_hall_3pump', 'edge_small', 'enterprise_2pump']);
    for (const cfg of Object.values(PRESET_CONFIGS)) {
      expect(compileTopology(cfg).warnings.length).toBeGreaterThan(0);
    }
    expect(PRESET_CONFIGS.enterprise_2pump.name).toBe('Enterprise DC-1');
  });

  it('ai_hall_3pump yields the ✔ N+1 warning; dropping to 2 pumps yields NOT met', async () => {
    const { PRESET_CONFIGS } = await import('../src/presets.js');
    const ai = PRESET_CONFIGS.ai_hall_3pump;
    expect(compileTopology(ai).warnings[0]).toBe(
      'Requested N+1 cooling: 3×30 kW = 90 kW, minus the largest pump = 60 kW ≥ 48 kW IT load ✔',
    );
    const two = { ...ai, components: { ...ai.components, pump: { count: 2, capacity_kw: 30 } } };
    expect(compileTopology(two).warnings[0]).toBe('N+1 NOT met: 2×30 kW minus 30 = 30 kW < 48 kW. Suggest pump capacity ≥ 48 kW.');
  });
});
