# Lane P3: Nemotron + incident orchestration (Node.js / TypeScript)

**Owns:** `apps/agent/` (package name `agent`), covering the NIM client, tools, workflow engine and the `nemotronPolicy` adapter.
**Branch:** `lane/p3-agent`.
**Must not:**
- mutate GPU/job state except through P2's reducers (via `@dcos/db-client`)
- read `fault_injection_truth` or any private field
- write DB tables or UI
- show raw chain-of-thought

**Reads:** ARCHITECTURE §4, §5, §6; CONTRACTS §0.6, §0.7, §0.8 (F-NV1).
**Run with:** `pnpm --filter agent start` (tsx).

## How the agent decides (keep it this way)
1. **Deterministic code** groups symptoms into candidate incidents and lists every concrete option per affected job: keep, power cap, checkpoint, checkpoint → move to each valid placement, pause, cordon, escalate.
2. Code scores each option with **`simulatePlan`** and ranks them per ARCHITECTURE §5:
   1. no unsafe actions
   2. least irreversible work loss
   3. least completion delay
   4. least waste
   5. fewest preemptions
3. **Nemotron:**
   - confirms or splits incidents, with evidence IDs (it can separate unrelated failures)
   - writes the hypothesis
   - picks among the top options and explains why
   - may refuse with `needs_approval`
   - on a new fault, decides whether the current plan is still valid

   Every tool call and its summary is published (F-NV1).
4. **Code enforces:**
   - `evaluateSafety` before every request
   - the DB re-checks on request
   - Nemotron can never call `request_action` directly; only the coordinator code does

So results are reproducible, Nemotron's role is visible, and an outage falls back to `thresholdPolicy` with `needs_approval`.

## Deliverables in order (‖ = parallel)
| ID | By | Task | Owns | Done when |
|---|---|---|---|---|
| **P3-0** | 8:45 PM | **NIM smoke test.** Brev NIM first (`NIM_BASE_URL`), with hosted `integrate.api.nvidia.com/v1` as fallback. Send one request with `tools` + `tool_choice:"auto"` and confirm a structured tool call comes back. Record which model ID actually supports tool calling in `plans/status/P3.md` | `apps/agent/scripts/smoke-nim.ts` | **Gate 0:** prints a valid `get_job_state` tool call with parsed args |
| **P3-1** | 9:30 PM | **Scaffold + LLM client:** `openai` SDK, env config (§0.10), caps (`LLM_MAX_TOKENS`, `LLM_MAX_TOOL_STEPS`, `LLM_TIMEOUT_MS`, 2 retries), primary → fallback chain, every tool-call arg validated (zod or `validatePayload`), log redaction | `apps/agent/src/{config,llm}.ts` | A unit test with a fake server covers timeout, fallback and bad args |
| **P3-2** | 10:30 PM | **Read-only tools** (ARCHITECTURE §4): `get_incident_evidence`, `get_resource_dependencies` (depth ≤ 3), `get_job_state`, `list_placement_candidates`, `simulate_plan` (calls `@dcos/physics` on `getObservedSnapshot()`), `propose_plan` (→ `submitPlan`), `get_action_status` | `apps/agent/src/tools/**` | Runs against `createMockClient()` and the pump-degraded fixture |
| **P3-3** | 11:30 PM | **Triage + correlation:** group new symptoms by dependency path (same loop/rack) + time window into candidate incidents; Nemotron confirms or splits with evidence IDs → `upsertIncident`. An XID on a GPU with no shared provider becomes a **separate incident** | `apps/agent/src/triage.ts` | On the fixture, 24 throttling GPUs on r2–r4 + pump-a → **1** incident; an added XID 79 on r7 → **2** incidents |
| **P3-4** | 12:45 AM | **Planner:** enumerate → `simulatePlan` → rank → Nemotron chooses and explains → `PlanCandidate` with `based_on_decision_epoch` + assumptions | `apps/agent/src/planner.ts` | Fixture: job-a → checkpoint + move to r7/r8 (not r6); job-b → keep or cap |
| **P3-5** | 1:45 AM | **Coordinator + verifier:** `claimWorkflow` + heartbeat; local `evaluateSafety` pre-check; `requestAction` → `claimAction` → `startAction`; checkpoint → move linked by `depends_on_command_keys`; poll status; verify (job running, GPU stays cordoned, headroom improved); write a handoff summary | `apps/agent/src/{coordinator,verify}.ts` | Against `dcos-dev`: the pump fault ends with job-a moved and verified, and the ledger shows each command exactly once |
| **P3-6** ‖ | 2:00 AM | **F-NV1:** `publishAgentEvent` for every stage (triage, diagnose, plan, safety, execute, replan, verify) with `summary`, `evidence_ids`, `tool_calls_json` (`tool`, args summary, result summary) | `apps/agent/src/events.ts` | P4's feed shows tool calls live |
| **P3-7** | 3:00 AM | **Replan:** watch `decision_epoch` / resource versions touching the active plan's resources; supersede the plan, cancel only safe-to-cancel actions, keep completed checkpoints, link the new incident, replan | `apps/agent/src/replan.ts` | XID 79 on job-a's destination mid-checkpoint → second incident, new destination, no double allocation |
| **P3-8** | 3:45 AM | **Crash + resume:** persist the workflow stage after every step; on boot, reclaim the workflow and reconcile each `command_key` (succeeded → skip; running → wait; absent → resubmit with the **same** key). Script `scripts/crash-test.ts` kills the agent at kit §6 points a–e | `apps/agent/src/resume.ts`, `scripts/crash-test.ts` | **Gate 3:** kill during the checkpoint, restart → no duplicate checkpoint; the agent continues to the move |
| **P3-9** | 5:00 AM / 8:00 AM | **`nemotronPolicy: Policy`** for P4's harness: the same triage + planner on an `ObservedSnapshot`, with no DB. Responses cached by prompt hash in `apps/agent/.cache/` (gitignored) to survive rate limits; the cache is disclosed on the scoreboard | `apps/agent/src/policy.ts` | P4 runs it on 10 scenarios |

## Prompting rules
- The system prompt says: you're a GPU-cluster incident engineer; use only tool data; cite `evidence_ids`; never claim a GPU is repaired; if unsure, say `needs_approval`.
- Send bounded JSON evidence (≤ ~6 KB), not raw telemetry streams.
- Keep reasoning short. If the model has a reasoning toggle, test both settings in P3-0 and pick the faster one that still calls tools correctly.
- Never put API keys in logs or in `agent_event`.

## Claude sub-agent prompts
- **P3-0 + P3-1:** "In `apps/agent` (TS, tsx, openai SDK) do P3-0 and P3-1 from plans/LANE-P3-agent.md. Own only `apps/agent/**`."
- **P3-2 ‖ P3-3** (after P3-1): two agents; `tools/**` vs `triage.ts`, each with its own tests on `createMockClient()`.
- **P3-6** can run in parallel with P3-5.
