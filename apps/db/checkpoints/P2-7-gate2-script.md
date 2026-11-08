# P2-7: Gate 2 script
**Due:** 1:30 AM · **Gate:** 2 · **Status:** ☑ · **Owns:** `apps/db/scripts/**`

## Goal
`apps/db/scripts/gate2.ts` (run with `tsx`, uses `@dcos/db-client` `connect()`) proves the ledger end to end against `dcos-dev` and prints PASS/FAIL per check.

## Checks
1. Fresh `create_run` → manual checkpoint on job-a goes `requested → claimed → running → succeeded` across ticks; `durable_work_units` only changes at `succeeded`.
2. `request_action` with the same `command_key` 10× → exactly one `action` row and one checkpoint.
3. Same key, different payload → `COMMAND_KEY_COLLISION`.
4. Move job-a onto `rack-r6` → denied with `DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT`.
5. Request with an old `expected_decision_epoch` → `STALE_DECISION_EPOCH`.
6. Workflow: second worker / stale fencing token rejected.
7. **Crash:** a child process requests + claims + starts a checkpoint, then is killed (`SIGKILL`); the parent watches the checkpoint still reach `succeeded` and leases release afterwards.

## Done when
- [x] Script prints all PASS twice in a row on `dcos-dev` (also ALL PASS offline on a local server and on prod `dcos`, 2026-11-08)
- [ ] Integrator ticks Gate 2 in `plans/README.md`

## Architect notes (Codex)
Review of the uncommitted P2-7 diff (codex exec, read-only). All five **fixed**; Gate 2 re-run ALL PASS twice:
- [P2] `publishEvaluationResult` always threw, blocking P4's results. **Fixed:** new reducer `publish_evaluation_result(result_json)` (`apps/db/src/evaluation.ts`; admin; `validatePayload('EvaluationResult')`; upsert by `scenario/policy/seed`; metrics in `metrics_json`; `physics_profile_version` = `gpu_v1`), bindings regenerated, client wired. Live: publish → `onEvaluation` row; a re-publish replaces it; a bad policy → `INVALID_PAYLOAD`. (The smoke row was deleted from dev.)
- [P2] `getEvidence` dropped workflow links. **Fixed:** `workflow_incident` rows are returned as `link_kind: 'workflow'` (reason `workflow`; that table has no reason column).
- [P2] Gate 2's durability check could pass with zero running samples. **Fixed:** `onJobs` samples job-a on every job update while the action is running, keeps the first violation, and requires ≥ 1 sample (live: 6 samples).
- [P2] The stale-epoch check used a future epoch. **Fixed:** it submits the epoch captured before the checkpoint, after asserting the checkpoint advanced it (live: 0 → 2, request with 0 → `STALE_DECISION_EPOCH`).
- [P3] Unsubscribing left SDK listeners registered. **Fixed:** `removeOnInsert` / `removeOnUpdate` / `removeOnDelete`.
- Also found while re-running: check 7 raced, because the child's writes reach the parent's cache asynchronously and the parent could read `claimed` right after `STARTED`. **Fixed:** the parent waits until it observes `running`, then SIGKILLs and asserts `signalCode === 'SIGKILL'`; completion waits for a true terminal status. **Same lesson for P3:** your own call's result is in your cache when the promise resolves, but another client's writes arrive a moment later.

## Implementation report (Claude)
**Files**
- `packages/db-client/src/live.ts`: **the live `connect({ uri, db, token?, runId? })`**, same `DbClient` as the mock.
  - One WebSocket connection, subscribed (SQL) to all 23 public tables; `connect()` resolves after the initial `onApplied`.
  - Mutations await the reducer. The SDK applies the transaction to the client cache before the promise resolves (`db_connection_impl.ts` ReducerResult: `#applyTransactionUpdates`, then the callback), so results are read back from the cache: `requestAction` / `startAction` / `cancelAction` / `verifyAction` → `ActionStatus`; `claimAction` → `{ status, fencing_token = action.lease_token }`; `claim` / `heartbeat` / `updateWorkflow` → `WorkflowLease` / `WorkflowRecord`; `upsertIncident` → `Incident`.
  - Reducer errors (`SenderError("CODE: msg")`) → `DbError` with `.code` via `parseDbError` (§0.11 #14).
  - Reads are rebuilt as snake_case contract shapes from the camelCase rows: `getObservedSnapshot` (validates as `ObservedSnapshot`; `job_states.allocated_gpu_ids` from `job_gpu_allocation`; `observation_event_ids` = last 100 signals), `getEvidence` (same scoping as the mock), `getActionStatus`, `getWorkflow` (`incident_ids` from `workflow_incident`), `listOpenWorkflows`, `listIncidents`. `ActionStatus.result` drops the ledger-internal `command` and adds `due_sim_time_ms` once it's known.
  - `onChange` (§0.11 #15): `decision_epoch` (run update), `resource_version` (gpu_current / resource version change), `signal` (signal_event insert), `action_status` (action insert / update). `onGpu` / `onJobs` / `onIncidents` / `onActions` / `onAgentEvents` / `onEvaluation` fire immediately, then once per batch of changes (microtask-coalesced).
  - `publishEvaluationResult` → the new `publish_evaluation_result` reducer (see the architect notes). `ingestObservations` rejects with a coded error until P2-9.
- `packages/db-client/src/types.ts`: `parseDbError` accepts an optional `XxxError: ` prefix, same as P3's `dbErrorCode`.
- `apps/db/scripts/gate2.ts` + `pnpm --filter db gate2 [db]`: the 7 Gate 2 checks over the live client (**resets run-demo-1**, ~2 min). Token from `STDB_ADMIN_TOKEN`, else the CLI login token (never printed). Check 7 re-runs the script as a `--child` that requests, claims and starts a job-b checkpoint, prints `STARTED`, and is then `SIGKILL`ed by the parent. Also `smoke:ledger` / `smoke:workflow` scripts.

**Verified on `dcos-dev`** — `pnpm --filter db gate2`, **ALL PASS twice in a row**:
live snapshot validates (64 GPUs, 3 jobs) · ×10 request → one action (v1) · lifecycle seen via `onChange`: `requested>claimed>running>succeeded` · durable 86400 while running → 95072 at succeeded · exactly one new job-a checkpoint · `COMMAND_KEY_COLLISION` · move onto r6 → `DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT` (+ `DEST_GPU_BUSY`) · stale epoch → `STALE_DECISION_EPOCH` · second worker → `LEASE_HELD`, takeover after expiry, stale owner → `STALE_FENCING_TOKEN` · the SIGKILLed caller's checkpoint still → `succeeded`, then job-b is claimable again.
- Also live: `onGpu` / `onJobs` fired 7× in 6 s (64 GPUs, 3 jobs); `connect()` without a token reads the snapshot (browser case); an anonymous `createRun` → `UNAUTHORIZED`.
- `tsc` clean (db, db-client); `pnpm -r test`: 15 / 335 / 15.

**For P3 / P4:** switch with `connect({ uri: 'wss://maincloud.spacetimedb.com', db: 'dcos-dev', token })` (token: `STDB_AGENT_TOKEN`; omit it for read-only browser use). Real role tokens come in P2-8.
