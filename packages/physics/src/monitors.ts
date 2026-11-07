// Owned by S-4: LANE-S §3.2 detect. Reads OBSERVED fields only (observed_status, observed_temp_c, sensor_age_s,
// load_kw, cooling_kw, fan_*, ups_energy_kwh) plus history. Never reads true_* or sensor_frozen.
import { computeBalance } from './balance.js';
import { SENSOR_STALE_S } from './internal/params.js';
import { T_DEGRADED_C, T_WARNING_C } from './constants.js';
import type {
  ComponentState,
  FacilityState,
  IncidentDraft,
  Symptom,
  TelemetryPoint,
  UpsParams,
} from './types.js';

const MARGIN_CRITICAL_KW = -10;
const UPS_CRITICAL_FRAC = 0.25;
const FAN_FAULT_ANOMALY = 0.5;
const FLAT_POINTS = 20;
const FLAT_TOL_C = 0.05;
const FLAT_DEFICIT_KW = 1;

function byKind(s: FacilityState, kind: ComponentState['kind']): ComponentState[] {
  return Object.keys(s.components)
    .sort()
    .map((id) => s.components[id])
    .filter((c) => c.kind === kind);
}

function coolingMarginNegative(s: FacilityState, racks: ComponentState[]): IncidentDraft | null {
  const margin = computeBalance(s, 'observed').margin_kw;
  if (!(margin < 0)) return null;
  const pumps = byKind(s, 'pump').filter((p) => p.observed_status !== 'online');
  return {
    symptom: 'cooling_margin_negative',
    component_ids: [...pumps.map((p) => p.id), ...racks.map((r) => r.id)],
    severity: margin < MARGIN_CRITICAL_KW ? 'critical' : 'high',
  };
}

function rackTempWarning(racks: ComponentState[]): IncidentDraft | null {
  const hot = racks.filter((r) => r.observed_temp_c >= T_WARNING_C);
  if (hot.length === 0) return null;
  return {
    symptom: 'rack_temp_warning',
    component_ids: hot.map((r) => r.id),
    severity: hot.some((r) => r.observed_temp_c >= T_DEGRADED_C) ? 'critical' : 'high',
  };
}

/** (b) best effort: the last FLAT_POINTS reported temps are flat while the rack is visibly under-cooled. */
function looksFlatWhileHeating(r: ComponentState, history: TelemetryPoint[]): boolean {
  if (r.observed_status === 'shutdown') return false; // a shut-down rack has no IT heat, its load_kw is the design load
  if (!(r.load_kw > r.cooling_kw + FLAT_DEFICIT_KW)) return false;
  const pts = history
    .filter((p) => p.component_id === r.id)
    .sort((a, b) => a.tick - b.tick)
    .slice(-FLAT_POINTS);
  if (pts.length < FLAT_POINTS) return false;
  const ref = pts[pts.length - 1].temp_c;
  return pts.every((p) => Math.abs(p.temp_c - ref) <= FLAT_TOL_C);
}

function thermalImbalance(racks: ComponentState[], history: TelemetryPoint[]): IncidentDraft | null {
  const suspects = racks.filter((r) => {
    const othersFresh = racks.some((o) => o.id !== r.id && o.sensor_age_s === 0);
    const stale = r.sensor_age_s > SENSOR_STALE_S && othersFresh;
    return stale || looksFlatWhileHeating(r, history);
  });
  if (suspects.length === 0) return null;
  return { symptom: 'thermal_imbalance', component_ids: suspects.map((r) => r.id), severity: 'high' };
}

function fanVibrationAnomaly(racks: ComponentState[]): IncidentDraft | null {
  const bad = racks.filter((r) => r.is_real_hardware && r.fan_online && r.fan_anomaly >= FAN_FAULT_ANOMALY);
  if (bad.length === 0) return null;
  return { symptom: 'fan_vibration_anomaly', component_ids: bad.map((r) => r.id), severity: 'high' };
}

function powerOnUps(s: FacilityState): IncidentDraft | null {
  const downUtils = byKind(s, 'utility').filter((u) => u.observed_status !== 'online');
  if (downUtils.length === 0) return null;
  const bal = computeBalance(s, 'observed');
  if (!(bal.supply_kw < bal.demand_kw)) return null;
  const upses = byKind(s, 'ups').filter((u) => u.ups_energy_kwh > 0);
  if (upses.length === 0) return null;
  const energy = upses.reduce((acc, u) => acc + u.ups_energy_kwh, 0);
  const capacity = upses.reduce((acc, u) => acc + (u.params as UpsParams).energy_kwh, 0);
  const frac = capacity > 0 ? energy / capacity : 0;
  return {
    symptom: 'power_on_ups',
    component_ids: [...downUtils.map((u) => u.id), ...upses.map((u) => u.id)],
    severity: frac < UPS_CRITICAL_FRAC ? 'critical' : 'high',
  };
}

function fanOffline(racks: ComponentState[]): IncidentDraft | null {
  const off = racks.filter((r) => r.is_real_hardware && r.fan_online === false && r.fan_last_seen_tick > 0);
  if (off.length === 0) return null;
  return { symptom: 'fan_offline', component_ids: off.map((r) => r.id), severity: 'low' };
}

/**
 * Symptom monitors behind B's tick. Returns at most one draft per symptom, in SYMPTOMS order, skipping any symptom
 * in `openSymptoms`. Never emits `operator_question` (that one comes only from /agent/ask).
 */
export function detect(s: FacilityState, history: TelemetryPoint[], openSymptoms: Symptom[]): IncidentDraft[] {
  const open = new Set<string>(openSymptoms);
  const racks = byKind(s, 'rack');
  const monitors: Array<[Symptom, () => IncidentDraft | null]> = [
    ['cooling_margin_negative', () => coolingMarginNegative(s, racks)],
    ['rack_temp_warning', () => rackTempWarning(racks)],
    ['thermal_imbalance', () => thermalImbalance(racks, history)],
    ['fan_vibration_anomaly', () => fanVibrationAnomaly(racks)],
    ['power_on_ups', () => powerOnUps(s)],
    ['fan_offline', () => fanOffline(racks)],
  ];
  const out: IncidentDraft[] = [];
  for (const [symptom, run] of monitors) {
    if (open.has(symptom)) continue;
    const draft = run();
    if (draft !== null) out.push(draft);
  }
  return out;
}
