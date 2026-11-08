# P2-K1: R2, `start_action` fails closed
**Due:** M1 03:30 · **Gate:** 2 · **Status:** ☐ · **Depends on:** K0 · **Owns:** `apps/db/src/actions.ts`, `packages/db-client/src/mock.ts`, `packages/db-client/test/mock.test.ts`, `apps/db/scripts/ledger-smoke.mjs`

Spec: TASKS R2, SCOPE §4 "Required safety repairs", CONTRACTS §0.11 #17 and §0.13 #5.

## Goal
Any safety violation found at start stops the action, the same as at request time. Today a newly stale GPU gets through.

## What the code does today (checked at `777b2bf`)
- `actions.ts:373` blocks only `deny`. `EVIDENCE_STALE` alone returns `needs_approval` with a violation, so it passes. The request-time rule at `actions.ts:226` already rejects it.
- `retry_new_snapshot` also passes at line 373, for the same reason.
- Stale versions are already caught earlier, at `actions.ts:355-362`, but recorded with reason `STALE_RESOURCE_VERSION`.
- `evaluateSafety` only checks freshness for `migrate_restart` (every reachable GPU on the destination racks) and `uncordon_gpu`.
- A frozen sensor does **not** bump the GPU version (`gpuMaterialKey` excludes `last_seen`), so the version check won't pre-empt `EVIDENCE_STALE`.
- The mock's `startAction` (`mock.ts:597`) runs no safety or version check at all.
- A violation-free `needs_approval` **cannot happen on the live preset**. The only job with priority ≥ 80 is job-c, and it is non-preemptible, so it always carries a violation. That branch can only be tested through the mock's stub.

## Steps
1. In `actions.ts`, extract one rule and use it at lines 226 and 373:
   `const isRejected = (d: SafetyDecision) => d.decision !== 'allow' && (d.decision !== 'needs_approval' || d.violations.length > 0);`
2. Update the stale comment at lines 364-366 and the reducer header.
3. Stale versions: see Decision 1.
4. Mock `startAction`: add the version check (with the dependency exception) and, when `opts.evaluateSafety` is set, the same restamped recheck using `leasedResourceIds(commandKey)`. A rejection records `failed` / `SAFETY_REJECTED` with `violations` and `start_safety`, and frees the claim.
5. Add an R2 section to `ledger-smoke.mjs`, calling `create_run` between cases:
   - **Stale evidence:** speed 5. Request `migrate_restart` of job-a to r1+r5 (allowed, its checkpoint is complete). Inject `sensor_stale` on `gpu-r1-n1-0` at the next tick. Claim. Wait until the clock passes the fault by more than 10 sim-s. Start.
   - **Stale version:** request the same move with `expected_resource_versions` for a destination GPU, claim, inject `gpu_xid_79` on it, wait for the version bump, start.
   - **Normal start:** the same move with no fault reaches `running`, so its own leases don't count against it.
   - **Unrelated lease:** another action holding job-b doesn't block job-a's start.
6. Add mock tests with stubbed decisions: `needs_approval` + `[]` runs, `needs_approval` + `[EVIDENCE_STALE]` fails, `deny` fails, stale version fails, and the stub's `leased_resource_ids` excludes the action's own closure.

**Timing trap:** a claim expires after 15 s of wall time (`CLAIM_LEASE_MS`). Waiting 10+ sim-s at speed 1 with CLI latency can lose the claim and report `LEASE_EXPIRED` instead. Use speed 5.

## Decision 1 (Kaushik)
Should a stale version found at start be recorded as `SAFETY_REJECTED` or stay `STALE_RESOURCE_VERSION`?
**Default: `SAFETY_REJECTED`, keeping `violations: ['STALE_RESOURCE_VERSION']`.** `KAUSHIK.md` asks for it, request-time does the same, and the dashboard only shows BLOCKED for that code. No script or agent code matches on the old reason.

## Done when
- [ ] Stale-evidence case: `failed` / `SAFETY_REJECTED`, `violations` contains `EVIDENCE_STALE`, no leases left, job-a's allocation unchanged and still running two ticks later, destination GPUs unallocated
- [ ] Stale version, normal start and unrelated lease cases pass
- [ ] Violation-free `needs_approval` still runs (mock test)
- [ ] `pnpm -r test` and typechecks match the K0 baseline plus new tests. The agent's mock integration test is the one most likely to react.
- [ ] Passes on `dcos-r-local`, then branch merged to `int/r-sprint` (**merge-ready at M1**)
- [ ] Gate 2 and `smoke:ledger` re-run on `dcos-dev` after R1 is merged (**closes in K3 at M2**). Never reset prod for this.

## Not in this checkpoint
Phase-aware completion checks (R1, Suvan). Any change to `evaluateSafety` (`packages/physics`).

## Note for Suvan (no action in this lane)
On a first run, a start-time rejection goes through `claimAndStart` → `finish()`, so the agent records `failed` and emits no BLOCKED event. On resume, `adoptExisting` records it as `blocked`. R2 makes this path more common.

## Architect notes (Codex)

## Implementation report (Claude)
