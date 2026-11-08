# P2-3: Tier 1 tables + `create_run`
**Due:** 10:45 PM · **Status:** ☐
**Owns:** `apps/db/src/schema.ts`, `apps/db/src/run.ts`, `apps/db/src/auth.ts`

## Goal
`create_run` builds the demo world from physics and projects it into public tables; roles gate every write.

## Tables (CONTRACTS §0.8 Tier 1, columns from §B)
`run`, `resource`, `dependency_edge`, `gpu_current`, `node_current`, `cooling_current`, `job_spec`, `job_current`, `job_gpu_allocation`, `checkpoint`, `telemetry_recent`, `signal_event`, `symptom`, `incident`, `incident_symptom`, `incident_resource`, `workflow`, `workflow_incident`, `plan`, `action`, `action_dependency`, `action_event`, `resource_lease`, `agent_event` (+ `tool_calls_json`), `evaluation_result`.
**Private:** `world_state` (`run_id` PK, `world_json`, `version`), `fault_injection_truth`, `tick_schedule`, `role_grant` (`identity` → `role`).
Define them all now, even if later checkpoints fill them: adding tables after 9 PM is fine but renames force `--delete-data`.

## Reducers
- `grant_role(identity, role)`: owner or admin only. Module owner is bootstrapped as admin.
- `create_run(run_id, seed, preset_id)`: admin; `buildPreset` → write `world_state` → project every public row.
- `pause_run(run_id, paused)`, `configure_run(run_id, config_json)` (speed 1–5, later `fan_drives_loop_a`): admin.
- One `projection.ts`-style function `projectWorld(ctx, world)` reused by the tick in P2-4.

## Done when
- [ ] `create_run('run-demo-1', 42, 'gpu_demo_8')` → `SELECT COUNT(*) FROM gpu_current` = **65** (64 + `gpu-real-0`)
- [ ] 3 rows in `job_current`; allocations match CONTRACTS §0.3 (job-a r2+r3, job-b r4, job-c r6)
- [ ] Non-admin identity calling `create_run` → `UNAUTHORIZED`
- [ ] No private field visible in any public table
- [ ] Bindings regenerated; P3/P4 told

## Blocked by
P1's `buildPreset` (P1-3, due 10:00 PM). If late, build against P1's fixture snapshot to keep moving.

## Architect notes (Codex)

## Implementation report (Claude)
