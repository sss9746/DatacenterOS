// STUB (S-1). Owned by S-2: LANE-S §3.1 steps 5-7, S-D4, S-D5.
import type { FacilityState } from './types.js';

export interface Balance {
  supply_kw: number;
  demand_kw: number;
  powered: boolean;
  cooling_kw: number;
  load_kw: number;
  margin_kw: number;
}

export type FacilityStatus = 'normal' | 'degraded' | 'critical';

export function computeBalance(s: FacilityState, view: 'true' | 'observed'): Balance {
  throw new Error('INVALID: not implemented');
}

export function facilityStatus(s: FacilityState): FacilityStatus {
  throw new Error('INVALID: not implemented');
}
