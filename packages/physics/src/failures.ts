// Owned by S-2: LANE-S §3.2 applyFailure / setFanReading.
import { FAILURE_KINDS } from './constants.js';
import { cloneFailure, cloneState } from './internal/clone.js';
import type { ComponentKind, FacilityState, Failure } from './types.js';

const TARGET_KIND: Record<string, ComponentKind | null> = {
  pump_fail: 'pump',
  utility_loss: 'utility',
  sensor_freeze: 'rack',
  load_spike: 'rack',
  ticket_lie: null, // any component
};

export function applyFailure(s: FacilityState, f: Failure): FacilityState {
  if (!(FAILURE_KINDS as readonly string[]).includes(f.kind)) throw new Error(`INVALID: unknown failure kind ${String(f.kind)}`);
  const target = s.components[f.target_id];
  if (!target) throw new Error(`NOT_FOUND: component ${f.target_id}`);
  const need = TARGET_KIND[f.kind];
  if (need && target.kind !== need) throw new Error(`INVALID: ${f.kind} needs a ${need} target`);

  const n = cloneState(s);
  n.failures.push(cloneFailure(f));
  if (!f.active) return n;
  const c = n.components[f.target_id]!;
  switch (f.kind) {
    case 'pump_fail':
    case 'utility_loss':
      c.true_status = 'offline';
      c.observed_status = 'offline';
      break;
    case 'sensor_freeze':
      c.sensor_frozen = true;
      break;
    default:
      break; // load_spike: applied continuously by step; ticket_lie: no physical change
  }
  return n;
}

/** fan_health = 1 − clamp((anomaly − 0.3) / 0.6, 0, 1) × 0.7 (CONTRACTS §7). */
export function fanHealthFromAnomaly(anomaly: number): number {
  const x = Math.min(1, Math.max(0, (anomaly - 0.3) / 0.6));
  return 1 - x * 0.7;
}

export function setFanReading(
  s: FacilityState,
  rackId: string,
  anomaly: number,
  tick: number,
  faultClass = '',
  rms = 0,
): FacilityState {
  const rack = s.components[rackId];
  if (!rack) throw new Error(`NOT_FOUND: component ${rackId}`);
  if (!rack.is_real_hardware) throw new Error(`INVALID: ${rackId} is not the real-fan rack`);
  const a = Number.isFinite(anomaly) ? Math.min(1, Math.max(0, anomaly)) : 0;

  const n = cloneState(s);
  const c = n.components[rackId]!;
  c.fan_anomaly = a;
  c.fan_health = fanHealthFromAnomaly(a);
  c.fan_fault_class = typeof faultClass === 'string' ? faultClass : '';
  c.fan_rms = Number.isFinite(rms) ? rms : 0;
  c.fan_online = true;
  c.fan_last_seen_tick = Number.isFinite(tick) ? tick : n.tick;
  return n;
}
