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
- [x] Stale-evidence case: `failed` / `SAFETY_REJECTED`, `violations` contains `EVIDENCE_STALE`, no leases left, job-a's allocation unchanged and still running two ticks later, destination GPUs unallocated
- [x] Stale version, normal start and unrelated lease cases pass
- [x] Violation-free `needs_approval` still runs (mock test)
- [x] `pnpm -r test` and typechecks match the K0 baseline plus new tests. The agent's mock integration test is the one most likely to react.
- [x] Passes on `dcos-r-local`
- [x] Branch merged to `int/r-sprint` (`4202392`)
- [x] Gate 2 and `smoke:ledger` re-run on `dcos-dev` after R1 is merged (K3, 2026-11-08 02:53 CST). Never reset prod for this.

## Not in this checkpoint
Phase-aware completion checks (R1, Suvan). Any change to `evaluateSafety` (`packages/physics`).

## Agent changes (made at Kaushik's request; tell Suvan)
These touch S3's files, so they need coordinating. At the time of writing `r/r3-verify-handoff` changes `resume.ts` elsewhere and doesn't touch `coordinator.ts`.
1. `coordinator.ts`: a safety rejection returned by `start_action`, or found after a claim conflict, is now recorded as `blocked` with a BLOCKED event.
2. `resume.ts`: `reclaim()` reports a rejected start as `blocked`, so the persisted plan gets replanned.

## Architect notes (Codex)
Read-only review of the working-tree diff, static only. No critical or high findings.
- **Medium, mock dependency exemption narrower than live.** Fixed: `liveLockSet` mirrors the live lock set; regression test added.
- **Medium, `reclaim()` hides a safety rejection.** Confirmed in code and fixed; test added.
- **Medium, first-run rejection loses BLOCKED.** Confirmed in code and fixed; test added.
- **Low, restamp test proved nothing.** Fixed: the test now moves the epoch between request and start, with nonempty expected versions.

Second pass, over those fixes:
- **Claim-conflict path misses the rejection.** Confirmed and fixed at `drive()` entry; test added.
- **Mock `escalate` dependency exempts GPUs.** Confirmed and fixed; test added.
- **A start rejection from aging evidence escalates rather than replans.** Not changed. A `blocked` outcome doesn't abort execution, same as a request-time block today, and the safety rules send stale evidence to a human. Changes that do matter (an Xid, a version or epoch change) still trigger the replan watcher.
- **Reclaim rejection emits no safety-stage BLOCKED event.** Not changed. The resume event leads with "safety-rejected (EVIDENCE_STALE), replanning", and the ledger shows BLOCKED.

## Implementation report (Claude)
**Status: ◐ merge-ready (2026-11-08). Open: the merge to `int/r-sprint`, and the `dcos-dev` re-run in K3.**

- `apps/db/src/actions.ts`: one `isRejected` rule used at request and start. A stale version at start is now `failed` / `SAFETY_REJECTED` with `start_safety` evidence (Decision 1: default accepted).
- `packages/db-client/src/mock.ts`: `startAction` now does the version check and safety recheck and records `start_safety`.
- `apps/db/scripts/ledger-smoke.mjs`: four live R2 cases.
- `packages/db-client/test/mock.test.ts`: 9 new tests.
- `apps/agent/src/{coordinator,resume}.ts`: see "Agent changes". `apps/agent/test`: 3 new tests and a `rejectStart` helper on `FakeDb`.

**Verified:**
- `pnpm -r test`: see the counts in `plans/status/P2.md`. `pnpm -r exec tsc --noEmit` is clean.
- Live on `dcos-r-local`: the full `smoke:ledger`, including all R2 cases, and Gate 2 pass. The Codex fixes came after this but touched only the mock, the agent and tests, so the module is the one tested.
- The first two agent tests were run with the agent fixes removed, and failed as they should.

**Not verified:** nothing has run on `dcos-dev` or prod. No R1 physics yet, so the Gate 2 re-run is still owed. The agent fixes are tested on `FakeDb` only, not against a live database.
