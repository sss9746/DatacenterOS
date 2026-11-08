// Test helpers (S-2). defaultState() is a hand-built equivalent of compileTopology(defaultDemoConfig()).state
// (S-3 is building the compiler in parallel; swap to it once it lands).
import { applyFailure, setFanReading, step, makeRng } from '../src/v0/index.js';
import type { ComponentKind, ComponentState, Edge, FacilityState, Failure, FailureKind } from '../src/v0/index.js';

function comp(
  id: string,
  kind: ComponentKind,
  label: string,
  params: ComponentState['params'],
  x: number,
  y: number,
  extra: Partial<ComponentState> = {},
): ComponentState {
  return {
    id, kind, label, params,
    true_status: 'online', observed_status: 'online',
    true_temp_c: 22, observed_temp_c: 22, sensor_frozen: false, sensor_age_s: 0,
    load_kw: 0, cooling_kw: 0, ups_energy_kwh: 0,
    fan_health: 1, fan_anomaly: 0, fan_online: true, fan_fault_class: '', fan_rms: 0, fan_last_seen_tick: 0,
    repair_eta_tick: 0, is_real_hardware: false, x, y,
    ...extra,
  };
}

export const RACKS = ['rack_1', 'rack_2', 'rack_3', 'rack_4', 'rack_5', 'rack_6', 'rack_7', 'rack_8'];

export function defaultState(): FacilityState {
  const components: Record<string, ComponentState> = {};
  components['util_1'] = comp('util_1', 'utility', 'Utility 1', { capacity_kw: 200 }, 0, 0);
  components['ups_1'] = comp('ups_1', 'ups', 'UPS 1', { energy_kwh: 20, max_output_kw: 120 }, 220, 0, { ups_energy_kwh: 20 });
  components['pump_A'] = comp('pump_A', 'pump', 'Pump A', { capacity_kw: 50 }, 440, 0);
  components['pump_B'] = comp('pump_B', 'pump', 'Pump B', { capacity_kw: 50 }, 440, 130);
  RACKS.forEach((id, i) => {
    const k = i + 1;
    components[id] = comp(
      id, 'rack', k === 3 ? 'Rack 3 (real fan)' : `Rack ${k}`,
      { base_load_kw: 6, thermal_mass_kj_per_c: 60 },
      700 + 170 * (i % 4), 130 * Math.floor(i / 4),
      { load_kw: 6, is_real_hardware: k === 3 },
    );
  });
  const edges: Edge[] = [{ from_id: 'util_1', to_id: 'ups_1', kind: 'power' }];
  for (const r of RACKS) edges.push({ from_id: 'ups_1', to_id: r, kind: 'power' });
  for (const p of ['pump_A', 'pump_B']) edges.push({ from_id: 'ups_1', to_id: p, kind: 'power' });
  for (const p of ['pump_A', 'pump_B']) for (const r of RACKS) edges.push({ from_id: p, to_id: r, kind: 'cooling' });
  return { name: 'DC-1 Demo Hall', template: 'enterprise', seed: 42, tick: 0, sim_time_s: 0, components, edges, failures: [] };
}

export const rng = makeRng(42);

export function run(s: FacilityState, n: number, each?: (s: FacilityState) => FacilityState): FacilityState {
  let cur = s;
  for (let i = 0; i < n; i++) {
    if (each) cur = each(cur);
    cur = step(cur, 1, rng);
  }
  return cur;
}


export function fail(s: FacilityState, kind: FailureKind, target: string, params: Failure['params'] = {}): FacilityState {
  return applyFailure(s, { id: s.failures.length + 1, kind, target_id: target, params, start_tick: s.tick, active: true });
}

export const failPump = (s: FacilityState, id: string): FacilityState => fail(s, 'pump_fail', id);

/** Bridge simulator: re-send the fan reading every tick so the fan never times out. */
export const fanEvery = (anomaly: number) => (s: FacilityState): FacilityState =>
  setFanReading(s, 'rack_3', anomaly, s.tick === 0 ? 1 : s.tick, 'imbalance', 0.5);

/** Runs until pred is true; returns the tick it first held (or -1). */
export function ticksUntil(
  s: FacilityState, max: number, pred: (s: FacilityState) => boolean, each?: (s: FacilityState) => FacilityState,
): number {
  let cur = s;
  for (let i = 1; i <= max; i++) {
    if (each) cur = each(cur);
    cur = step(cur, 1, rng);
    if (pred(cur)) return i;
  }
  return -1;
}

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}
