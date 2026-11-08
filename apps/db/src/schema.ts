// All tables for the DataCenterOS module (CONTRACTS §0.8 Tier 1 + §B columns), defined up front so
// later checkpoints only add rows/reducers: after 9 PM schema changes must be additive.
//
// Column conventions:
// - snake_case names, matching @dcos/contracts (generated client fields are camelCase).
// - sim-time ms, versions, epochs, counters: u32 (JS number; u32 ms ≈ 49 sim-days).
// - wall-clock unix ms and source sequence numbers: f64 (exact integers to 2^53, stays a JS number).
// - fencing tokens: u64 (bigint, CONTRACTS §C).
// - contract `null` → t.option(...) (undefined in TS). Objects/arrays → `*_json` strings.
// - Composite-unique pairs (§B) use a canonical concatenated string PK, e.g. `job-a/gpu-r2-n1-0`.
//
// Visibility: everything public except world_state, fault_injection_truth, tick_schedule, role_grant.
import { schema, table, t, type InferSchema, type ReducerCtx } from 'spacetimedb/server';

// ---------------------------------------------------------------------------------------------
// Run + topology
// ---------------------------------------------------------------------------------------------

export const run = table(
  { name: 'run', public: true },
  {
    run_id: t.string().primaryKey(),
    seed: t.u32(),
    status: t.string(),
    sim_time_ms: t.u32(),
    tick_index: t.u32(),
    step_ms: t.u32(),
    wall_tick_ms: t.u32(),
    decision_epoch: t.u32(),
    paused: t.bool(),
    speed: t.u8(),
    profile_version: t.string(),
  }
);

export const resource = table(
  {
    name: 'resource',
    public: true,
    indexes: [{ accessor: 'by_run_kind', algorithm: 'btree', columns: ['run_id', 'kind'] }],
  },
  {
    resource_id: t.string().primaryKey(),
    run_id: t.string(),
    kind: t.string(),
    parent_id: t.option(t.string()),
    failure_domain_id: t.string(),
    profile: t.string(),
    config_json: t.string(),
    current_status: t.string(),
    version: t.u32(),
    enabled: t.bool(),
  }
);

export const dependency_edge = table(
  { name: 'dependency_edge', public: true },
  {
    edge_id: t.string().primaryKey(),
    run_id: t.string(),
    consumer_id: t.string().index('btree'),
    provider_id: t.string().index('btree'),
    relation: t.string(),
    weight: t.f64(),
  }
);

// ---------------------------------------------------------------------------------------------
// Current state (projected from the private world each tick)
// ---------------------------------------------------------------------------------------------

export const gpu_current = table(
  { name: 'gpu_current', public: true },
  {
    resource_id: t.string().primaryKey(),
    run_id: t.string(),
    node_id: t.string(),
    availability: t.string(),
    temp_c: t.f64(),
    sm_clock_mhz: t.f64(),
    power_w: t.f64(),
    power_limit_w: t.f64(),
    clocks_event_reasons: t.u32(),
    last_xid_code: t.option(t.u32()),
    last_seen_sim_ms: t.u32(),
    version: t.u32(),
  }
);

export const node_current = table(
  { name: 'node_current', public: true },
  {
    resource_id: t.string().primaryKey(),
    run_id: t.string(),
    rack_id: t.string(),
    availability: t.string(),
    power_headroom_w: t.f64(),
    thermal_headroom_c: t.f64(),
    version: t.u32(),
  }
);

/** One row per pump and one per loop (CONTRACTS §0.11 #9). */
export const cooling_current = table(
  { name: 'cooling_current', public: true },
  {
    resource_id: t.string().primaryKey(),
    run_id: t.string(),
    operating_state: t.string(),
    nominal_capacity_w: t.f64(),
    pump_power_w: t.f64(),
    observed_capacity_estimate_w: t.option(t.f64()),
    version: t.u32(),
  }
);

// ---------------------------------------------------------------------------------------------
// Jobs + checkpoints
// ---------------------------------------------------------------------------------------------

export const job_spec = table(
  { name: 'job_spec', public: true },
  {
    job_id: t.string().primaryKey(),
    run_id: t.string(),
    gpus_required: t.u32(),
    placement_policy: t.string(),
    compatible_node_ids_json: t.string(),
    gpu_profile: t.string(),
    priority: t.i32(),
    preemptible: t.bool(),
    checkpoint_supported: t.bool(),
    checkpoint_storage_id: t.option(t.string()),
    checkpoint_duration_ms: t.u32(),
    restart_duration_ms: t.u32(),
    checkpoint_interval_ms: t.u32(),
    total_work_units: t.f64(),
    work_rate_per_gpu_per_sim_s: t.f64(),
  }
);

export const job_current = table(
  {
    name: 'job_current',
    public: true,
    indexes: [{ accessor: 'by_run_status', algorithm: 'btree', columns: ['run_id', 'status'] }],
  },
  {
    job_id: t.string().primaryKey(),
    run_id: t.string(),
    status: t.string(),
    progress_work_units: t.f64(),
    durable_work_units: t.f64(),
    latest_checkpoint_id: t.option(t.string()),
    last_update_sim_time_ms: t.u32(),
    version: t.u32(),
  }
);

/** `allocation_id` = `${job_id}/${gpu_id}` (composite unique, §B). */
export const job_gpu_allocation = table(
  { name: 'job_gpu_allocation', public: true },
  {
    allocation_id: t.string().primaryKey(),
    run_id: t.string(),
    job_id: t.string().index('btree'),
    gpu_id: t.string().index('btree'),
    since_sim_time_ms: t.u32(),
  }
);

export const checkpoint = table(
  { name: 'checkpoint', public: true },
  {
    checkpoint_id: t.string().primaryKey(),
    run_id: t.string(),
    job_id: t.string().index('btree'),
    storage_resource_id: t.string(),
    status: t.string(),
    progress_work_units: t.f64(),
    command_key: t.string(),
    requested_sim_time_ms: t.u32(),
    complete_sim_time_ms: t.option(t.u32()),
    accessible: t.bool(),
  }
);

// ---------------------------------------------------------------------------------------------
// Telemetry + signals (append; telemetry_recent is bounded to 2,000 rows by the tick, P2-4)
// ---------------------------------------------------------------------------------------------

export const telemetry_recent = table(
  {
    name: 'telemetry_recent',
    public: true,
    indexes: [
      { accessor: 'by_resource_time', algorithm: 'btree', columns: ['resource_id', 'sim_time_ms'] },
    ],
  },
  {
    event_id: t.string().primaryKey(),
    run_id: t.string(),
    resource_id: t.string(),
    source_kind: t.string(),
    source_id: t.string(),
    source_seq: t.f64(),
    metric: t.string(),
    value: t.f64(),
    unit: t.string(),
    quality: t.string(),
    sim_time_ms: t.u32(),
    observed_unix_ms: t.f64(),
    labels_json: t.string(),
  }
);

export const signal_event = table(
  {
    name: 'signal_event',
    public: true,
    indexes: [
      { accessor: 'by_resource_time', algorithm: 'btree', columns: ['resource_id', 'sim_time_ms'] },
    ],
  },
  {
    event_id: t.string().primaryKey(),
    run_id: t.string(),
    resource_id: t.string(),
    event_type: t.string(),
    xid_code: t.option(t.u32()),
    severity: t.string(),
    source_kind: t.string(),
    source_id: t.string(),
    source_seq: t.f64(),
    sim_time_ms: t.u32(),
    observed_unix_ms: t.f64(),
    message: t.string(),
    evidence_json: t.string(),
  }
);

// ---------------------------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------------------------

export const symptom = table(
  { name: 'symptom', public: true },
  {
    symptom_id: t.string().primaryKey(),
    run_id: t.string().index('btree'),
    resource_id: t.string(),
    first_seen_sim_ms: t.u32(),
    last_seen_sim_ms: t.u32(),
    kind: t.string(),
    severity: t.string(),
    evidence_event_ids_json: t.string(),
    status: t.string(),
  }
);

export const incident = table(
  {
    name: 'incident',
    public: true,
    indexes: [{ accessor: 'by_run_state', algorithm: 'btree', columns: ['run_id', 'state'] }],
  },
  {
    incident_id: t.string().primaryKey(),
    run_id: t.string(),
    state: t.string(),
    severity: t.string(),
    title: t.string(),
    hypothesis: t.option(t.string()),
    confidence: t.f64(),
    opened_sim_time_ms: t.u32(),
    updated_sim_time_ms: t.u32(),
    version: t.u32(),
  }
);

/** `link_id` = `${incident_id}/${symptom_id}`. */
export const incident_symptom = table(
  { name: 'incident_symptom', public: true },
  {
    link_id: t.string().primaryKey(),
    run_id: t.string(),
    incident_id: t.string().index('btree'),
    symptom_id: t.string().index('btree'),
    reason: t.string(),
  }
);

/** `link_id` = `${incident_id}/${resource_id}`. */
export const incident_resource = table(
  { name: 'incident_resource', public: true },
  {
    link_id: t.string().primaryKey(),
    run_id: t.string(),
    incident_id: t.string().index('btree'),
    resource_id: t.string().index('btree'),
    reason: t.string(),
  }
);

// ---------------------------------------------------------------------------------------------
// Workflows + plans (P2-6)
// ---------------------------------------------------------------------------------------------

export const workflow = table(
  {
    name: 'workflow',
    public: true,
    indexes: [{ accessor: 'by_run_stage', algorithm: 'btree', columns: ['run_id', 'stage'] }],
  },
  {
    workflow_id: t.string().primaryKey(),
    run_id: t.string(),
    stage: t.string(),
    state_json: t.string(),
    plan_id: t.option(t.string()),
    current_command_key: t.option(t.string()),
    last_processed_event_seq: t.f64(),
    attempt: t.u32(),
    lease_owner: t.option(t.string()),
    lease_expires_unix_ms: t.f64(),
    fencing_token: t.u64(),
    updated_at_unix_ms: t.f64(),
    version: t.u32(),
  }
);

/** `link_id` = `${workflow_id}/${incident_id}`. */
export const workflow_incident = table(
  { name: 'workflow_incident', public: true },
  {
    link_id: t.string().primaryKey(),
    run_id: t.string(),
    workflow_id: t.string().index('btree'),
    incident_id: t.string().index('btree'),
  }
);

export const plan = table(
  { name: 'plan', public: true },
  {
    plan_id: t.string().primaryKey(),
    run_id: t.string(),
    workflow_id: t.string().index('btree'),
    based_on_decision_epoch: t.u32(),
    incident_ids_json: t.string(),
    command_keys_json: t.string(),
    assumptions_json: t.string(),
    expected_metrics_json: t.string(),
    status: t.string(),
    explanation: t.string(),
  }
);

// ---------------------------------------------------------------------------------------------
// Action ledger (P2-5)
// ---------------------------------------------------------------------------------------------

export const action = table(
  {
    name: 'action',
    public: true,
    indexes: [
      { accessor: 'by_workflow_status', algorithm: 'btree', columns: ['workflow_id', 'status'] },
      { accessor: 'by_run_status', algorithm: 'btree', columns: ['run_id', 'status'] },
    ],
  },
  {
    action_id: t.string().primaryKey(),
    command_key: t.string().unique(),
    run_id: t.string(),
    workflow_id: t.string(),
    plan_id: t.string(),
    operation: t.string(),
    target_resource_id: t.string(),
    job_id: t.option(t.string()),
    payload_hash: t.string(),
    args_json: t.string(),
    /** Tier 2 `action_incident` stand-in (CONTRACTS §0.8). */
    incident_ids_json: t.string(),
    depends_on_command_keys_json: t.string(),
    expected_versions_json: t.string(),
    expected_decision_epoch: t.u32(),
    requested_sim_time_ms: t.u32(),
    due_sim_time_ms: t.option(t.u32()),
    status: t.string(),
    attempt: t.u32(),
    claimed_by: t.option(t.string()),
    lease_token: t.u64(),
    result_json: t.string(),
    reason_code: t.option(t.string()),
    updated_sim_time_ms: t.u32(),
    version: t.u32(),
  }
);

/** `dep_id` = `${action_id}/${depends_on_action_id}`. */
export const action_dependency = table(
  { name: 'action_dependency', public: true },
  {
    dep_id: t.string().primaryKey(),
    run_id: t.string(),
    action_id: t.string().index('btree'),
    depends_on_action_id: t.string().index('btree'),
  }
);

export const action_event = table(
  { name: 'action_event', public: true },
  {
    action_event_id: t.u64().primaryKey().autoInc(),
    run_id: t.string(),
    action_id: t.string(),
    command_key: t.string().index('btree'),
    status: t.string(),
    sim_time_ms: t.u32(),
    observed_unix_ms: t.f64(),
    reason_code: t.option(t.string()),
    detail_json: t.string(),
  }
);

export const resource_lease = table(
  { name: 'resource_lease', public: true },
  {
    resource_id: t.string().primaryKey(),
    run_id: t.string(),
    action_id: t.string(),
    workflow_id: t.string(),
    expires_at_unix_ms: t.f64(),
    fencing_token: t.u64(),
  }
);

// ---------------------------------------------------------------------------------------------
// Agent feed (F-NV1) + evaluation
// ---------------------------------------------------------------------------------------------

export const agent_event = table(
  { name: 'agent_event', public: true },
  {
    agent_event_id: t.string().primaryKey(),
    run_id: t.string().index('btree'),
    workflow_id: t.option(t.string()),
    incident_id: t.option(t.string()),
    stage: t.string(),
    summary: t.string(),
    evidence_ids_json: t.string(),
    tool_calls_json: t.string(),
    actor: t.string(),
    sim_time_ms: t.u32(),
    observed_unix_ms: t.f64(),
  }
);

/** `result_id` = `${scenario_id}/${policy}/${seed}` (composite unique, §B). */
export const evaluation_result = table(
  { name: 'evaluation_result', public: true },
  {
    result_id: t.string().primaryKey(),
    run_id: t.string(),
    scenario_id: t.string(),
    policy: t.string(),
    seed: t.u32(),
    metrics_json: t.string(),
    policy_version: t.string(),
    physics_profile_version: t.string(),
  }
);

// ---------------------------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------------------------

/** Full PhysicsWorld (incl. private faults + hidden state). Never public, never in agent input. */
export const world_state = table(
  { name: 'world_state' },
  {
    run_id: t.string().primaryKey(),
    preset_id: t.string(),
    seed: t.u32(),
    world_json: t.string(),
    version: t.u32(),
    /** RunConfig JSON (`fan_drives_loop_a`, …); `speed` is mirrored on `run`. */
    config_json: t.string(),
  }
);

export const fault_injection_truth = table(
  {
    name: 'fault_injection_truth',
    indexes: [
      { accessor: 'by_run_start', algorithm: 'btree', columns: ['run_id', 'start_sim_time_ms'] },
    ],
  },
  {
    fault_id: t.string().primaryKey(),
    run_id: t.string(),
    target_resource_id: t.string(),
    kind: t.string(),
    start_sim_time_ms: t.u32(),
    fault_json: t.string(),
    /** true once advance_tick has handed it to physics (due_faults_private); see faults.ts. */
    active: t.bool(),
  }
);

/** Drives `advance_tick` (P2-4) once per wall second per run. */
export const tick_schedule = table(
  { name: 'tick_schedule' },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
    run_id: t.string(),
  }
);

/** CONTRACTS §0.9: identity → role (`admin` | `agent` | `gateway`). */
export const role_grant = table(
  { name: 'role_grant' },
  {
    identity: t.identity().primaryKey(),
    role: t.string(),
    granted_by: t.identity(),
  }
);

const spacetimedb = schema({
  run,
  resource,
  dependency_edge,
  gpu_current,
  node_current,
  cooling_current,
  job_spec,
  job_current,
  job_gpu_allocation,
  checkpoint,
  telemetry_recent,
  signal_event,
  symptom,
  incident,
  incident_symptom,
  incident_resource,
  workflow,
  workflow_incident,
  plan,
  action,
  action_dependency,
  action_event,
  resource_lease,
  agent_event,
  evaluation_result,
  world_state,
  fault_injection_truth,
  tick_schedule,
  role_grant,
});

export default spacetimedb;
export type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
