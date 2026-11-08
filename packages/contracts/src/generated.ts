/* eslint-disable */
// GENERATED — do not edit; run pnpm --filter @dcos/contracts gen
// Source: packages/contracts/schema/contracts.schema.json

export type Identifier = string;

export interface ActionCommand {
  schema_version: '1.1.0';
  run_id: Identifier;
  action_id: Identifier;
  command_key: Identifier;
  workflow_id: Identifier;
  plan_id: Identifier;
  /**
   * @minItems 1
   */
  incident_ids: [Identifier, ...Identifier[]];
  operation:
    | 'keep_running'
    | 'power_cap'
    | 'checkpoint'
    | 'pause_job'
    | 'cordon_gpu'
    | 'migrate_restart'
    | 'uncordon_gpu'
    | 'escalate';
  target_resource_id: Identifier;
  job_id: Identifier | null;
  arguments: {
    [k: string]: unknown;
  };
  depends_on_command_keys: Identifier[];
  expected_decision_epoch: number;
  expected_resource_versions: {
    [k: string]: number;
  };
  requested_sim_time_ms: number;
}
export interface ActionStatus {
  schema_version: '1.1.0';
  run_id: Identifier;
  action_id: Identifier;
  command_key: Identifier;
  status:
    | 'requested'
    | 'claimed'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'needs_reconciliation';
  attempt: number;
  updated_sim_time_ms: number;
  result: {
    [k: string]: unknown;
  };
  reason_code: string | null;
  version: number;
}
export interface Checkpoint {
  schema_version: '1.1.0';
  run_id: Identifier;
  checkpoint_id: Identifier;
  job_id: Identifier;
  storage_resource_id: Identifier;
  status: 'requested' | 'writing' | 'complete' | 'failed';
  progress_work_units: number;
  requested_sim_time_ms: number;
  complete_sim_time_ms: number | null;
  accessible: boolean;
  command_key: Identifier;
}
export interface CoolingCurrent {
  schema_version: '1.1.0';
  run_id: Identifier;
  resource_id: Identifier;
  operating_state: 'normal' | 'degraded' | 'failed' | 'maintenance';
  nominal_capacity_w: number;
  pump_power_w: number;
  observed_capacity_estimate_w: number | null;
  version: number;
}
export interface DependencyEdge {
  schema_version: '1.1.0';
  run_id: Identifier;
  edge_id: Identifier;
  consumer_id: Identifier;
  provider_id: Identifier;
  relation:
    'hosted_on' | 'cooled_by' | 'powered_by' | 'connected_via' | 'checkpoint_uses' | 'monitored_by';
  weight: number;
}
export interface EvaluationResult {
  schema_version: '1.1.0';
  run_id: Identifier;
  scenario_id: Identifier;
  seed: number;
  policy: 'reactive' | 'threshold' | 'nemotron';
  lost_work_units: number;
  job_completion_delay_s: number;
  gpu_busy_waste_s: number;
  unnecessary_preemptions: number;
  unsafe_actions_executed: number;
  unsafe_actions_blocked: number;
  successful_recoveries: number;
  failed_recoveries: number;
  agent_crash_resumes: number;
}
/**
 * Private scenario ground truth; never expose to the agent.
 */
export interface FaultInjection {
  schema_version: '1.1.0';
  fault_id: Identifier;
  run_id: Identifier;
  target_resource_id: Identifier;
  kind:
    | 'cooling_pump_degradation'
    | 'cooling_pump_outage'
    | 'gpu_thermal_load'
    | 'gpu_xid_48'
    | 'gpu_xid_79'
    | 'gpu_xid_74'
    | 'network_link_down'
    | 'node_crash'
    | 'sensor_stale';
  start_sim_time_ms: number;
  duration_sim_ms: number | null;
  severity: number;
  parameters: {
    [k: string]: unknown;
  };
  seed_offset: number;
}
export interface GpuCurrent {
  schema_version: '1.1.0';
  run_id: Identifier;
  resource_id: Identifier;
  node_id: Identifier;
  availability: 'ready' | 'degraded' | 'cordoned' | 'unreachable';
  temp_c: number;
  sm_clock_mhz: number;
  power_w: number;
  power_limit_w: number;
  clocks_event_reasons: number;
  last_xid_code: number | null;
  last_seen_sim_ms: number;
  version: number;
}
/**
 * Standalone hardware transport frame; gateway maps sensor_id to run_id and resource_id.
 */
export interface HardwareSample {
  schema_version: '1.1.0';
  sensor_id: Identifier;
  sensor_kind: 'accelerometer' | 'microphone';
  source_seq: number;
  observed_unix_ms: number;
  accel_rms_g: number | null;
  sound_rms: number | null;
  rpm: number | null;
  anomaly_score: number | null;
  calibration_id: Identifier;
  quality: 'good' | 'estimated' | 'stale' | 'invalid';
}
export interface Incident {
  schema_version: '1.1.0';
  run_id: Identifier;
  incident_id: Identifier;
  state: 'open' | 'investigating' | 'mitigating' | 'monitoring' | 'resolved' | 'escalated';
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  hypothesis: string | null;
  confidence: number;
  opened_sim_time_ms: number;
  updated_sim_time_ms: number;
  version: number;
}
export interface IncidentLink {
  schema_version: '1.1.0';
  run_id: Identifier;
  incident_id: Identifier;
  linked_id: Identifier;
  link_kind: 'symptom' | 'resource' | 'workflow';
  reason: string;
}
export interface JobGpuAllocation {
  schema_version: '1.1.0';
  run_id: Identifier;
  job_id: Identifier;
  gpu_id: Identifier;
  since_sim_time_ms: number;
}
export interface JobSpec {
  schema_version: '1.1.0';
  run_id: Identifier;
  job_id: Identifier;
  gpus_required: number;
  placement_policy: 'same_node' | 'gang_multi_node';
  /**
   * @minItems 1
   */
  compatible_node_ids: [Identifier, ...Identifier[]];
  gpu_profile: string;
  priority: number;
  preemptible: boolean;
  checkpoint_supported: boolean;
  checkpoint_storage_id: Identifier | null;
  checkpoint_duration_ms: number;
  restart_duration_ms: number;
  checkpoint_interval_ms: number;
  total_work_units: number;
  work_rate_per_gpu_per_sim_s: number;
}
export interface JobState {
  schema_version: '1.1.0';
  run_id: Identifier;
  job_id: Identifier;
  status: 'queued' | 'running' | 'checkpointing' | 'paused' | 'failed' | 'restarting' | 'completed';
  allocated_gpu_ids: Identifier[];
  progress_work_units: number;
  durable_work_units: number;
  latest_checkpoint_id: Identifier | null;
  version: number;
  last_update_sim_time_ms: number;
}
export interface NodeCurrent {
  schema_version: '1.1.0';
  run_id: Identifier;
  resource_id: Identifier;
  rack_id: Identifier;
  availability: 'ready' | 'degraded' | 'cordoned' | 'unreachable';
  power_headroom_w: number;
  thermal_headroom_c: number;
  version: number;
}
/**
 * Planner-visible snapshot. Must not contain fault injection ground truth or future scenario events.
 */
export interface ObservedSnapshot {
  schema_version: '1.1.0';
  run_id: Identifier;
  clock: RunClock;
  resources: ResourceSpec[];
  dependencies: DependencyEdge[];
  gpus: GpuCurrent[];
  nodes: NodeCurrent[];
  cooling: CoolingCurrent[];
  job_specs: JobSpec[];
  job_states: JobState[];
  allocations: JobGpuAllocation[];
  checkpoints: Checkpoint[];
  observation_event_ids: Identifier[];
}
export interface RunClock {
  sim_time_ms: number;
  tick_index: number;
  step_ms: number;
  wall_tick_ms: number;
  paused: boolean;
  decision_epoch: number;
}
export interface ResourceSpec {
  schema_version: '1.1.0';
  run_id: Identifier;
  resource_id: Identifier;
  kind:
    | 'rack'
    | 'node'
    | 'gpu'
    | 'cooling_pump'
    | 'cooling_loop'
    | 'network_link'
    | 'checkpoint_store'
    | 'fan_sensor'
    | 'power_domain';
  parent_id: Identifier | null;
  failure_domain_id: Identifier;
  profile: string;
  config: {
    [k: string]: unknown;
  };
  enabled: boolean;
}
export interface PhysicsTickResult {
  schema_version: '1.1.0';
  run_id: Identifier;
  world_after: PhysicsWorld;
  telemetry: TelemetryEvent[];
  signals: SignalEvent[];
  material_change: boolean;
  completed_command_keys: Identifier[];
  failed_command_keys: Identifier[];
}
/**
 * Internal true state; never exposed to LLM tools or to public subscriptions.
 */
export interface PhysicsWorld {
  schema_version: '1.1.0';
  run_id: Identifier;
  observable: ObservedSnapshot;
  active_faults_private: FaultInjection[];
  hidden_physics_state_json: {
    [k: string]: unknown;
  };
  rng_state: string;
}
export interface TelemetryEvent {
  schema_version: '1.1.0';
  event_id: Identifier;
  run_id: Identifier;
  resource_id: Identifier;
  source_kind: 'simulator' | 'hardware' | 'replay' | 'dcgm';
  source_id: Identifier;
  source_seq: number;
  observed_unix_ms: number;
  sim_time_ms: number;
  metric: string;
  value: number;
  unit: string;
  quality: 'good' | 'estimated' | 'stale' | 'missing' | 'invalid';
  labels: {
    [k: string]: string;
  };
}
export interface SignalEvent {
  schema_version: '1.1.0';
  event_id: Identifier;
  run_id: Identifier;
  resource_id: Identifier;
  source_kind: 'simulator' | 'hardware' | 'replay' | 'dcgm';
  source_id: Identifier;
  source_seq: number;
  sim_time_ms: number;
  observed_unix_ms: number;
  event_type:
    | 'xid_error'
    | 'gpu_unreachable'
    | 'node_unreachable'
    | 'checkpoint_lost'
    | 'sensor_timeout'
    | 'equipment_alarm'
    | 'resource_recovered';
  xid_code: number | null;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  evidence: {
    [k: string]: unknown;
  };
}
export interface PlanCandidate {
  schema_version: '1.1.0';
  plan_id: Identifier;
  run_id: Identifier;
  workflow_id: Identifier;
  /**
   * @minItems 1
   */
  incident_ids: [Identifier, ...Identifier[]];
  based_on_decision_epoch: number;
  /**
   * @maxItems 50
   */
  assumptions: string[];
  /**
   * @minItems 1
   */
  command_keys: [Identifier, ...Identifier[]];
  expected_completion_delay_sim_s: number;
  expected_lost_work_units: number;
  expected_gpu_busy_waste_s: number;
  failure_risk_estimate: number;
  explanation: string;
}
export interface SafetyDecision {
  schema_version: '1.1.0';
  run_id: Identifier;
  plan_id: Identifier;
  action_id: Identifier;
  decision: 'allow' | 'deny' | 'needs_approval' | 'retry_new_snapshot';
  checked_decision_epoch: number;
  /**
   * @maxItems 25
   */
  violations: string[];
  checked_resource_ids: Identifier[];
  evidence: {
    [k: string]: unknown;
  };
}
/**
 * Internal trusted simulation input, never passed to Nemotron.
 */
export interface SimulationTickInput {
  schema_version: '1.1.0';
  run_id: Identifier;
  step_ms: number;
  seed: number;
  world: PhysicsWorld;
  due_faults_private: FaultInjection[];
  requested_action_ids: Identifier[];
}

export const CONTRACT_TYPE_NAMES = [
  'ActionCommand',
  'ActionStatus',
  'Checkpoint',
  'CoolingCurrent',
  'DependencyEdge',
  'EvaluationResult',
  'FaultInjection',
  'GpuCurrent',
  'HardwareSample',
  'Identifier',
  'Incident',
  'IncidentLink',
  'JobGpuAllocation',
  'JobSpec',
  'JobState',
  'NodeCurrent',
  'ObservedSnapshot',
  'PhysicsTickResult',
  'PhysicsWorld',
  'PlanCandidate',
  'ResourceSpec',
  'RunClock',
  'SafetyDecision',
  'SignalEvent',
  'SimulationTickInput',
  'TelemetryEvent'
] as const;

export type ContractTypeName = (typeof CONTRACT_TYPE_NAMES)[number];
