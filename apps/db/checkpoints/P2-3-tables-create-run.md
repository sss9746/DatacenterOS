# P2-3: Tier 1 tables + `create_run`
**Due:** 10:45 PM · **Status:** ☑
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
- [ ] `create_run('run-demo-1', 42, 'gpu_demo_8')` → `SELECT COUNT(*) FROM gpu_current` = **65** (64 + `gpu-real-0`). *Was 65 with the stand-in preset; with P1's real `buildPreset` it is **64** on dev and prod, because P1 leaves `gpu-real-0` out on purpose. P2-9 ingest creates that row from the first nvidia-smi sample.*
- [x] 3 rows in `job_current`; allocations match CONTRACTS §0.3 (job-a r2+r3, job-b r4, job-c r6)
- [x] Non-admin identity calling `create_run` → `UNAUTHORIZED`
- [x] No private field visible in any public table
- [x] Bindings regenerated; [x] P3/P4 told (both run against the live tables)

## Blocked by
P1's `buildPreset` (P1-3, due 10:00 PM). If late, build against P1's fixture snapshot to keep moving.

## Architect notes (Codex)
Review of the uncommitted P2-3 diff (codex exec, read-only):
- [P1] A second run_id would hijack the first run's rows: preset IDs are global PKs and projection ignored `run_id`. **Fixed:** one run per database (`create_run` with a different id → `INVALID_TRANSITION`; the same id still resets), and `projectWorld` throws if a row belongs to another run. Run-scoped keys were rejected because they would break the frozen §0.3 IDs. Verified live: `create_run run-demo-2` → rejected; `run-demo-1` resets to 65 GPUs.
- [P2] `workflow` / `resource_lease` are public, but §B says service-readable plus a safe view. **Kept public, on purpose (Kaushik/Codex may overrule before P2-6):** fencing tokens are monotonic counters, not secrets, so hiding them doesn't make them unguessable. Authorization comes from `role_grant` (agent role), not from secrecy. P3's `getWorkflow` / `listOpenWorkflows` already read `fencing_token` via subscription, and the UI shows workflow stage and locks. The columns hold no fault truth.

## Implementation report (Claude)
> **Update 2026-11-08:** the `preset.ts` stand-in described below is gone. P1's real `buildPreset` / `step` were merged in P2-4, so `gpu_current` now has 64 rows and `gpu-real-0` comes from P2-9 ingest.

**Files** (`apps/db/src/`)
- `schema.ts`: all 25 Tier 1 tables + private `world_state`, `fault_injection_truth`, `tick_schedule`, `role_grant`. `Ctx` type. Column conventions are in the header comment: sim ms / versions u32, unix ms + `source_seq` f64, fencing tokens u64, contract `null` → `t.option`, objects → `*_json`, composite-unique pairs → concatenated string PK (`job-a/gpu-r2-n1-0`). Columns that later checkpoints need were added now so they don't have to be added to existing tables later: `plan.incident_ids_json` / `command_keys_json`; `action.incident_ids_json` / `depends_on_command_keys_json` / `requested_sim_time_ms` / `updated_sim_time_ms` / `claimed_by`; `signal_event.message`; `agent_event.actor` / `tool_calls_json`; `world_state.preset_id` / `seed` / `config_json`; `run_id` on `action_dependency`.
- `auth.ts`: `init` grants the owner `admin`; `grant_role(identity, role)` (admin; `""` revokes; an admin can't demote itself); `requireRole(ctx, …)` (admin and scheduled calls always pass); `reject(code, msg)` throws `SenderError("CODE: msg")` for db-client's `parseDbError`.
- `run.ts`: `create_run` (admin; validates `run_id` with `validatePayload('Identifier')` and the world with `validatePayload('PhysicsWorld')`; **calling it again resets the run**: every run-scoped row in every table is deleted first), `pause_run`, `configure_run` (`{speed 1..5, fan_drives_loop_a}`, unknown keys rejected, merged into `world_state.config_json`, `speed` mirrored on `run`). Exports `loadWorld` / `saveWorld` / `loadConfig` for P2-4.
- `projection.ts`: `projectWorld(ctx, world)` reads only `world.observable`. It upserts rows field by field and writes only the ones that changed. Full-set tables drop this run's rows that are no longer in the world; checkpoints are only upserted (they are history).
- `preset.ts` + `preset/gpu_demo_8.observed.json`: **stand-in for `buildPreset`**, built from P1's fixture (byte-identical to `origin/lane/p1-sim` @ `2e641cd`), patched to v1.1.1: clock 600000 and checkpoints at 60000 / 540000 (§0.12 #2); `node-real-0` + `gpu-real-0` hosted on it (§0.11 #4); loop rows in `cooling_current` (§0.11 #9); a placeholder `gpu-real-0` `gpu_current` row (`unreachable` until the first nvidia-smi sample). Delete both files when P1-3 lands; there is one `TODO(P1-3)` call site in `run.ts`.
- `tick.ts`: `advance_tick` bound to `tick_schedule` now (empty body), so the scheduled-table binding is in the schema before P2-4.
- `index.ts`: re-exports; `ping` now also proves `validatePayload` runs in-module.

**Verified on Maincloud `dcos-dev`**
- Republished once with `--delete-data` so `init` would run (the `run` table was empty beforehand). The owner `c2001635…` is now `admin` in `role_grant`.
- `ping` → `validatePayload ok=true bad=false`. **ajv works inside the SpacetimeDB runtime**, so we don't need standalone validators (this resolves the P2-1 open question).
- `create_run run-demo-1 42 gpu_demo_8` → 316 public rows; `gpu_current` = 65; `job_current` = 3 (all `running`); allocations 8 each on r2, r3 → job-a, r4 → job-b, r6 → job-c; `run.sim_time_ms` = 600000; checkpoints complete at 60000 / 540000; `cooling_current` has pump-a/b + loop-a/b; `resource` = 97.
- `--anonymous`: `create_run` → `UNAUTHORIZED: caller … has role none; needs admin`. SQL against `world_state`, `role_grant`, `fault_injection_truth`, `tick_schedule` → "no such table … may be marked private". A JSON dump of the 10 projected public tables has no `fault*`, `hidden*`, `private*`, `rng_state`, `world_json` or `true_*` strings. The generated bindings contain no private tables.
- Rejections: bad preset, bad `run_id`, `speed: 9`, unknown key, non-JSON → `INVALID_PAYLOAD`; unknown run → `NOT_FOUND`; bad role → `INVALID_PAYLOAD`; self-demote → `INVALID_TRANSITION`.
- `grant_role` agent → row present; `""` → revoked. `configure_run {"speed":3,…}` → `run.speed` 3; `pause_run` toggles `paused`/`status`. A second `create_run` → "reset (318 rows cleared), 316 public rows", and every value is back to defaults.
- `tsc --noEmit` clean (db, db-client); `pnpm -r test`: contracts 15, physics 92, db-client 15.

**Notes / open questions**
- Error code for bad JSON is **`INVALID_PAYLOAD`** (CONTRACTS §0.11 #14, which db-client parses), not `BAD_PAYLOAD` as the checkpoint README and the lane file say; §0 wins.
- CLI quirk: `spacetime call` parses each argument as JSON, so string args that look like JSON need quoting: `configure_run run-demo-1 '"{\"speed\":3}"'`. An identity is passed as `'"0x…"'`.
- `gpu-real-0` starts `unreachable`. If P3's triage would open an incident for it before the Brev feed is up, P1's real `buildPreset` (or P2-9) can choose another starting state.
- This branch doesn't have `origin/main`'s CONTRACTS v1.1.1 commit (`6421e0f`, docs only). Kaushik: `git merge origin/main` when convenient.

**Message for P3/P4** (Kaushik to post):
> P2-3 is live on `dcos-dev`: all Tier 1 tables plus bindings are in `packages/db-client/src/generated`. `run-demo-1` exists: 65 GPUs (incl. `gpu-real-0`, unreachable until the nvidia-smi feed starts), 3 jobs, sim clock 600000. Nothing ticks yet (P2-4). Public tables are readable without a token; generated field names are camelCase (`simTimeMs`). One run per database; re-running `create_run('run-demo-1', …)` resets it.
