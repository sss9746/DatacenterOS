// LANE-S §3.1 step 7 (S-D3): design-balanced rack cooling allocation.
import { T_AMBIENT_C } from '../constants.js';
import { CTRL_TAU_S } from './params.js';

export interface RackCoolingInput {
  id: string;
  base_kw: number;   // params.base_load_kw
  load_kw: number;   // effective L_i
  temp_c: number;    // true temperature
  mass: number;      // thermal_mass_kj_per_c
  health: number;    // fan_health for the real-fan rack, else 1
}

/** Cooling (kW) for one rack given its share of the facility cooling C. */
export function rackCooling(share: number, r: RackCoolingInput): number {
  const capacity = share * r.health;
  if (capacity >= r.load_kw) {
    return Math.min(capacity, r.load_kw + (r.mass * Math.max(0, r.temp_c - T_AMBIENT_C)) / CTRL_TAU_S);
  }
  return Math.min(share, r.load_kw) * r.health;
}

/** Allocates C across the racks that are up, proportional to base load. Returns cooling kW per rack id. */
export function allocateCooling(totalKw: number, racks: RackCoolingInput[]): Record<string, number> {
  let baseSum = 0;
  for (const r of racks) baseSum += r.base_kw;
  const out: Record<string, number> = {};
  for (const r of racks) {
    const share = baseSum > 0 ? (totalKw * r.base_kw) / baseSum : 0;
    out[r.id] = rackCooling(share, r);
  }
  return out;
}
