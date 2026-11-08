# P2-K3b: Read helpers for plans and handoff
**Due:** as soon as Karthik starts C1 step 5; ideally while waiting on S1 · **Gate:** 3 · **Status:** ☐ · **Depends on:** K0 · **Owns:** `packages/db-client/src/{client,types,live,mock}.ts`, `packages/db-client/test/`

Spec: TASKS R4.5, `KARTHIK.md` C1 step 5.

## Goal
The dashboard can show the selected plan and the persisted handoff from real data, including after a workflow finishes.

## Why this isn't "only if asked"
`KAUSHIK.md` makes this conditional. Checked at `777b2bf`, the condition is already true:
- `SubscriptionApi` has no plan or workflow subscription, and `apps/web/src` reads neither.
- `listOpenWorkflows` drops `stage === 'done'`, and the final handoff is written when the workflow reaches `done` (`agent-loop.ts:355`). The finished handoff is exactly what would disappear.
- The `plan` table holds every `PlanCandidate` field, so no schema change is needed and **no republish** either. This is client-only.

## Steps
1. Add `onPlans(cb)` returning `PlanRecord[]`, where `PlanRecord = PlanCandidate & { status: string }`. Rebuild the wire fields from the row columns.
2. Add `onWorkflows(cb)` returning every `WorkflowRecord`, including `done`.
3. Implement both in mock and live, following `onActionDetails`. Read-only, no new reducers.
4. In the `PlanRecord` doc comment, say that the selected plan is `workflow.plan_id` and that `plan.status` stays `proposed`, so it must not be shown as "adopted".
5. Tell Karthik the API.

## Open with Suvan
SCOPE §5 asks for **chosen and rejected** options. Rejected options exist only in memory (`JobPlan.alternatives`) and aren't saved anywhere, so no read helper can return them. `KARTHIK.md` and TASKS R4.5 ask only for the selected plan. Either the agent saves them in workflow state (Suvan's S3), or the UI shows the selected plan only and SCOPE is noted as narrowed.

## Done when
- [x] Mock tests: `onPlans` matches a submitted plan, and `onWorkflows` still returns a workflow after `done`
- [x] Live check on `dcos-r-local`: a submitted plan and a workflow at `done` both appear
- [x] `pnpm -r test` and typechecks pass; existing methods unchanged
- [ ] Karthik has the API

## Architect notes (Codex)

## Implementation report (Claude)
**Status: ◐ (2026-11-08). Code done; Karthik still needs telling.** Client-only: no schema change, no republish.

- `onPlans(cb)` returns `PlanRecord[]` and `onWorkflows(cb)` returns every workflow, in mock and live. Unreadable plan rows are dropped, not defaulted.
- Selected plan: `workflow.plan_id`. Final handoff: `workflow.state.verification`.

**Verified:** `pnpm -r test` 740 pass; live check in `provenance-roundtrip.ts` passes on `dcos-r-local`. Rejected plan options remain open with Suvan.
