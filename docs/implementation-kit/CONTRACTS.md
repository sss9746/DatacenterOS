# DataCenterOS shared contracts — freeze v1.0.0

**This file replaces the GPU-relevant portions of your earlier broad `CONTRACTS.md`.** The attached `contracts.schema.json` is the canonical cross-service **wire schema**; `example-payloads.json` contains five validated examples. No team member changes field names independently. All public JSON uses `snake_case` and `schema_version: "1.0.0"`.

## A. Cross-cutting rules

- **IDs**: opaque stable strings (e.g. `run-demo-1`, `gpu-r3-n1-0`). Never use array index or display name as an identity. A resource remains the same resource across simulated and hardware telemetry.
- **Units**: Celsius `degC`, watts `W`, SM clock `MHz`, vibration `g`, RPM `rpm`, duration `ms`, normalized score `ratio`, progress `work_units`. Sensor gateway converts before ingest. Metric names use documented DCGM symbols when modeled as DCGM telemetry.
- **Clock**: `sim_time_ms` is the run's logical time. `observed_unix_ms` is the source measurement timestamp. Leases use actual wall time. `source_seq` increases per source. `event_id` uniquely deduplicates telemetry/signal ingestion.
- **Source attribution**: `simulator | hardware | replay | dcgm` is required; sources must never be silently mixed or misrepresented as real GPUs.
- **Staleness**: `quality` indicates `good | estimated | stale | missing | invalid` (hardware uses its own allowed subset). Physical sensor data is never automatically accepted as a GPU/pump failure.
- **Versioning**: `resource.version` increments for material state changes; `run.decision_epoch` increments for safety-relevant changes. Per-tick gauge samples do not necessarily bump decision epochs. Commands compare expected versions before starting and committing.
- **Access**: `fault_injection_truth` and scenario future schedule are private; model tools cannot access them. Dashboard may be allowed to show *past selected injections to judges* separately, but those rows must not be included in the agent input.
- **Command keys**: stable, unique across retry attempts. Same key with a different payload must be rejected as a collision; never silently accept changed semantics under a reused key.
- **Authoritative state**: only SpacetimeDB reducer transactions mutate live system resources or jobs. Physics computes transitions; it is not a second database.

## B. Relational tables to implement in SpacetimeDB

These are logical field definitions and recommended primary/unique/index constraints. Convert to actual SpacetimeDB TypeScript native columns (`t.string`, `t.u64`, `t.f64`, `t.bool`, etc.) using installed SDK version. Use stringified JSON only for infrequently queried configuration/evidence. Denormalize a few read-only display fields where convenient; avoid duplicate *authoritative* state.

| Table | PK / unique / indexes | Essential columns | Visibility |
|---|---|---|---|
| `run` | `run_id` PK | `seed`, `status`, `sim_time_ms`, `tick_index`, `step_ms`, `wall_tick_ms`, `decision_epoch`, `paused`, `profile_version` | public |
| `resource` | `resource_id` PK; index `(run_id,kind)` and `parent_id` | `run_id`, `kind`, `parent_id`, `failure_domain_id`, `profile`, `config_json`, `current_status`, `version`, `enabled` | public |
| `dependency_edge` | `edge_id` PK; indexes `consumer_id`, `provider_id` | `run_id`, `consumer_id`, `provider_id`, `relation`, `weight` | public |
| `gpu_current` | `resource_id` PK | `run_id`, `node_id`, `availability`, `temp_c`, `sm_clock_mhz`, `power_w`, `power_limit_w`, `clocks_event_reasons`, `last_xid_code` (nullable), `last_seen_sim_ms`, `version` | public |
| `cooling_current` | `resource_id` PK | `run_id`, `operating_state` (observed/alarm-derived), `nominal_capacity_w`, `pump_power_w` (observed), `observed_capacity_estimate_w` (nullable), `version` | public |
| `node_current` | `resource_id` PK | `run_id`, `rack_id`, `availability`, `power_headroom_w`, `thermal_headroom_c`, `version` | public |
| `job_spec` | `job_id` PK | `run_id`, `gpus_required`, `placement_policy`, `compatible_node_ids_json`, `gpu_profile`, `priority`, `preemptible`, `checkpoint_supported`, `checkpoint_storage_id`, `checkpoint_duration_ms`, `restart_duration_ms`, `checkpoint_interval_ms`, `total_work_units`, `work_rate_per_gpu_per_sim_s` | public |
| `job_current` | `job_id` PK; index `(run_id,status)` | `run_id`, `status`, `progress_work_units`, `durable_work_units`, `latest_checkpoint_id`, `last_update_sim_time_ms`, `version` | public |
| `job_gpu_allocation` | composite unique `(job_id,gpu_id)`; unique GPU assignment for active jobs enforced via reducer | `run_id`, `job_id`, `gpu_id`, `since_sim_time_ms` | public |
| `checkpoint` | `checkpoint_id` PK; index `job_id` | `run_id`, `job_id`, `storage_resource_id`, `status`, `progress_work_units`, `command_key`, `requested_sim_time_ms`, `complete_sim_time_ms`, `accessible` | public |
| `telemetry_recent` | `event_id` PK; indexes `(resource_id,sim_time_ms)` | `run_id`, `resource_id`, `source_kind`, `source_id`, `source_seq`, `metric`, `value`, `unit`, `quality`, `sim_time_ms`, `observed_unix_ms`, `labels_json` | public (bounded retention) |
| `signal_event` | `event_id` PK; indexes `(resource_id,sim_time_ms)` | `run_id`, `resource_id`, `event_type`, `xid_code`, `severity`, `source_kind`, `source_id`, `source_seq`, `sim_time_ms`, `evidence_json` | public |
| `symptom` | `symptom_id` PK; index `run_id` | `run_id`, `resource_id`, `first_seen_sim_ms`, `last_seen_sim_ms`, `kind`, `severity`, `evidence_event_ids_json`, `status` | public |
| `incident` | `incident_id` PK; index `(run_id,state)` | `run_id`, `state`, `severity`, `title`, `hypothesis`, `confidence`, `opened_sim_time_ms`, `updated_sim_time_ms`, `version` | public |
| `incident_symptom` | unique `(incident_id,symptom_id)` | `run_id`, `incident_id`, `symptom_id`, `reason` | public |
| `incident_resource` | unique `(incident_id,resource_id)` | `run_id`, `incident_id`, `resource_id`, `reason` | public |
| `workflow` | `workflow_id` PK; index `(run_id,stage)` | `run_id`, `stage`, `state`, `plan_id`, `current_command_key`, `last_processed_event_seq`, `attempt`, `lease_owner`, `lease_expires_unix_ms`, `fencing_token`, `updated_at_unix_ms`, `version` | owner/service-readable; publish safe view |
| `workflow_incident` | unique `(workflow_id,incident_id)` | `run_id`, `workflow_id`, `incident_id` | public |
| `plan` | `plan_id` PK; index `workflow_id` | `run_id`, `workflow_id`, `based_on_decision_epoch`, `assumptions_json`, `expected_metrics_json`, `status`, `explanation` | public |
| `action` | `action_id` PK, `command_key` UNIQUE; indexes `(workflow_id,status)`, `(run_id,status)` | `run_id`, `workflow_id`, `plan_id`, `command_key`, `operation`, `target_resource_id`, `job_id`, `payload_hash`, `args_json`, `expected_versions_json`, `expected_decision_epoch`, `due_sim_time_ms`, `status`, `attempt`, `lease_token`, `result_json`, `reason_code`, `version` | public safe projection; service can access full |
| `action_incident` | unique `(action_id,incident_id)` | `run_id`, `action_id`, `incident_id` | public |
| `action_dependency` | unique `(action_id,depends_on_action_id)` | `action_id`, `depends_on_action_id` | public |
| `action_event` | `action_event_id` PK; index `command_key` | `run_id`, `action_id`, `command_key`, `status`, `sim_time_ms`, `observed_unix_ms`, `reason_code`, `detail_json` | public |
| `resource_lease` | `resource_id` PK | `run_id`, `action_id`, `workflow_id`, `expires_at_unix_ms`, `fencing_token` | service-readable; optional public safe view |
| `agent_event` | `agent_event_id` PK; index `workflow_id` | `run_id`, `workflow_id`, `incident_id`, `stage`, `summary`, `evidence_ids_json`, `sim_time_ms`, `observed_unix_ms` | public |
| `evaluation_result` | unique `(scenario_id,policy,seed)` | `run_id`, `scenario_id`, `policy`, `seed`, `metrics_json`, `policy_version`, `physics_profile_version` | public |
| `fault_injection_truth` | `fault_id` PK; index `(run_id,start_sim_time_ms)` | full private `FaultInjection` payload; actual active state | **private** |
| `hardware_sensor_mapping` | `sensor_id` PK | `resource_id`, `calibration_id`, `authorized_source`, `last_source_seq`, `last_observed_unix_ms` | **private** |
| `tick_schedule` | scheduled primary key | `scheduled_at` configured with SpacetimeDB `onSchedule` | **private** |

**Indexes and joins:** SpacetimeDB uses explicit field/composite indexes; verify supported key types in the installed SDK. `u64` IDs are fine for internal auto-increment row keys but all service boundary IDs remain stable opaque strings. If composite unique keys aren't directly supported for a chosen SDK schema, enforce uniqueness transactionally and optionally store canonical concatenated unique keys.

**MVP simplification:** `gpu_current`, `node_current`, `job_current` are small bounded current-state tables; historical full metric retention is optional. Keep private truth isolated from `get_incident_evidence` and all agent subscriptions.

## C. Reducer / service command signatures (freeze these names)

These are **logical application signatures**, not copy-paste claims about exact generated TypeScript binding method casing. Implement them as SpacetimeDB reducers or service wrappers over reducers; generated bindings determine exact call spelling.

```ts
// Admin / judge (authorized caller only)
create_run(run_id: string, seed: number, preset_id: string): void
configure_run(run_id: string, config_json: string): void
pause_run(run_id: string, paused: boolean): void
inject_fault(fault_json: string): void                  // validates FaultInjection

// System-owned, scheduled / ingestion
advance_tick(schedule_row: TickScheduleRow): void       // scheduled, not browser callable
ingest_observations(batch_json: string): void            // TelemetryEvent[] / SignalEvent[]

// Orchestrator, compare-and-swap workflow state
claim_workflow(workflow_id: string, worker_id: string,
  expected_version: number, lease_ms: number): void
heartbeat_workflow(workflow_id: string, worker_id: string,
  fencing_token: bigint, lease_ms: number): void
update_workflow(workflow_id: string, expected_version: number,
  fencing_token: bigint, stage: string, state_json: string): void
upsert_incident(incident_json: string, links_json: string): void
submit_plan(plan_json: string): void
request_action(action_command_json: string): void
claim_action(command_key: string, expected_action_version: number,
  worker_id: string): void
start_action(command_key: string, fencing_token: bigint): void
cancel_action(command_key: string, reason_code: string,
  fencing_token: bigint): void
verify_action(command_key: string, evidence_json: string): void
publish_agent_event(agent_event_json: string): void

// Results / benchmark
publish_evaluation_result(result_json: string): void
```

### Reducer implementation invariants

- `inject_fault` validates target resource exists and is valid for that fault kind; do not allow contradictory physical topology mutations via injection.
- `ingest_observations` rejects missing authorization, source mismatch, malformed units/metric, duplicate event ID or nonmonotonic source sequence; batch inserts atomically.
- `submit_plan` writes proposal only; `request_action` runs **fresh** safety check and rejects bad `decision_epoch`/resource versions.
- `claim_action` grabs the *entire* affected resource closure in a single sorted transaction, not only the primary GPU. For `migrate_restart`, lock job, source GPU set, destination GPU set, and affected rack/node reservation records. Build the lock set *inside the trusted reducer*, not from user-supplied IDs.
- `start_action` does not complete a checkpoint in one transaction. It creates `checkpoint(status='writing')` and assigns `due_sim_time_ms`; later `advance_tick` finishes it iff resource/checkpoint conditions remain valid.
- On completion of `migrate_restart`, allocation is all-or-nothing; no duplicate GPU assignment. `checkpoint` and `migration` are separate ledger commands connected by `action_dependency`.
- Reject `command_key` collisions where `payload_hash` differs. Retrying the same command returns the persisted record, regardless of whether a network timeout occurred.
- Resource `fencing_token` is monotonically incremented for each lease acquisition and checked for delayed work. **Separate short-lived `workflow` worker leases from durable `resource_lease` reservations held by running simulator commands.** Agent process death may expire the workflow lease but must not release a running checkpoint reservation. Lease expiry by itself does not undo an already-running real-world effect.
- Replan on new relevant `decision_epoch` only; mark old proposed actions superseded and cancel only safe-to-cancel ones. At delayed completion, validate the **affected resources and operation-specific prerequisites** (not every unrelated global epoch change). A completed checkpoint remains valid even if its downstream migration plan becomes stale.

## D. Simulation and agent integration types

The canonical JSON Schema contains these `#/$defs` types:

`RunClock`, `ResourceSpec`, `DependencyEdge`, `GpuCurrent`, `NodeCurrent`, `CoolingCurrent`, `JobSpec`, `JobState`, `JobGpuAllocation`, `Checkpoint`, `ObservedSnapshot`, `PhysicsWorld`, `SimulationTickInput`, `PhysicsTickResult`, `TelemetryEvent`, `SignalEvent`, `FaultInjection`, `Incident`, `IncidentLink`, `PlanCandidate`, `ActionCommand`, `ActionStatus`, `SafetyDecision`, `HardwareSample`, `EvaluationResult`.

- **Simulation -> DB:** `SimulationTickInput` (containing private `PhysicsWorld`) -> `PhysicsTickResult` (containing `world_after`, `TelemetryEvent[]`, `SignalEvent[]`, completed/failed commands, and epoch/version updates). The `PhysicsWorld.active_faults_private`, `hidden_physics_state_json`, and `due_faults_private` fields are available **only** to trusted simulation code, never to planning agents. The agent gets `ObservedSnapshot` only.
- **Agent -> DB:** `Incident`, links, `PlanCandidate`, `ActionCommand`, `ActionStatus` readers, `agent_event` summaries. `ActionCommand` does **not** contain a fencing token: the reducer assigns the token at claim time and stores it in the ledger/lease.
- **Hardware -> gateway:** `HardwareSample` only; gateway produces `TelemetryEvent` with a resource mapping and the current simulation clock.
- **Benchmark -> UI:** `EvaluationResult`, same schema for all three policies.

### Example: simulator GPU temperature observation

```json
{
  "schema_version": "1.0.0",
  "event_id": "evt-r1-00081",
  "run_id": "run-demo-1",
  "resource_id": "gpu-r3-n1-0",
  "source_kind": "simulator",
  "source_id": "sim-engine-1",
  "source_seq": 81,
  "observed_unix_ms": 1794091200000,
  "sim_time_ms": 43000,
  "metric": "DCGM_FI_DEV_GPU_TEMP_CELSIUS",
  "value": 84.2,
  "unit": "degC",
  "quality": "estimated",
  "labels": {"profile": "demo_gpu", "hardware_backed": "false"}
}
```

Note: `source_kind=simulator` should normally use `quality=estimated` rather than implying a measured real NVIDIA GPU temperature. For demo dashboards, label the source explicitly. Physical fan fields should use `metric='fan.vibration_rms_g'`/`unit='g'`; their values must not be passed off as DCGM GPU counters.

### Example: actionable safety decision

```json
{
  "schema_version": "1.0.0", "run_id": "run-demo-1", "plan_id": "plan-2",
  "action_id": "act-13", "decision": "deny", "checked_decision_epoch": 6,
  "violations": ["DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT"],
  "checked_resource_ids": ["rack-r6", "node-r6-n1", "job-a"],
  "evidence": {"required_headroom_c": 7.0, "available_headroom_c": 2.0}
}
```

## E. Owner/implementer and handoff checklist

| Interface | Owner | Reviewer/consumer | Done when |
|---|---|---|---|
| `step()` and `simulatePlan()` | Software 1 | Software 2 + 3 + 4 | cross-run deterministic tests, stable output fixtures |
| `contracts.schema.json` and `CONTRACTS.md` | Software 1 (schema steward) | **all four** | example payload validation succeeds; freeze tag published |
| tables + reducers + bindings | Software 2 | Software 3 | DB starts, generated SDK compiles, idempotent command test passes |
| workflow, planning, tool calls | Software 3 | Software 2 | two incidents and resume demonstrated |
| dashboard subscriptions | Software 4 | Software 2 + 3 | 8x8 heat map + job status from actual DB data |
| benchmark harness, scoreboard + live judge UI | Software 4 | Software 1 + 2 + 3 | 3 policies on matching seeds; real result events; live subscriptions |
| `HardwareSample` -> `TelemetryEvent` | All four (optional shared sprint) | Software 2 (gateway contract) | sample validated and accepted by gateway; simulated replay fallback |

**Contract change rule:** submit one PR updating schema + fixtures + generated TS types + reducer/interface tests. Never rename or overload a field informally in chat; the next person should be able to integrate by reading this contract alone.
