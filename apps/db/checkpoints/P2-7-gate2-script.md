# P2-7: Gate 2 script
**Due:** 1:30 AM · **Gate:** 2 · **Status:** ☐ · **Owns:** `apps/db/scripts/**`

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
- [ ] Script prints all PASS twice in a row on `dcos-dev`
- [ ] Integrator ticks Gate 2 in `plans/README.md`

## Architect notes (Codex)

## Implementation report (Claude)
