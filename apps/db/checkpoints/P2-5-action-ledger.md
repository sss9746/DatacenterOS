# P2-5: Durable action ledger
**Due:** 1:00 AM · **Status:** ☐ · **Owns:** `apps/db/src/actions.ts` (+ tests)
**Read first:** ARCHITECTURE §6, CONTRACTS §C "Reducer implementation invariants".

## Lifecycle
`requested → claimed → running → succeeded | failed | cancelled | needs_reconciliation`. Append an `action_event` on **every** transition.

## Reducers
| Reducer | Must do |
|---|---|
| `request_action(action_command_json)` | agent role; `validatePayload('ActionCommand')`; payload hash; same key + same hash → return existing row (no side effects); same key + different hash → `COMMAND_KEY_COLLISION`; check `expected_decision_epoch` / versions (`STALE_DECISION_EPOCH`, `STALE_RESOURCE_VERSION`); fresh `evaluateSafety(toObserved(world), cmd, {decision_epoch, leased_resource_ids})`; on deny persist `failed` with violations as `reason_code` |
| `claim_action(command_key, expected_action_version, worker_id)` | build the lock closure **inside the reducer** (for migrate: job + source GPUs + dest GPUs + rack/node); lock in sorted ID order; any held → `LEASE_HELD`; increment fencing tokens; `claimed` |
| `start_action(command_key, fencing_token)` | check fencing (`STALE_FENCING_TOKEN`) + revalidate versions; set `due_sim_time_ms`; pass command into `step` via `requested_action_ids`; checkpoint row `status='writing'`; **durable work does not change** |
| completion (inside `advance_tick`) | still owns its leases; revalidate **command-specific** resources (not the global epoch); commit once; `succeeded` + release leases; else `failed`/`needs_reconciliation`, durable work unchanged |
| `cancel_action(command_key, reason_code, fencing_token)` | only safe-to-cancel states |
| `verify_action(command_key, evidence_json)` | records verification |

## Lease rules
- A **claimed, never-started** action may time out and release its leases.
- A **running** action keeps its leases under DB supervision even if the agent dies. Only success / cancel / failure / reconciliation releases them.
- `checkpoint` and `migrate_restart` are separate commands linked by `action_dependency`.

## Done when
- [x] Unit/integration tests for each rule above (`apps/db/scripts/ledger-smoke.mjs`, live on `dcos-dev`, all pass)
- [ ] P2-7 Gate 2 script passes (P2-7; needs the live db-client `connect()`)

## Blocked by
P1's `evaluateSafety` (P1-6, 12:30 AM) and actions inside `step()` (P1-5, 11:45 PM).

## Architect notes (Codex)
Review of the uncommitted P2-5 diff (codex exec, read-only). All six **fixed**; `ledger-smoke.mjs` extended and passing live:
- [P1] Physics doesn't recheck thermal/power safety, so a migrate could proceed after its headroom became unsafe. **Fixed:** `start_action` re-runs `evaluateSafety` before dispatch, with the command restamped to the current epoch and versions (freshness already checked), excluding its own leases; `deny` → `failed` / `SAFETY_REJECTED`, leases released. **Completion** is still physics': once started, a move is a committed effect (§C), and P1 may add a completion-time thermal check if they want one.
- [P1] A node-scoped `power_cap` locked only the node, so a GPU-scoped cap could claim one of its GPUs concurrently. **Fixed:** a node target, and every migrate destination node, locks all its GPUs. Live: a cap on `node-r4-n1` takes ≥ 9 leases; a GPU cap on `gpu-r4-n1-0` is rejected.
- [P1] Live checkpoint completion bumps `decision_epoch` (physics: material change); the mock didn't, so P3's sequential checkpoint → migrate flow would hit `STALE_DECISION_EPOCH`. **Fixed:** the mock now bumps the epoch on checkpoint completion too (db-client tests pass), and the smoke test covers the sequential flow: the old epoch → stale, the refreshed epoch → requested. **P3 must re-read `run.decision_epoch` (not just versions) before requesting a follow-up command.**
- [P2] `start_action` accepted an expired claim. **Fixed:** `LEASE_EXPIRED` (claim again). Live: start at 16 s → `LEASE_EXPIRED`.
- [P2] `EVIDENCE_STALE` was persisted as executable `requested`, unlike the mock. **Fixed:** any decision with a §0.7 violation is rejected; only `needs_approval` with no violation (approval reasons only) stays `requested`.
- [P3] The tick scanned all historical actions per step. **Fixed:** running actions come from the `by_run_status` index.

## Implementation report (Claude)
**Files**
- `apps/db/src/actions.ts`: `request_action`, `claim_action`, `start_action`, `cancel_action`, `verify_action` (agent role; admin passes), plus the tick hooks `actionsToStart` / `settleActions`.
- `apps/db/src/hash.ts`: pure SHA-256 (the runtime has no synchronous crypto; checked against `node:crypto`, including multi-byte UTF-8 and block-boundary lengths) + `stableStringify`. `payload_hash` = sha256 of the key-sorted command without `requested_sim_time_ms` (§0.11 #2).
- `apps/db/src/tick.ts`: each step passes `actionsToStart` as `requested_action_ids` and calls `settleActions` with the step's completed/failed keys.
- `apps/db/scripts/ledger-smoke.mjs`: live integration test through the `spacetime` CLI (`node apps/db/scripts/ledger-smoke.mjs [db]`; **resets run-demo-1**).
- Bindings regenerated (5 new reducer files).

**Behavior**
- **Reducers can't return values.** Callers read the `action` row by `command_key`; claim's fencing token is `action.lease_token`. The live `connect()` must do this read-back. The stored command lives in `result_json.command` (physics needs the full payload at start).
- **request:** `validatePayload('ActionCommand')` → same key + same hash returns with no side effects; a different hash → `COMMAND_KEY_COLLISION`; a reused `action_id` → `INVALID_PAYLOAD`. Then a fresh `evaluateSafety(toObserved(world), cmd, { decision_epoch: run.decision_epoch, leased_resource_ids })`. `deny` and `retry_new_snapshot` (stale epoch / version) persist `failed` / `SAFETY_REJECTED` with `result.violations` and append an event (§0.11 #3, not thrown). **`needs_approval` with no violation persists `requested`**: approval is the agent's / UI's gate (§0.11 #17); the decision is in `result.safety`. Any violation, `EVIDENCE_STALE` included, rejects (same as the mock). `action_dependency` rows are added for dependencies that already exist.
- **claim:** `VERSION_CONFLICT` on version mismatch. Allowed from `requested`, or from `claimed` once that claim's lease has expired (attempt+1). The closure is built in the reducer from the stored command and the world: target + job + the job's current GPUs; migrate adds destination GPUs, their nodes and racks; `escalate` locks nothing. Leases are checked and taken in sorted order, all-or-nothing, else `LEASE_HELD`. The fencing token is globally monotonic (max issued + 1). Claim leases expire after 15 s (`CLAIM_LEASE_MS`, same as the mock).
- **start:** must be `claimed`; `STALE_FENCING_TOKEN` on a token mismatch; `LEASE_EXPIRED` if any closure lease is no longer this action's; dependencies must have `succeeded` (`INVALID_TRANSITION`). Expected versions must still match, **except resources inside a dependency's closure** (the checkpoint a migrate waits on bumps the job version by design); a stale version → `failed` / `STALE_RESOURCE_VERSION`, leases released. Then `enqueueCommands` into the world; leases become non-expiring; → `running`.
- **tick:** physics starts the command (and creates the `writing` checkpoint). `settleActions` copies `inFlightCommands` due times into `due_sim_time_ms`, then settles `completed` / `failed` keys (reason from `commandOutcome`), releasing leases. A started action that physics no longer knows becomes `needs_reconciliation`. Completion needs no client, so an agent crash mid-checkpoint is fine.
- **cancel:** only `requested` / `claimed`; the token is the action's own (never 0) or the owning workflow's while its lease is live (§0.11 #13); `reason_code` must be UPPER_SNAKE; leases released.
- **verify:** `succeeded` only; `result.verification` = evidence; version+1 and an event.

**Verified live on `dcos-dev`** (`ledger-smoke.mjs`, all pass): anonymous → `UNAUTHORIZED`; bad op → `INVALID_PAYLOAD`; 10× retry (even with a new `requested_sim_time_ms`) → one row, v1, one event; changed payload → `COMMAND_KEY_COLLISION`; claim wrong version → `VERSION_CONFLICT`; claim → token 1, 17 leases (job-a + 16 GPUs); second worker → `LEASE_HELD`; overlapping `pause_job` → failed with `CONFLICTING_ACTION`; wrong token → `STALE_FENCING_TOKEN`; running not cancellable; physics due time 46000 (start + 30 s), `ckpt-job-a-2` writing, durable unchanged; at speed 5 → `succeeded`, durable 86400 → 95296, latest checkpoint complete, leases released; verify stored; move job-a onto r6 → failed with `DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT`, `DEST_GPU_BUSY`; epoch + 5 → `STALE_DECISION_EPOCH`; cancel with token 0 → `STALE_FENCING_TOKEN`; cancel with own token → cancelled, leases released; claim expires after 16 s → worker-2 claims (new token, attempt 2), worker-1's start → `STALE_FENCING_TOKEN`; checkpoint → migrate chain: migrate claim while the checkpoint runs → `LEASE_HELD`, after success it claims and starts despite the job version bump, then succeeds with job-a on r5 + r7; events `requested>claimed>running>succeeded>succeeded`.
- `tsc` clean (db, db-client); `pnpm -r test`: 15 / 335 / 15.

**Open**
- P2-7: wire the live `connect()` in `@dcos/db-client` (reducer call, then read the row back for the returned `ActionStatus` / fencing token) and port this script to `gate2.ts`.
- Cost: every reducer loads and parses the whole world JSON (~75 KB); fine at demo scale.
