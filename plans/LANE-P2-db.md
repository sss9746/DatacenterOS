# P2 — current remaining work (2026-11-08)

The DB, real client, action details, leases, workflows and reported live pump integration exist. Start with **R2**: reject every start-time safety violation, including stale evidence. Support R0 provenance round-trip and R5 actual-agent recovery proof. P2-9 ingestion is optional after software proof; caller-kill Gate 2 is not full Gate 3.

**Current instructions:** [implementation tasks](IMPLEMENTATION-TASKS.md), [fixed scope](IMPLEMENTATION-SCOPE.md), [audited status](IMPLEMENTATION-STATUS.md). These replace the kickoff schedule and acceptance assumptions below. Ownership boundaries remain. Historical times, test counts, build-from-scratch tasks and old demo instructions below are retained for traceability, not current priorities.

---

## Archived kickoff plan

# Lane P2: SpacetimeDB + durable execution

**Owns:** `apps/db/` (SpacetimeDB TypeScript module), `packages/db-client/` (generated bindings + typed wrapper + mock), database publishing, identities and tokens.
**Branch:** `lane/p2-db`.
**Must not:** change physics rules, write LLM code or build React.
**Reads:** ARCHITECTURE §3, §6, §7; CONTRACTS §0 (especially §0.6, §0.8, §0.9) and kit §B–§C.

**SpacetimeDB is the only authoritative live state.** Physics computes the transitions; your reducers commit them.

## Setup (≈20 min, Windows PowerShell)
```powershell
node -v                                          # v22+
iwr https://windows.spacetimedb.com -useb | iex  # or the command shown on spacetimedb.com/install
spacetime --version                              # 2.x
spacetime login; spacetime login show
```

**Ask at the SpacetimeDB booth, and post the answers in `plans/status/P2.md`:**
1. Is the Maincloud URI `wss://maincloud.spacetimedb.com`?
2. What's the reducer time limit?
3. Can a TS module import a workspace package (bundling)?
4. Is there a hackathon credit?

**Databases:**
| Name | Where | Use |
|---|---|---|
| `dcos-dev` | Maincloud | Development |
| `dcos` | Maincloud | Live demo; publish only from a gate-passing commit |
| `dcos-eval` | Local (`spacetime start`) | Evaluation, if P4 needs it in the database |

## Design decisions (already made; don't re-debate them)
- **Private `world_state` table** (`run_id` PK, `world_json`, `version`) holds the full `PhysicsWorld`, including private faults and hidden state.
  - Each tick: load it → `step()` from `@dcos/physics` → write `world_after` back → **project** the observable parts into the public tables (`gpu_current`, `job_current`, `checkpoint`, …) and append telemetry/signals.
  - This is a private implementation detail; it is not a cross-lane contract.
- **Scheduled tick:** `tick_schedule` with `ScheduleAt.interval(1_000_000n)` (1 s wall) runs `advance_tick`, which advances `speed` logical steps of 1,000 ms (`configure_run` sets speed 1–5). It skips when paused. Missed intervals are **not** replayed.
- **Command ordering in a tick:** faults due → physics step → due action completions (revalidated) → epoch bump → commit.
- **Validate every JSON argument** with `validatePayload()` from `@dcos/contracts`. Reject with the stable `reason_code` strings from §0.7 plus `BAD_PAYLOAD`, `UNAUTHORIZED`, `COMMAND_KEY_COLLISION`, `STALE_FENCING_TOKEN`, `LEASE_HELD`.
- **Bundling fallback:** if `@dcos/physics` won't import in the module by **9:15 PM**, ask P1 to run `pnpm sync:physics`, which copies the source to `apps/db/src/physics/`. You commit that generated folder and never hand-edit it.

## Deliverables in order (‖ = parallel)
| ID | By | Task | Owns | Done when |
|---|---|---|---|---|
| **P2-0** | 8:15 PM | Setup above + booth questions | `plans/status/P2.md` | `spacetime login show` prints an identity |
| **P2-1** | 9:00 PM | Scaffold `apps/db` (`spacetime init --lang typescript`, package name `db`); a `run` table + `ping` reducer; **import `@dcos/physics`** and call `buildPreset` (stub OK until P1-3); publish `dcos-dev`; generate bindings into `packages/db-client/src/generated` (`spacetime generate --lang typescript --out-dir packages/db-client/src/generated --project-path apps/db`; check the flag name with `--help`) | `apps/db/**`, `packages/db-client/src/generated/**` | **Gate 0:** publish succeeds; `spacetime sql -s maincloud dcos-dev "SELECT * FROM run"` works; physics import decision recorded |
| **P2-2** ‖ | 9:00 PM | **`@dcos/db-client` wrapper + mock:** export the §0.6 functions. `createMockClient()` serves P1's `fixtures/gpu/*.json` and records calls (for P3/P4 before the DB is live). `connect({ uri, db, token })` wraps the generated bindings with typed subscription helpers: `onGpu`, `onJobs`, `onIncidents`, `onActions`, `onAgentEvents`, `onEvaluation` | `packages/db-client/src/**` (not `generated`) | P3 and P4 can `import { createMockClient } from '@dcos/db-client'` and render or plan against fixtures |
| **P2-3** | 10:45 PM | **Tier 1 tables** (CONTRACTS §0.8) + private `world_state` + `role_grant`; reducers `grant_role` (owner/admin) and `create_run(run_id, seed, preset_id)` (calls `buildPreset`, writes world_state, projects all public rows); `pause_run`, `configure_run` | `apps/db/src/{schema,run}.ts` | `create_run('run-demo-1',42,'gpu_demo_8')` → `SELECT COUNT(*) FROM gpu_current` = 65 (64 + gpu-real-0) and 3 rows in `job_current` |
| **P2-4** | 11:30 PM | **`advance_tick`** (scheduled) + `inject_fault(fault_json)` (admin; validates FaultInjection; stores it in private `fault_injection_truth` and in world_state's due faults). Keep `telemetry_recent` bounded (delete the oldest past 2,000 rows) | `apps/db/src/{tick,faults,projection}.ts` | **Gate 1:** pump-a degradation → r2–r4 `temp_c` rises in `gpu_current`; XID 79 → `signal_event` row + job-a `status` failed/restarting; the dashboard sees it live |
| **P2-5** | 1:00 AM | **Action ledger** (kit §6, §C): `request_action` (validate, payload hash, key collision check, fresh `evaluateSafety(toObserved(world), cmd, …)`; on deny, persist `failed` with violations), `claim_action` (lock the closure in sorted order, increment the fencing token), `start_action` (sets `due_sim_time_ms`, passes the command into `step` via `requested_action_ids`), completion inside `advance_tick`, `cancel_action`, `verify_action`, and `action_event` appended on every transition. Same key with the same payload returns the existing row | `apps/db/src/actions.ts` | Gate 2 script passes (P2-7) |
| **P2-6** ‖ | 1:15 AM | **Workflow + incidents:** `claim_workflow` / `heartbeat_workflow` / `update_workflow` (compare-and-swap on `version` + fencing token; workflow lease ≠ resource lease), `upsert_incident` (incident + symptom/resource links), `submit_plan`, `publish_agent_event` (with `tool_calls_json`, F-NV1) | `apps/db/src/{workflow,incidents}.ts` | Two workers can't both own one workflow; a stale fencing token is rejected |
| **P2-7** | 1:30 AM | **Gate 2 script** `apps/db/scripts/gate2.ts` (tsx + db-client): manual checkpoint goes through the full lifecycle; 10× retry → one checkpoint; a move onto r6 is denied with `DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT`; stale epoch → `STALE_DECISION_EPOCH`; a stale owner is rejected; killing the caller mid-checkpoint still lets it complete | `apps/db/scripts/**` | Script prints all PASS; P1 ticks Gate 2 |
| **P2-8** | 4:30 AM | **Prod + tokens:** publish `dcos`; mint identities with `POST /v1/identity` (admin, agent, gateway); `grant_role` each; post the tokens in team chat. Rehearse the offline fallback: `spacetime start` + `spacetime publish -s local dcos` on the demo laptop | `apps/db/scripts/bootstrap.ts` | P3 and P4 run against `dcos` with real tokens |
| **P2-9** | 8:00 AM (Gate 5) | **`ingest_observations`** (gateway role): validate TelemetryEvent/SignalEvent, dedupe `event_id`, enforce monotonic `source_seq`; apply `gpu-real-0` metrics to `gpu_current` (F-NV2) and `fan.*` to the fan sensor; opt-in demo rule (`configure_run`: `fan_drives_loop_a=true`) turns a sustained fan anomaly into a visible `cooling_pump_degradation` fault | `apps/db/src/ingest.ts` | The HW gateway's samples appear; duplicates are rejected |

## Debugging
- **Logs:** `spacetime logs -s maincloud dcos-dev`
- **SQL:** `spacetime sql -s maincloud dcos-dev "SELECT …"`
- **Schema changes after 9 PM are additive only.** Renaming or removing anything forces `--delete-data`, which wipes every row. On dev only: republish, rerun `bootstrap.ts` and `create_run`, regenerate bindings, and tell P3 and P4.

## Claude sub-agent prompts
- **P2-1:** "Scaffold the SpacetimeDB 2.x TypeScript module in `apps/db` per plans/LANE-P2-db.md P2-1. Prove `import { buildPreset } from '@dcos/physics'` bundles. Own only `apps/db/**` and `packages/db-client/src/generated/**`."
- **P2-2** (parallel with P2-1): "Build `packages/db-client` wrapper + `createMockClient()` per P2-2 and CONTRACTS §0.6, backed by `packages/physics/fixtures/gpu/*.json`. Own only `packages/db-client/src/**` except `generated/`."
- **P2-5 and P2-6** (parallel): each owns its own file(s) plus tests.
