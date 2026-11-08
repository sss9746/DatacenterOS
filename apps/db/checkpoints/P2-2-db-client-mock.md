# P2-2: `@dcos/db-client` wrapper + mock ‖
**Due:** 9:00 PM · **Gate:** 0 · **Status:** ☐
**Owns:** `packages/db-client/src/**` except `generated/`, `packages/db-client/package.json`, tests
**Can run in parallel with P2-1** (separate worktree).

## Goal
P3 and P4 can `import { createMockClient } from '@dcos/db-client'` and build against fixtures before the DB is live. The real `connect()` has the same API.

## API (names frozen by CONTRACTS §0.6)
- **Agent:** `connect(opts)`, `getObservedSnapshot()`, `getEvidence(incidentIds, windowSimMs)`, `getActionStatus(commandKey)`, `requestAction(cmd)`, `claimAction(commandKey, expectedVersion, workerId)`, `startAction(commandKey, fencingToken)`, `cancelAction(…)`, `verifyAction(…)`, `claimWorkflow(…)`, `heartbeatWorkflow(…)`, `updateWorkflow(…)`, `upsertIncident(…)`, `submitPlan(…)`, `publishAgentEvent(…)`
- **Gateway:** `ingestObservations(batch)`
- **Admin:** `createRun`, `configureRun`, `pauseRun`, `injectFault`, `publishEvaluationResult`
- **Subscriptions:** `onGpu`, `onJobs`, `onIncidents`, `onActions`, `onAgentEvents`, `onEvaluation`

## Steps
1. Define one `DbClient` interface; `createMockClient()` and `connect({ uri, db, token })` both return it.
2. Mock: serves `packages/physics/fixtures/gpu/*.json` (P1-1). Until those land, use local stand-ins in `src/mock/fixtures/` built from `@dcos/contracts` types and validated with `validatePayload`; delete them when P1's arrive.
3. Mock records every call (`client.calls`) so P3 can assert on what it sent; `requestAction` is idempotent by `command_key` in the mock too.
4. Mock `onGpu`/`onJobs` emit the fixture rows once (option: step between the two snapshots to fake a live change).
5. `connect()` wraps the generated bindings; stub with "not connected" errors until P2-1's bindings exist.

## Done when
- [x] `import { createMockClient } from '@dcos/db-client'` works from another workspace package
- [x] Unit test: mock returns a valid `ObservedSnapshot`, records calls, `requestAction` twice with the same key → one action
- [ ] P3 and P4 pinged

## Architect notes (Codex)
Spec turned out to be `apps/agent/src/ports.ts` on `origin/lane/p3-agent` (CONTRACTS §0.11 #7). Codex review (read-only):
- Confirmed `AgentApi` is assignable to P3's `DbPort` (in-memory tsc check).
- Claim checked only target/job, not destination GPUs → double reservation. **Fixed** (full closure).
- `expected_resource_versions` ignored. **Fixed** (`STALE_RESOURCE_VERSION` → SAFETY_REJECTED).
- Claim missing `result.claimed_by` (P3 replan reads it). **Fixed.**
- Power cap didn't emit `resource_version`. **Fixed.**
- `updateWorkflow` ignored `null` clears of `plan_id` / `current_command_key`. **Fixed.**

## Implementation report (Claude)
**Files** (`packages/db-client/`)
- `src/types.ts`: DB-side types copied verbatim from P3's `ports.ts` (Evidence, WorkflowRecord, WorkflowLease, SymptomRecord, AgentEventInput, DbChange) + `DbError`, `isDbError` (by `code`, §0.11 #14), `parseDbError` (`"CODE: msg"` → coded error, for the live client), `isSafetyRejected`.
- `src/client.ts`: `DbClient` = `AgentApi` (== P3 `DbPort`) + `GatewayApi` + `AdminApi` + `SubscriptionApi` (`onGpu`, `onJobs`, `onIncidents`, `onActions`, `onAgentEvents`, `onEvaluation`: fire immediately with the full list, then on every change).
- `src/mock.ts`: `createMockClient(opts)`; browser-safe; options `snapshot`, `now`, `evaluateSafety` (plug in P1's), `claimLeaseMs`, `autoTickMs`. Mock controls: `calls`, `tick()`, `loadSnapshot('pump_degraded')`, `injectSignal()`, `injectedFaults`. `injectFault` has visible mock effects for pump-a degradation and XID 79.
- `src/live.ts`: `connect()` rejects with a clear message until P2-3..P2-6.
- `src/mock/fixtures/*.json`: copies of P1's fixtures from `origin/lane/p1-sim` @ `2e641cd`. Refresh with `pnpm --filter @dcos/db-client sync:fixtures` once P1 is on main / regenerates them (§0.12 moves run start to 600000).
- `test/mock.test.ts`: 15 tests (idempotency ×10, collision, hash excludes requested_sim_time_ms, stale epoch/version → SAFETY_REJECTED, lifecycle over ticks with durable only at success, fencing, cancel rules, workflow lease/heartbeat/expiry, subscriptions, XID 79, ingest dedupe/monotonic, closure clash, parseDbError).
- `apps/db/package.json`: dev deps `@dcos/db-client`, `tsx` (for the P2-7 gate script).

**Verified:** `pnpm -r test` → contracts 15, physics 92, db-client 15. `tsc --noEmit` clean. A `tsx` script in `apps/db` imports `createMockClient` and prints 64 GPUs / 3 jobs.

**Caught by tests:** the mock's XID signal `event_id` was derived from the private `fault_id` (a truth leak); now independent.

**Open:** P3 can now replace its local types in `ports.ts` with `import type … from '@dcos/db-client'` (their call).
