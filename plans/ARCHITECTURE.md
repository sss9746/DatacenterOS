# DataCenterOS — current implementation architecture

**Updated 2026-11-08.** Fixed-cluster hackathon scope, audited against main `95e1abd`. [CONTRACTS §0](CONTRACTS.md) governs interfaces; [scope](IMPLEMENTATION-SCOPE.md) governs the product; [tasks](IMPLEMENTATION-TASKS.md) defines remaining work. Requirements below are not claims that their acceptance tests already pass.

## 0. Decisions

Keep the existing TypeScript simulator, SpacetimeDB module, Node orchestrator and React dashboard. Remove the topology editor. Finish a fixed 64-GPU reliability demonstration rather than adding new infrastructure models. Wire schema remains 1.1.0; the optional evaluation provenance extension in CONTRACTS §0.14 is pending implementation and coordinated rollout.

## 1. System and ownership

```text
React dashboard <-- public subscriptions -- SpacetimeDB authoritative state
                                                   |
                                      scheduled tick + pure physics
                                                   ^
                                      validated command reducers
                                                   |
Node orchestrator --> observed snapshot --> cloned plan simulation
       |
       +--> NVIDIA NIM: bounded diagnosis, tools and plan selection
```

| Component | Path | Responsibility |
|---|---|---|
| Simulation, safety, baselines | `packages/physics` | Pure deterministic state transitions, observed forecasts, hard constraints |
| Contracts | `packages/contracts` | Shared schemas, validation and types; integrator owns changes |
| Database | `apps/db` | Authoritative world, clock, public projections, action ledger, leases and workflow state |
| Client | `packages/db-client` | Typed live/mock access and generated bindings |
| Orchestrator | `apps/agent` | Evidence, model calls, coordination, reconciliation and verification |
| Dashboard / evaluator | `apps/web`, `apps/evaluation` | Operator view and reproducible comparisons |

Main contains these packages; the current P2 checkout does not contain every main directory. Do not recreate missing packages from this branch. Physics runs directly inside the TypeScript DB module; no second mutable simulation service is needed. Model calls run outside reducers.

## 2. Modeling scope

[Scope §2–3](IMPLEMENTATION-SCOPE.md) freezes IDs, constants, jobs and supported faults: eight racks, eight nodes, 64 illustrative GPUs, two cooling loops/pumps, one checkpoint store, one simplified power boundary, and three non-elastic jobs. Power is GPU-only; there are no preset facility power budgets. Links exist as records, but ordinary link faults do not model network disruption.

Required controls are pump degradation and Xid79. Existing secondary faults remain regression cases. Real NVIDIA Xids require context; this simulator's response is a labeled scenario assumption. No arbitrary fault interpreter, physical repair, fluid dynamics or real training is claimed.

Checkpoint protection advances only after a completed valid write. Migration uses checkpoint → allocate destination and release source at migration start → simulated restart → verify. Restart completion does not perform the initial allocation. The fixture's checkpoint interval is descriptive; automatic periodic checkpointing is not implemented.

## 3. Clock and delayed operations

The preset starts at `sim_time_ms=600000`. A scheduled invocation advances one to five logical 1,000-ms steps according to speed; pause stops logical progress. Lease expiration uses wall time. Missed scheduled intervals do not imply replay of all missed physics ticks.

Physics accounts for the elapsed interval, applies due faults and processes commands in its deterministic tick sequence. A fault due on a completion tick must affect that completion's checks. R1 must use current fault effects and derived conditions, not cached pre-fault headroom.

A material decision epoch protects new proposals; unrelated epoch changes must not invalidate a healthy in-flight checkpoint. Resource-specific checks govern delayed completion.

## 4. Agent workflow

Roles can be functions in one Node process: triage/correlation, diagnosis, candidate planning, coordination, verification/handoff. Code enumerates candidates and calls `simulatePlan`; Nemotron can select and explain options through bounded, validated tools. Only coordinator code submits constrained actions.

The agent receives observed snapshots and evidence, never private fault schedules or future scenario truth. Persist concise tool results, evidence references and decisions, not raw chain-of-thought. Record `actor=model` only for actual model-produced events; deterministic stages and fallbacks use `actor=code`.

## 5. Safety and counterfactuals

Forecasts clone an estimated world from observations and assume observed degradation persists. They do not run a full copy of a real data center or reveal future faults. Forecast outputs are estimates, not measured outcomes or calibrated probabilities.

Check compatibility, gang placement, ownership, eligibility, healthy resources, relevant freshness, projected thermal/power headroom and accessible checkpoints. Reject stale versions/tokens and conflicting work. Hard violations cannot be overridden by a model or a violation-free approval policy.

**Open fixes:** R2 makes start-time handling reject all nonempty safety violations, including stale evidence. R1 adds phase-aware restart completion checks, including own-allocation exclusion and coherent cleanup on failure. The existing implementation is not yet sufficient evidence for these guarantees.

## 6. Durability protocol

1. Request: validate authorization, payload, versions and safety; deduplicate by logical command key.
2. Claim: atomically reserve resources and issue fencing tokens. Workflow ownership is a separate lease.
3. Start: revalidate current preconditions; mark running and enqueue the operation.
4. Complete: DB ticks advance the operation without the agent. Recheck command-specific conditions; commit success once or record failure/reconciliation.
5. Resume: a fresh agent claims workflow ownership, reads persisted commands and state, and reconciles existing keys before doing further work.

Fencing tokens reject stale owners; **they do not store halted progress**. Workflow records, action records and completed workload checkpoints store different kinds of durable state. Running action reservations remain DB-supervised after an agent crash.

A failed restart preserves durable work and leaves coherent placement; it must not invent a rollback to a source already released. Do not reset the fixed-ID demo while old agents remain connected: stop agents, close clients, reset, then start fresh processes.

The real-process R5 tests remain required. Existing fake-backed agent tests and P2's caller-kill checkpoint test prove narrower properties. DB atomicity does not establish exactly-once external hardware effects.

## 7. Persistence and public views

Private world/fault truth stays separate from public resource, job, incident, action, event and evaluation projections. Reducers enforce caller roles; public rows never contain credentials.

Use existing `onActionDetails` for operation, evidence, timing and lifecycle history. Keep bounded telemetry and persist verification facts/handoffs so evidence does not disappear with telemetry retention. The browser rebuilds state on reconnect; it does not own simulation state.

## 8. Optional hardware

P2-9 ingestion is optional after software gates. A Raspberry Pi Pico 2 W microphone sound sensor and real GPU telemetry are observation sources. Label any sound-to-simulated-cooling mapping and leave it opt-in. `gpu-real-0` is never allocatable and has no current telemetry row until ingestion. Hardware is not required for the software demonstration.

## 9. Evaluation

Use the same simulator, initial fixture, seed, horizon and safety rules for reactive, threshold and model-assisted policies. Policies naturally produce different later observations. Freeze the 12-case matrix in scope §7 before reviewing outcomes; all 20 fixtures are optional expansion.

R6 supplies a checked-in adapter, fresh model-policy instance per case, matched comparison IDs, artifact traces and per-case provenance. At least 36 matched rows are required. Label live model responses, cache use, fallbacks, unfinished jobs and zero simulated decision latency. Measure model wall latency separately. Never infer model use solely from a policy name.

The existing DB key overwrites scenario/policy/seed rows; preserve batch artifacts and refuse mixed-batch comparisons. Performance superiority is not assumed.

## 10. Owners and gates

P1 owns R1; P2 owns R2 and provenance persistence; P3 owns R3 and the R5 harness; P4 owns R4, R6 and presentation. The integrator owns R0 and cross-lane contracts. Detailed acceptance criteria are in [IMPLEMENTATION-TASKS.md](IMPLEMENTATION-TASKS.md); current evidence is in [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md).

Gate definitions and evidence checkboxes are centralized in [plans/README.md](README.md). Historical P2 Gate 2 success is retained as DB proof, not relabeled as complete overlap/crash recovery.

## 11. Minimum demonstration

Show the fixed cluster and three jobs; inject pump degradation; inspect evidence and candidate projections; show a genuinely blocked hot destination; begin recovery; inject Xid79 on the actual planned destination; kill and restart the actual agent during a source checkpoint; reconcile and recover or explicitly escalate. Show the persistent operator handoff and measured comparison.

Trigger overlap from observed operation state, not a guessed timer or hardcoded destination. Use R5's separate tests as well as its combined rehearsal. A paused clock is not successful verification. Pump service remains unresolved even if the workload recovers.

## 12. Sources and limits

[RESEARCH.md](RESEARCH.md) links primary NVIDIA, SpacetimeDB, AWS and incident-response sources, with explicit mappings to decisions. Numeric defaults are illustrative and are listed in the scope. Existing NVIDIA recovery products already automate important parts of this problem; our demonstration emphasizes visible shared dependencies, durable coordination, constrained decisions and operator handoff.
