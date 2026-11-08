# P2-6: Workflow + incidents ‖
**Due:** 1:15 AM · **Status:** ☑ · **Owns:** `apps/db/src/workflow.ts`, `apps/db/src/incidents.ts` (+ tests)
**Can run in parallel with P2-5** (separate worktree; different files).

## Goal
P3's orchestrator can own a workflow with a short lease, record incidents/plans, and publish its F-NV1 feed.

## Reducers (all agent role)
| Reducer | Must do |
|---|---|
| `claim_workflow(workflow_id, worker_id, expected_version, lease_ms)` | CAS on `version`; succeeds if unowned or lease expired; new `fencing_token`; creates the workflow if absent |
| `heartbeat_workflow(workflow_id, worker_id, fencing_token, lease_ms)` | owner + current token only; extends `lease_expires_unix_ms` |
| `update_workflow(workflow_id, expected_version, fencing_token, stage, state_json)` | CAS + fencing; stale → `STALE_FENCING_TOKEN` |
| `upsert_incident(incident_json, links_json)` | validate `Incident` / `IncidentLink`; write `incident`, `incident_symptom`, `incident_resource` (uniqueness enforced in reducer) |
| `submit_plan(plan_json)` | validate `PlanCandidate`; writes a proposal only, never executes |
| `publish_agent_event(agent_event_json)` | includes `tool_calls_json` `[{tool, args_summary, result_summary}]` (F-NV1); no raw chain-of-thought |

**Workflow lease ≠ resource lease.** Workflow lease = which worker plans next (short, wall-clock). Resource lease = owned by a running action (P2-5).

## Done when
- [x] Two workers can't both own one workflow
- [x] A stale fencing token is rejected
- [x] Expired lease → a second worker can take over
- [x] Incident links are not duplicated on repeat upsert

## Architect notes (Codex)
Review of the uncommitted P2-6 diff (codex exec, read-only). Both **fixed** and verified live:
- [P1] Workflow tokens were per-workflow while action tokens came from their own counter, so after a takeover the stale workflow token `1` could equal an action's `lease_token` `1` and pass `cancel_action`'s own-token path. **Fixed:** `tokens.ts` `nextFencingToken` is one global sequence (max over action, lease and workflow tokens + 1) used by both `claim_action` and `claim_workflow`, same as the mock's shared counter. Live: w1 1, w2 2, the next action 3; w1's token can't cancel it.
- [P2] `checkShape` used `in`, so inherited names (`constructor`, `__proto__`) passed the strict check; a `constructor: {chain_of_thought: …}` reached public `tool_calls_json`. **Fixed:** own-property checks, and `checkShape` returns a fresh object holding only the validated keys (that projection is what gets stored). Live: both keys → `INVALID_PAYLOAD`, nothing stored.

## Implementation report (Claude)
**Files**
- `apps/db/src/workflow.ts`: `claim_workflow`, `heartbeat_workflow`, `update_workflow` (agent role; admin passes).
- `apps/db/src/incidents.ts`: `upsert_incident`, `upsert_symptoms` (§0.11 #10), `submit_plan`, `publish_agent_event`.
- `apps/db/scripts/stdb.mjs` (shared CLI helpers), `apps/db/scripts/workflow-smoke.mjs` (live test; **resets run-demo-1**). `ledger-smoke.mjs` now uses the shared helpers (re-run: all pass).
- Bindings regenerated (7 new reducer files).

**Behavior** (matches the db-client mock P3 builds against)
- **claim_workflow(workflow_id, worker_id, expected_version, lease_ms):** a missing workflow is created (stage `idle`, v0, the database's single run) only when `expected_version` = 0, else `NOT_FOUND`. Then CAS on version (`VERSION_CONFLICT`), then `LEASE_HELD` if another worker's lease is live. The claim sets the owner, a fresh fencing token from the global sequence shared with action claims (`tokens.ts`), expiry = now + `lease_ms` (1 ms..10 min), attempt+1, version+1. Re-claim by the current owner is allowed (new token).
- **heartbeat_workflow:** token (`STALE_FENCING_TOKEN`), then owner (`LEASE_HELD`), then expiry (`LEASE_EXPIRED`); extends the lease; **no version bump** (§0.11 #16).
- **update_workflow:** CAS on version first (same order as the mock), then token and expiry; stage must be a `WorkflowStage`; `state_json` an object. As in the mock, `state.incident_ids` (array) syncs the `workflow_incident` rows, and `state.plan_id` / `state.current_command_key` set a string or clear on `null` (absent = unchanged). Version+1.
- **Stale owner after takeover:** with the current version but an old token → `STALE_FENCING_TOKEN`; with an old version → `VERSION_CONFLICT`. Both reject.
- **upsert_incident(incident_json, links_json):** `validatePayload('Incident')` + each `IncidentLink`; every link must belong to the same run and incident. The incident is upserted. Links are merged into `incident_symptom` / `incident_resource` / `workflow_incident` by canonical id (`incident/linked`, workflow: `workflow/incident`); a repeat keeps the first row.
- **upsert_symptoms(symptoms_json):** `SymptomRecord[]` (≤ 500, hand-checked: ids, ms, severity `info|warning|critical`, no extra fields); idempotent by `symptom_id`; `first_seen_sim_ms` preserved, the rest updated.
- **submit_plan(plan_json):** `validatePayload('PlanCandidate')`; stored as `proposed` (metrics in `expected_metrics_json`); never creates actions.
- **publish_agent_event(agent_event_json):** `AgentEventInput`, hand-checked and **strict** (unknown fields such as a raw-reasoning blob are rejected; summary ≤ 1000 chars, tool-call fields ≤ 500, ≤ 50 calls); `actor` defaults to `code` so nothing is mislabelled as model output; idempotent by `agent_event_id`.
- **cancel_action via the workflow token** (§0.11 #13, P2-5) now tested: an expired owner's token → `STALE_FENCING_TOKEN`; the live owner's token cancels.

**Verified live on `dcos-dev`** (`workflow-smoke.mjs`, all pass): anonymous → `UNAUTHORIZED`; missing + v3 → `NOT_FOUND`; w1 creates and claims (v1, idle, token 1); w2 → `LEASE_HELD`; v0 → `VERSION_CONFLICT`; heartbeat keeps v1; w2 heartbeat → `LEASE_HELD`; wrong token → `STALE_FENCING_TOKEN`; update → v2 triage, plan-1, `workflow_incident` inc-1 + inc-2; null clears plan and the list shrinks; bad stage → `INVALID_PAYLOAD`; after 9 s w1 heartbeat → `LEASE_EXPIRED`; w2 takes over (token 2, attempt 2, v4); w1 old token → `STALE_FENCING_TOKEN`, old version → `VERSION_CONFLICT`; w2 update ok; cancel with w1's token rejected, with w2's ok; symptoms: first_seen 1000 kept, last_seen 9000; incident with 4 links twice → 2 symptom + 1 resource links, state updated; a foreign link, bad severity, empty `command_keys`, unknown event field, bad stage → `INVALID_PAYLOAD`; plan `proposed` and no action created; agent event idempotent (first summary kept), actor default `code`.
- `tsc` clean (db, db-client); `pnpm -r test`: 15 / 335 / 15; `ledger-smoke.mjs` still all pass.

**Open**
- `getWorkflow`, `listOpenWorkflows`, `listIncidents`, `getEvidence` are client-side reads over subscriptions: that's P2-7 (live `connect()`).
