// packages/physics/src/constants.ts   (Lane S). Python copies these into agents/dcos_agents/constants.py (Lane C).
export const COMPONENT_KINDS = ['utility', 'ups', 'pump', 'rack'] as const;
export const STATUSES = ['online', 'offline', 'degraded', 'shutdown', 'maintenance'] as const;
export const FAILURE_KINDS = ['pump_fail', 'utility_loss', 'sensor_freeze', 'load_spike', 'ticket_lie'] as const;
export const ACTION_KINDS = ['shutdown_component', 'restore_component', 'shed_load', 'migrate_load', 'set_load', 'dispatch_tech'] as const;
export const ACTION_STATUSES = ['pending', 'approved', 'blocked', 'executed', 'failed'] as const;
export const SYMPTOMS = ['cooling_margin_negative', 'rack_temp_warning', 'thermal_imbalance', 'fan_vibration_anomaly', 'power_on_ups', 'fan_offline'] as const;
export const SEVERITIES = ['low', 'high', 'critical'] as const;
export const INCIDENT_STATUSES = ['new', 'investigating', 'planning', 'awaiting_approval', 'executing', 'resolved', 'failed'] as const;
export const AGENT_NAMES = ['diagnose', 'plan', 'execute', 'handoff'] as const;
export const STEP_KINDS = ['thought', 'tool_call', 'tool_result', 'decision'] as const;
export const FAULT_CLASSES = ['healthy', 'imbalance', 'obstruction', 'unknown'] as const;
export const ROLES = ['admin', 'presenter', 'agent', 'bridge'] as const;
export const METRIC_KEYS = ['events_per_s', 'subscribers', 'agent_calls', 'agent_tokens', 'downtime_rack_s', 'unsafe_blocked', 'unsafe_executed'] as const;

// Thresholds (°C) and physics constants
export const T_AMBIENT_C = 22;
export const T_WARNING_C = 35;
export const T_DEGRADED_C = 45;
export const T_SHUTDOWN_C = 55;
export const PASSIVE_K_PER_S = 0.0005;            // was 0.02 in PLAN.md, which was a bug (a rack with no cooling would plateau at 27 °C)
// Rack thermal model (authoritative, per rack, per second):
//   dT/dt = (load_kw − cooling_kw) / thermal_mass_kj_per_c − PASSIVE_K_PER_S × (T − T_AMBIENT_C)
// Sanity checks for the tests:
//   6 kW rack with 0 cooling → about 0.1 °C/s, reaching 55 °C in about 5.5 min ("all racks shut down in about 6 min")
//   fan_health 0.3 on rack_3  → about 4.2 kW deficit, about 0.07 °C/s, reaching the 35 °C warning in about 3 min (that's the fan lead-time window)
export const DEFAULT_THERMAL_MASS_KJ_PER_C = 60;   // per rack
export const SAFETY_HORIZON_TICKS = 120;
export const TECH_REPAIR_TICKS = 60;               // dispatch_tech restores the target after 60 ticks
export const HISTORY_PER_COMPONENT = 120;          // ring buffer size
export const FAN_ONLINE_TIMEOUT_TICKS = 5;         // no reading for 5 ticks → fan_offline
export const REAL_FAN_RACK_ID = 'rack_3';
