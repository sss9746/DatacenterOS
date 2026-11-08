# DataCenterOS four-software-developer execution board (v1.1)

**All four people work on software.** Hardware is a joint, optional integration after the software demo passes the core gates. No software deliverable depends on having a working fan.

## Ownership and boundaries

| Developer | Primary responsibility | Owns | Does NOT own | First integration deliverable |
|---|---|---|---|---|
| **P1 — Simulation + safety + baseline policies** | Deterministic GPU cluster twin | `@dcos/physics` GPU/node/job/checkpoint models, thermal effects, Xid 79, fault injection, safety rules, `step()`, `simulatePlan()`, pure reactive + threshold baseline policy functions, test fixtures | SpacetimeDB reducers, LLM agents, UI | One seeded 8-rack fixture and pure transition functions with deterministic tests |
| **P2 — SpacetimeDB + durable execution** | Authoritative runtime and stable interfaces | TypeScript database module, public/private tables, clock scheduler, reducer implementations, idempotent command ledger, resource reservations, fencing tokens, workflow CAS/leases, subscriptions, generated DB client bindings, secure read/tool API | Physics rules, LLM reasoning, React visualizations | Live fixture running in DB; checkpoint moves `requested -> running -> succeeded` across ticks |
| **P3 — Nemotron + incident orchestration** | Evidence-driven and crash-resumable decisions | NIM endpoint test, diagnostic tools, incident/symptom correlation, candidate planning, `simulatePlan()` tool access, safety-gated command submission, two-incident reconciliation, durable workflow resumption, verified handoffs | Direct GPU state mutation, DB table definitions, UI | Agent reads an observable evidence snapshot and submits a valid, auditable action |
| **P4 — Frontend + evaluation + demo integration** | Real-time product and objective proof | React dashboard, GPU/rack heat map, jobs/checkpoint timeline, incident and agent-action feed, judge controls, evaluation harness invoking P1 policy functions and P3 agent through the same environment, reproducible metrics/scoreboard, demo story + presentation | Authoritative DB state mutation, fault physics, LLM backend | UI reflects live SpacetimeDB rows; one seed runs through 3 policies and produces real scores |

**Schema stewardship:** P1 owns `contracts.schema.json` and example payloads, but schema changes require review by P2/P3/P4. P2 owns SpacetimeDB-generated types and reducer names. P4 only uses generated types and public read models. No shadow interface definitions.

**Critical-path rebalance:** P2 must NOT build the dashboard. P4 must NOT implement a second simulation or hardcode score charts. P3 must NOT bypass P2's ledger. P1 must NOT invent a second state store.

## Day-one handoffs (parallel work)

1. **P1:** Add GPU/job/spec/current models to the shared wire contract; export a deterministic seeded fixture, `step(snapshot,input)`, `simulatePlan(observedSnapshot, candidate)`, and `evaluateSafety(state,action)`. Implement `reactivePolicy(observation)` and `thresholdPolicy(observation)` as pure, testable functions.
2. **P2:** Create real SpacetimeDB TypeScript module and generated client bindings from the frozen contract; seed `run-demo-1`; implement scheduled simulation ticks and durable action reducers with stubs where needed. Make a stable DB client/read projection available immediately.
3. **P3:** Smoke-test the actual Nemotron endpoint/tool-call response. Start with mocked P2 read/command clients using **the exact generated wire types**. Agent gets only observable evidence; no private fault truth or future schedule.
4. **P4:** Build the React screens against P2's fixture projections (temporary mock adapter matching generated types until DB live). Implement a policy-runner/scoreboard adapter that consumes P1 step/policy functions and executes P3 via a narrow policy interface; never use placeholder numbers as final results.

## Shared interfaces and owners

| Producer -> consumer | Contract | Acceptance |
|---|---|---|
| P1 -> P2 | `step()`, GPU/job state, scheduled action transitions, seeded fixture | DB tick matches offline physics for same seed/actions |
| P1 -> P3 | Observable snapshot, valid tool parameters, plan simulation + safety decision | Agent can compare options without reading fault truth |
| P2 -> P3 | Authorized `getSnapshot`, `getEvidence`, `requestAction`, `getActionStatus`, `claimWorkflow`, `updateWorkflow`, lease/fencing/version checks | Agent process crash can be recovered from ledger state |
| P2 -> P4 | Generated TS client, public read model, subscription queries, admin/judge reducer client with permissions | Live GPU heat map and event feed update after injected fault |
| P3 -> P4 | Public `agent_event` stage/evidence/summary and incident/action status | UI displays *real* reasoning stages, never raw private chain-of-thought |
| P1 + P3 -> P4 | Pure reactive+threshold policies; Nemotron policy adapter; scenario schedule and metrics | Same seeded scenario across policies; ground truth hidden until scoring |
| **All four -> hardware** | `HardwareSample` -> gateway -> `TelemetryEvent` (unchanged v1.0.0 contract) | Optional shared sensor demo; simulator works without it |

## Integration gates: pass/fail

### Gate 0 — Contract freeze and compiling skeleton

- `python validate_contracts.py` passes all JSON examples; generated TS types compile.
- SpacetimeDB TS module starts and generates client bindings; can invoke P1 pure package (or tested SDK-compatible adapter).
- React subscribes to actual `run-demo-1` rows with correct resource IDs and `sim_time_ms`.
- Nemotron returns a structurally valid tool call; tool execution remains server-side and safety-gated.

### Gate 1 — Working world, no AI

- Pump A degrades at sim-time 10,000 ms; racks 2–4 temperatures change under fixed seed.
- GPU throughput/job progress obey declared thermal profile; healthy jobs progress normally.
- Xid 79 makes a GPU unavailable; jobs consuming that GPU lose only work since a completed accessible checkpoint.
- Browser shows live incident/telemetry and job status from DB, not handcrafted state.

### Gate 2 — Durable manual actions

- A `checkpoint` command goes `requested -> running -> succeeded` over multiple sim ticks.
- Retrying the same `command_key` 10x produces one accepted logical action and one completed checkpoint.
- Unsafe placement onto hot rack, busy GPU, stale expected-version state or inaccessible checkpoint store is rejected with stable reason codes.
- Agent worker death does not cancel an in-progress simulator-owned checkpoint; leases and fencing reject stale owners.

### Gate 3 — Agent + stacked fault + crash

- P3 gathers evidence without private `fault_id`/future injection data; ties conclusions to visible evidence IDs.
- Pump problem triggers a plan; Xid 79 on proposed destination invalidates it and creates/links a second incident.
- Agent safely replans and does not double-allocate GPUs or issue duplicate checkpoints.
- Kill agent while checkpoint runs. DB tick continues; restart agent; it reconciles command and resumes with no duplicated completed work.

### Gate 4 — Judges + evaluation

- P4 runs >=10 seeded scenarios against (a) reactive rule, (b) threshold rule, and (c) Nemotron on identical initial conditions and fault schedules.
- Metrics include lost training work, job completion delay, GPU-busy wasted time, unsafe proposals/executions, needless moves and unfinished jobs.
- Dashboard scoreboard uses **real run outputs**, not manufactured scores. Disclose when replay is used due to Nemotron API/rate limits.
- Three-minute story: cooling degradation -> per-job choice -> safety block -> second fault -> replan -> agent crash/recovery -> baseline results.

### Gate 5 — Optional shared hardware sprint

- All four build/test ESP32-S3+MPU6050 fan setup together only after Gate 3 works; P2/P4 can jointly create gateway read-only adapter if time allows.
- `HardwareSample` validates; gateway authenticates/maps to `fan_sensor` telemetry, deduplicates via `source_seq`, and marks missing/stale samples.
- Fan vibration is a *measurement of that fan*; converting anomaly to simulated cooling degradation is an explicit demo policy, never an automatic factual diagnosis.

## Scope cuts if behind

1. Skip Xid 74, real network fault modeling, CMDB and Ceph additions.
2. Keep only cooling degradation + Xid 79, one checkpoint action, one migration/restart path, and safety validation.
3. Cut fancy 3D dashboard animations before cutting live telemetry, agent timeline, or benchmark truthfulness.
4. Drop power-cap if incomplete; preserve `keep`, checkpoint/pause, and move/restart.
5. Reduce 20 evaluation cases to 10. Keep two baselines, one true overlap scenario, crash recovery, and one rejected unsafe action.
6. Skip optional physical hardware demo entirely if it threatens software quality.

## Git integration rules

- **P1:** `/packages/physics`, `/packages/contracts`, scenario fixtures and pure policies.
- **P2:** `/apps/db` (SpacetimeDB schema and reducers), `/packages/db-client`, `/packages/commands` as appropriate.
- **P3:** `/apps/agent` and agent tool schemas/adapters.
- **P4:** `/apps/web`, `/apps/evaluation` (or `scripts/eval`) and `demo/` assets.
- Merge small, compileable PRs. Use one integration branch and smoke-test every Gate 1–3 after merges. Any changes to contract fields are schema-first, accompanied by fixture updates and regeneration.
