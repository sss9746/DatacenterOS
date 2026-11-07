// Topology compiler (LANE-S §5.4 S-3 step 1). Owned by S-3.
import { DEFAULT_THERMAL_MASS_KJ_PER_C, T_AMBIENT_C } from './constants.js';
import type { ComponentKind, ComponentState, Edge, FacilityConfig, FacilityState } from './types.js';
import { layoutPosition } from './internal/layout.js';

/** Mirrors internal/params.ts PUMP_DRAW_FRAC (S-2); kept local so compile has no dependency on S-2's files. */
const PUMP_DRAW_FRAC = 0.05;
const TEMPLATES = ['enterprise', 'ai_compute', 'edge'] as const;
const PUMP_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const LIMITS = {
  utility: { min: 1, max: 3 },
  ups: { min: 0, max: 3 },
  pump: { min: 1, max: 6 },
  rack: { min: 1, max: 24 },
} as const;

const fmt = (x: number): string => String(Math.round(x * 10) / 10);

export function defaultDemoConfig(): FacilityConfig {
  return {
    name: 'DC-1 Demo Hall',
    template: 'enterprise',
    seed: 42,
    components: {
      utility: { count: 1, capacity_kw: 200 },
      ups: { count: 1, energy_kwh: 20, max_output_kw: 120 },
      pump: { count: 2, capacity_kw: 50 },
      rack: { count: 8, load_kw: 6, real_fan_rack: 3 },
    },
    redundancy: { cooling: 'N+1' },
  };
}

function invalid(msg: string): never {
  throw new Error(`INVALID: ${msg}`);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function checkCount(field: string, v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    invalid(`${field} must be an integer in ${min}..${max}`);
  }
  return v;
}

function checkPositive(field: string, v: unknown, allowZero: boolean): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (!allowZero && v === 0)) {
    invalid(`${field} must be a finite number ${allowZero ? '≥ 0' : '> 0'}`);
  }
  return v;
}

function validate(cfg: FacilityConfig): void {
  if (!isObj(cfg)) invalid('config must be an object');
  if (typeof cfg.name !== 'string') invalid('name must be a string');
  if (!(TEMPLATES as readonly string[]).includes(cfg.template)) invalid(`template must be one of ${TEMPLATES.join('|')}`);
  if (typeof cfg.seed !== 'number' || !Number.isFinite(cfg.seed)) invalid('seed must be a finite number');
  const c = cfg.components;
  if (!isObj(c) || !isObj(c.utility) || !isObj(c.ups) || !isObj(c.pump) || !isObj(c.rack)) {
    invalid('components must contain utility, ups, pump and rack');
  }
  checkCount('components.utility.count', c.utility.count, LIMITS.utility.min, LIMITS.utility.max);
  checkPositive('components.utility.capacity_kw', c.utility.capacity_kw, false);
  const upsCount = checkCount('components.ups.count', c.ups.count, LIMITS.ups.min, LIMITS.ups.max);
  checkPositive('components.ups.energy_kwh', c.ups.energy_kwh, upsCount === 0);
  checkPositive('components.ups.max_output_kw', c.ups.max_output_kw, upsCount === 0);
  checkCount('components.pump.count', c.pump.count, LIMITS.pump.min, LIMITS.pump.max);
  checkPositive('components.pump.capacity_kw', c.pump.capacity_kw, false);
  checkCount('components.rack.count', c.rack.count, LIMITS.rack.min, LIMITS.rack.max);
  checkPositive('components.rack.load_kw', c.rack.load_kw, false);
  const rf = c.rack.real_fan_rack;
  if (typeof rf !== 'number' || !Number.isInteger(rf) || rf < 0) invalid('components.rack.real_fan_rack must be an integer ≥ 0');
  if (!isObj(cfg.redundancy) || (cfg.redundancy.cooling !== 'N' && cfg.redundancy.cooling !== 'N+1')) {
    invalid('redundancy.cooling must be N or N+1');
  }
}

function baseComponent(
  id: string, kind: ComponentKind, label: string, index: number, params: ComponentState['params'],
): ComponentState {
  const { x, y } = layoutPosition(kind, index);
  return {
    id, kind, label, params,
    true_status: 'online',
    observed_status: 'online',
    true_temp_c: T_AMBIENT_C,
    observed_temp_c: T_AMBIENT_C,
    sensor_frozen: false,
    sensor_age_s: 0,
    load_kw: 0,
    cooling_kw: 0,
    ups_energy_kwh: 0,
    fan_health: 1,
    fan_anomaly: 0,
    fan_online: true,
    fan_fault_class: '',
    fan_rms: 0,
    fan_last_seen_tick: 0,
    repair_eta_tick: 0,
    is_real_hardware: false,
    x, y,
  };
}

function range(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i);
  return out;
}

function coolingWarning(cfg: FacilityConfig, itLoad: number): string {
  const n = cfg.components.pump.count;
  const cap = cfg.components.pump.capacity_kw;
  const total = n * cap;
  if (cfg.redundancy.cooling === 'N+1') {
    const remaining = total - cap; // all pumps are equal, so the largest is `cap`
    if (remaining >= itLoad) {
      return `Requested N+1 cooling: ${n}×${fmt(cap)} kW = ${fmt(total)} kW, minus the largest pump = ${fmt(remaining)} kW ≥ ${fmt(itLoad)} kW IT load ✔`;
    }
    const suggest = n <= 1 ? 'Suggest: add a second pump.' : `Suggest pump capacity ≥ ${Math.ceil(itLoad / (n - 1))} kW.`;
    return `N+1 NOT met: ${n}×${fmt(cap)} kW minus ${fmt(cap)} = ${fmt(remaining)} kW < ${fmt(itLoad)} kW. ${suggest}`;
  }
  if (total >= itLoad) {
    return `Cooling OK: ${n}×${fmt(cap)} kW = ${fmt(total)} kW ≥ ${fmt(itLoad)} kW IT load ✔`;
  }
  return `Cooling NOT sufficient: ${n}×${fmt(cap)} kW = ${fmt(total)} kW < ${fmt(itLoad)} kW IT load. Suggest pump capacity ≥ ${Math.ceil(itLoad / n)} kW.`;
}

function buildWarnings(cfg: FacilityConfig, realFanOutOfRange: boolean): string[] {
  const c = cfg.components;
  const itLoad = c.rack.count * c.rack.load_kw;
  const demand = itLoad + PUMP_DRAW_FRAC * c.pump.count * c.pump.capacity_kw;
  const supply = c.utility.count * c.utility.capacity_kw;
  const warnings: string[] = [coolingWarning(cfg, itLoad)];
  warnings.push(
    supply >= demand
      ? `Utility ${fmt(supply)} kW ≥ demand ${fmt(demand)} kW ✔`
      : `Utility ${fmt(supply)} kW NOT sufficient: demand ${fmt(demand)} kW`,
  );
  if (c.ups.count === 0) {
    warnings.push('No UPS: a utility loss shuts every rack down immediately');
  } else {
    const energy = c.ups.count * c.ups.energy_kwh;
    const maxOut = c.ups.count * c.ups.max_output_kw;
    warnings.push(`UPS runtime at full load ≈ ${fmt((energy / demand) * 60)} min`);
    if (maxOut < demand) {
      warnings.push(`UPS max output ${fmt(maxOut)} kW < demand ${fmt(demand)} kW: a utility loss shuts every rack down immediately`);
    }
  }
  if (realFanOutOfRange) {
    warnings.push(`Real fan rack ${c.rack.real_fan_rack} is out of range 1..${c.rack.count}: no rack uses the real fan`);
  }
  return warnings;
}

export function compileTopology(cfg: FacilityConfig): { state: FacilityState; warnings: string[] } {
  validate(cfg);
  const c = cfg.components;
  const components: Record<string, ComponentState> = {};
  const edges: Edge[] = [];

  const utilIds = range(c.utility.count).map((i) => {
    const id = `util_${i + 1}`;
    components[id] = baseComponent(id, 'utility', `Utility ${i + 1}`, i, { capacity_kw: c.utility.capacity_kw });
    return id;
  });
  const upsIds = range(c.ups.count).map((i) => {
    const id = `ups_${i + 1}`;
    const comp = baseComponent(id, 'ups', `UPS ${i + 1}`, i, { energy_kwh: c.ups.energy_kwh, max_output_kw: c.ups.max_output_kw });
    components[id] = { ...comp, ups_energy_kwh: c.ups.energy_kwh };
    return id;
  });
  const pumpIds = range(c.pump.count).map((i) => {
    const letter = PUMP_LETTERS[i];
    const id = `pump_${letter}`;
    components[id] = baseComponent(id, 'pump', `Pump ${letter}`, i, { capacity_kw: c.pump.capacity_kw });
    return id;
  });
  const realFan = c.rack.real_fan_rack;
  const realFanOutOfRange = realFan > c.rack.count;
  const rackIds = range(c.rack.count).map((i) => {
    const k = i + 1;
    const id = `rack_${k}`;
    const isReal = realFan === k;
    const comp = baseComponent(id, 'rack', isReal ? `Rack ${k} (real fan)` : `Rack ${k}`, i, {
      base_load_kw: c.rack.load_kw,
      thermal_mass_kj_per_c: DEFAULT_THERMAL_MASS_KJ_PER_C,
    });
    components[id] = { ...comp, load_kw: c.rack.load_kw, is_real_hardware: isReal };
    return id;
  });

  // Power edges
  if (upsIds.length > 0) {
    for (const u of utilIds) for (const p of upsIds) edges.push({ from_id: u, to_id: p, kind: 'power' });
    for (const p of upsIds) {
      for (const r of rackIds) edges.push({ from_id: p, to_id: r, kind: 'power' });
      for (const m of pumpIds) edges.push({ from_id: p, to_id: m, kind: 'power' });
    }
  } else {
    for (const u of utilIds) {
      for (const r of rackIds) edges.push({ from_id: u, to_id: r, kind: 'power' });
      for (const m of pumpIds) edges.push({ from_id: u, to_id: m, kind: 'power' });
    }
  }
  // Cooling edges
  for (const m of pumpIds) for (const r of rackIds) edges.push({ from_id: m, to_id: r, kind: 'cooling' });

  const state: FacilityState = {
    name: cfg.name,
    template: cfg.template,
    seed: cfg.seed,
    tick: 0,
    sim_time_s: 0,
    components,
    edges,
    failures: [],
  };
  return { state, warnings: buildWarnings(cfg, realFanOutOfRange) };
}
