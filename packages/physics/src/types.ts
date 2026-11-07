import type { COMPONENT_KINDS, STATUSES, FAILURE_KINDS, ACTION_KINDS, SYMPTOMS, SEVERITIES } from './constants.js';

// packages/physics/src/types.ts
export type ComponentKind = typeof COMPONENT_KINDS[number];
export type Status = typeof STATUSES[number];
export type FailureKind = typeof FAILURE_KINDS[number];
export type ActionKind = typeof ACTION_KINDS[number];
export type Symptom = typeof SYMPTOMS[number];
export type Severity = typeof SEVERITIES[number];
export type Rng = () => number;                     // uniform [0,1)

export interface UtilityParams { capacity_kw: number }
export interface UpsParams { energy_kwh: number; max_output_kw: number }
export interface PumpParams { capacity_kw: number }
export interface RackParams { base_load_kw: number; thermal_mass_kj_per_c: number }

export interface ComponentState {
  id: string; kind: ComponentKind; label: string;
  params: UtilityParams | UpsParams | PumpParams | RackParams;
  true_status: Status;            // hidden from agents
  observed_status: Status;        // what telemetry shows
  true_temp_c: number;            // racks only (others = ambient); hidden
  observed_temp_c: number;        // equals true unless the sensor is frozen
  sensor_frozen: boolean;         // hidden
  sensor_age_s: number;           // observable
  load_kw: number;                // current IT load (racks); pumps: power draw
  cooling_kw: number;             // allocated cooling (racks) or output (pumps)
  ups_energy_kwh: number;         // UPS only, else 0
  fan_health: number;             // 0..1, real-fan rack only, else 1
  fan_anomaly: number;            // 0..1, real-fan rack only, else 0
  fan_online: boolean;            // real-fan rack only, else true
  fan_fault_class: string;        // last fault_class from the bridge (may carry the "replay:" prefix), else ''
  fan_rms: number;                // last vibration RMS in g, else 0
  fan_last_seen_tick: number;
  repair_eta_tick: number;        // 0 = none; set by dispatch_tech
  is_real_hardware: boolean;
  x: number; y: number;           // layout
}
export interface Edge { from_id: string; to_id: string; kind: 'power' | 'cooling' }
export interface Failure { id: number; kind: FailureKind; target_id: string; params: Record<string, number | string>; start_tick: number; active: boolean }
export interface FacilityState {
  name: string; template: string; seed: number;
  tick: number; sim_time_s: number;
  components: Record<string, ComponentState>;
  edges: Edge[];
  failures: Failure[];
}
export interface Action { kind: ActionKind; target_id: string; params: { kw?: number; to?: string } }
export interface Outcome {
  min_cooling_margin_kw: number; peak_temp_c: number;
  racks_degraded: number; racks_shutdown: number; downtime_rack_s: number;
}
export interface SafetyResult { ok: boolean; reason: string; predicted: Outcome }
export interface IncidentDraft { symptom: Symptom; component_ids: string[]; severity: Severity }
export interface TelemetryPoint { component_id: string; tick: number; temp_c: number; power_kw: number; cooling_kw: number }
export interface FacilityConfig {
  name: string; template: 'enterprise' | 'ai_compute' | 'edge'; seed: number;
  components: {
    utility: { count: number; capacity_kw: number };
    ups: { count: number; energy_kwh: number; max_output_kw: number };
    pump: { count: number; capacity_kw: number };
    rack: { count: number; load_kw: number; real_fan_rack: number };   // 0 = none
  };
  redundancy: { cooling: 'N' | 'N+1' };
}
