// Owned by S-2: LANE-S §3.1.
import { FAN_ONLINE_TIMEOUT_TICKS, PASSIVE_K_PER_S, T_AMBIENT_C, T_DEGRADED_C, T_SHUTDOWN_C } from './constants.js';
import { idsOfKind, powerDetail, rackIsUp } from './balance.js';
import { cloneState } from './internal/clone.js';
import { allocateCooling, type RackCoolingInput } from './internal/cooling.js';
import { PUMP_DRAW_FRAC, T_MAX_C, T_MIN_C, T_RECOVER_C } from './internal/params.js';
import type { ComponentState, FacilityState, PumpParams, RackParams, Rng, UtilityParams } from './types.js';

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** Step 2: tech repairs that are due. */
function applyRepairs(s: FacilityState): void {
  for (const id of Object.keys(s.components).sort()) {
    const c = s.components[id]!;
    if (c.repair_eta_tick <= 0 || s.tick < c.repair_eta_tick) continue;
    c.true_status = 'online';
    c.observed_status = 'online';
    c.sensor_frozen = false;
    c.repair_eta_tick = 0;
    for (const f of s.failures) if (f.target_id === id) f.active = false;
  }
}

/** Step 3: continuous failure effects (sensor freeze). load_spike heat is read by effectiveRackLoad. */
function applyContinuousFailures(s: FacilityState): void {
  for (const id of idsOfKind(s, 'rack')) {
    const c = s.components[id]!;
    c.sensor_frozen = s.failures.some((f) => f.active && f.kind === 'sensor_freeze' && f.target_id === id);
  }
}

/** Step 4: the real fan goes offline when the bridge is silent. */
function applyFanTimeout(s: FacilityState): void {
  for (const c of Object.values(s.components)) {
    if (c.is_real_hardware && c.fan_last_seen_tick > 0 && s.tick - c.fan_last_seen_tick > FAN_ONLINE_TIMEOUT_TICKS) {
      c.fan_online = false;
      c.fan_health = 1;
    }
  }
}

function updateRackStatus(c: ComponentState): void {
  const t = c.true_temp_c;
  if (t >= T_SHUTDOWN_C) c.true_status = 'shutdown';
  else if (t >= T_DEGRADED_C && c.true_status === 'online') c.true_status = 'degraded';
  else if (t < T_RECOVER_C && c.true_status === 'degraded') c.true_status = 'online';
}

export function step(s: FacilityState, dtSec: number, rng: Rng): FacilityState {
  void rng; // accepted but unused in v1 (LANE-S §3.1)
  if (!Number.isFinite(dtSec) || dtSec < 0) throw new Error('INVALID: dtSec must be a finite number >= 0');

  // 1. clone + clock
  const n = cloneState(s);
  n.tick += 1;
  n.sim_time_s += dtSec;

  // 2-4
  applyRepairs(n);
  applyContinuousFailures(n);
  applyFanTimeout(n);

  // 5-6. loads + power
  const p = powerDetail(n, 'true');
  const racks = idsOfKind(n, 'rack');
  const pumps = idsOfKind(n, 'pump');

  if (!p.powered) {
    for (const id of racks) {
      const c = n.components[id]!;
      if (rackIsUp(c, 'true')) c.true_status = 'shutdown';
      p.rack_load[id] = 0;
    }
  }

  // utilities / UPS bookkeeping
  let remaining = p.powered ? p.demand_kw - p.ups_discharge_kw : 0;
  for (const id of idsOfKind(n, 'utility')) {
    const c = n.components[id]!;
    const cap = (c.params as UtilityParams).capacity_kw;
    const out = c.true_status === 'online' ? Math.min(cap, Math.max(0, remaining)) : 0;
    c.load_kw = out;
    c.cooling_kw = 0;
    remaining -= out;
  }
  for (const id of idsOfKind(n, 'ups')) {
    const c = n.components[id]!;
    if (id === p.ups_id) {
      c.load_kw = p.ups_discharge_kw;
      c.ups_energy_kwh = Math.max(0, c.ups_energy_kwh - (p.ups_discharge_kw * dtSec) / 3600);
    } else {
      c.load_kw = 0;
    }
    c.cooling_kw = 0;
  }

  // 7. cooling
  const onlinePumps = new Set(p.online_pumps);
  for (const id of pumps) {
    const c = n.components[id]!;
    const cap = (c.params as PumpParams).capacity_kw;
    const on = onlinePumps.has(id);
    c.load_kw = on ? PUMP_DRAW_FRAC * cap : 0;
    c.cooling_kw = on && p.powered ? cap : 0;
  }
  const inputs: RackCoolingInput[] = [];
  for (const id of racks) {
    const c = n.components[id]!;
    if (!rackIsUp(c, 'true')) continue;
    const rp = c.params as RackParams;
    inputs.push({
      id,
      base_kw: rp.base_load_kw,
      load_kw: p.rack_load[id] ?? 0,
      temp_c: c.true_temp_c,
      mass: rp.thermal_mass_kj_per_c,
      health: c.is_real_hardware ? c.fan_health : 1,
    });
  }
  const cooling = allocateCooling(p.cooling_kw, inputs);

  // 8-10. thermal, thresholds, sensors
  for (const id of racks) {
    const c = n.components[id]!;
    const mass = (c.params as RackParams).thermal_mass_kj_per_c;
    const load = rackIsUp(c, 'true') ? (p.rack_load[id] ?? 0) : 0;
    const cool = cooling[id] ?? 0;
    c.cooling_kw = cool;
    const t = c.true_temp_c;
    const dT = dtSec * ((load - cool) / mass - PASSIVE_K_PER_S * (t - T_AMBIENT_C));
    c.true_temp_c = clamp(t + dT, T_MIN_C, T_MAX_C);
    updateRackStatus(c);
  }
  for (const c of Object.values(n.components)) {
    c.observed_status = c.true_status;
    if (c.kind !== 'rack') {
      c.true_temp_c = T_AMBIENT_C;
      c.observed_temp_c = T_AMBIENT_C;
      c.sensor_age_s = 0;
      continue;
    }
    if (c.sensor_frozen) {
      c.sensor_age_s += dtSec;
    } else {
      c.observed_temp_c = c.true_temp_c;
      c.sensor_age_s = 0;
    }
  }
  return n;
}

