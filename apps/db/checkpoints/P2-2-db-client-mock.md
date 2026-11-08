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
- [ ] `import { createMockClient } from '@dcos/db-client'` works from another workspace package
- [ ] Unit test: mock returns a valid `ObservedSnapshot`, records calls, `requestAction` twice with the same key → one action
- [ ] P3 and P4 pinged

## Architect notes (Codex)

## Implementation report (Claude)
