// STUB (S-1). Owned by S-2: LANE-S §3.2 applyFailure / setFanReading.
import type { FacilityState, Failure } from './types.js';

export function applyFailure(s: FacilityState, f: Failure): FacilityState {
  throw new Error('INVALID: not implemented');
}

export function setFanReading(
  s: FacilityState,
  rackId: string,
  anomaly: number,
  tick: number,
  faultClass?: string,
  rms?: number,
): FacilityState {
  throw new Error('INVALID: not implemented');
}
