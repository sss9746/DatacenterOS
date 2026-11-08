# P2-6: Workflow + incidents ‖
**Due:** 1:15 AM · **Status:** ☐ · **Owns:** `apps/db/src/workflow.ts`, `apps/db/src/incidents.ts` (+ tests)
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
- [ ] Two workers can't both own one workflow
- [ ] A stale fencing token is rejected
- [ ] Expired lease → a second worker can take over
- [ ] Incident links are not duplicated on repeat upsert

## Architect notes (Codex)

## Implementation report (Claude)
