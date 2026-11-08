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
- [ ] Unit/integration tests for each rule above
- [ ] P2-7 Gate 2 script passes

## Blocked by
P1's `evaluateSafety` (P1-6, 12:30 AM) and actions inside `step()` (P1-5, 11:45 PM).

## Architect notes (Codex)

## Implementation report (Claude)
