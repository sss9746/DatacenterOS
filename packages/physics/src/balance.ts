// Owned by S-2: LANE-S §3.1 steps 5-7, S-D4, S-D5.
import { T_WARNING_C } from './constants.js';
import { DEFAULT_SPIKE_KW, PUMP_DRAW_FRAC } from './internal/params.js';
import type { ComponentState, FacilityState, PumpParams, Status, UpsParams, UtilityParams } from './types.js';

export interface Balance {
  supply_kw: number;
  demand_kw: number;
  powered: boolean;
  cooling_kw: number;
  load_kw: number;
  margin_kw: number;
}

export type FacilityStatus = 'normal' | 'degraded' | 'critical';
export type View = 'true' | 'observed';

/** Full power/cooling picture used by step (true view) and by monitors (observed view). */
export interface PowerDetail extends Balance {
  /** effective rack load L_i per rack id (0 for a rack that is down) */
  rack_load: Record<string, number>;
  /** UPS id that covers the deficit this tick, or '' */
  ups_id: string;
  /** kW drawn from that UPS (0 when on utility) */
  ups_discharge_kw: number;
  /** pump ids that are online (they draw power even when unpowered) */
  online_pumps: string[];
}

export function statusOf(c: ComponentState, view: View): Status {
  return view === 'true' ? c.true_status : c.observed_status;
}

/** A rack carries load only when online or degraded (S-D1: degraded keeps full load). */
export function rackIsUp(c: ComponentState, view: View): boolean {
  const st = statusOf(c, view);
  return st === 'online' || st === 'degraded';
}

/** Ids of a component kind, sorted for determinism. */
export function idsOfKind(s: FacilityState, kind: ComponentState['kind']): string[] {
  return Object.keys(s.components)
    .filter((id) => s.components[id]!.kind === kind)
    .sort();
}

/** Σ extra_kw of active load_spike failures on a rack (default 4 kW each). Power meters see this, so both views include it. */
export function rackSpikeKw(s: FacilityState, rackId: string): number {
  let kw = 0;
  for (const f of s.failures) {
    if (!f.active || f.kind !== 'load_spike' || f.target_id !== rackId) continue;
    const raw = Number(f.params['extra_kw']);
    kw += Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SPIKE_KW;
  }
  return kw;
}

/** L_i = down ? 0 : load_kw + spike_i (LANE-S §3.1 step 5). */
export function effectiveRackLoad(s: FacilityState, rackId: string, view: View = 'true'): number {
  const c = s.components[rackId];
  if (!c || c.kind !== 'rack' || !rackIsUp(c, view)) return 0;
  return c.load_kw + rackSpikeKw(s, rackId);
}

export function powerDetail(s: FacilityState, view: View): PowerDetail {
  const rack_load: Record<string, number> = {};
  let q_it = 0;
  for (const id of idsOfKind(s, 'rack')) {
    const l = effectiveRackLoad(s, id, view);
    rack_load[id] = l;
    q_it += l;
  }

  const online_pumps = idsOfKind(s, 'pump').filter((id) => statusOf(s.components[id]!, view) === 'online');
  let pumpCap = 0;
  let pumpDraw = 0;
  for (const id of online_pumps) {
    const cap = (s.components[id]!.params as PumpParams).capacity_kw;
    pumpCap += cap;
    pumpDraw += PUMP_DRAW_FRAC * cap;
  }
  const demand_kw = q_it + pumpDraw;

  let supply_kw = 0;
  for (const id of idsOfKind(s, 'utility')) {
    const c = s.components[id]!;
    if (statusOf(c, view) === 'online') supply_kw += (c.params as UtilityParams).capacity_kw;
  }

  let powered = supply_kw >= demand_kw;
  let ups_id = '';
  let ups_discharge_kw = 0;
  if (!powered) {
    const deficit = demand_kw - supply_kw;
    for (const id of idsOfKind(s, 'ups')) {
      const c = s.components[id]!;
      if (statusOf(c, view) !== 'online' || c.ups_energy_kwh <= 0) continue;
      if (deficit <= (c.params as UpsParams).max_output_kw) {
        powered = true;
        ups_id = id;
        ups_discharge_kw = deficit;
        break;
      }
    }
  }

  const cooling_kw = powered ? pumpCap : 0;
  return {
    supply_kw,
    demand_kw,
    powered,
    cooling_kw,
    load_kw: q_it,
    margin_kw: cooling_kw - q_it,
    rack_load,
    ups_id,
    ups_discharge_kw,
    online_pumps,
  };
}

export function computeBalance(s: FacilityState, view: 'true' | 'observed'): Balance {
  const d = powerDetail(s, view);
  return {
    supply_kw: d.supply_kw,
    demand_kw: d.demand_kw,
    powered: d.powered,
    cooling_kw: d.cooling_kw,
    load_kw: d.load_kw,
    margin_kw: d.margin_kw,
  };
}

/**
 * S-D4 + CONTRACTS "facility.status values", from observed (public) fields:
 * critical = any rack shut down, or margin < −10; degraded = any rack degraded or at/above the 35 °C warning, or margin < 0.
 */
export function facilityStatus(s: FacilityState): FacilityStatus {
  const margin = computeBalance(s, 'observed').margin_kw;
  const racks = idsOfKind(s, 'rack').map((id) => s.components[id]!);
  if (racks.some((r) => r.observed_status === 'shutdown') || margin < -10) return 'critical';
  if (racks.some((r) => r.observed_status === 'degraded' || r.observed_temp_c >= T_WARNING_C) || margin < 0) {
    return 'degraded';
  }
  return 'normal';
}
