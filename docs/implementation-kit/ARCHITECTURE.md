bra# DataCenterOS — GPU Cluster Reliability: implementation architecture

**Version:** 1.1.0, 2026-11-07  
**Status:** implementation blueprint, not a claim that code is already integrated.  
**Scope:** configurable, software-first GPU cluster digital twin; Nemotron-supported incident diagnosis and safe, durable response to overlapping infrastructure faults. Four-person team, **four software developers**; hardware is an optional shared integration sprint.

## 0. Decisions to lock before any implementation

1. **Use TypeScript end-to-end in the software core**: existing `@dcos/physics`, SpacetimeDB module, Node.js agent orchestrator, and React dashboard. NVIDIA NIM/Nemotron is called via an OpenAI-compatible HTTP interface. This avoids requiring a Python SDK bridge for SpacetimeDB. A Python ML prototype can still be isolated behind HTTP if truly needed.
2. **SpacetimeDB is authoritative for the live run** (current resources, jobs, incident records, accepted commands, durable workflow checkpoints, and simulated clock). Never let frontend or agents independently mutate the GPU/job state.
3. **One pure physics function** powers live ticks, counterfactual plan simulations, and policy benchmarks. It must accept an explicit state, input, `step_ms`, and deterministic seed/RNG state; no filesystem, wall-clock dependency, or network access.
4. **Two clocks**: `sim_time_ms` determines physics, checkpoint duration, planned fault timing, and GPU-job progress. `observed_unix_ms` and lease expiration record real-world time. The simulation pauses, rather than jumping ahead, when the scheduled tick system is delayed or the database is down. The UI labels both clocks.
5. **Sole agent-to-world write path**: propose commands -> deterministic safety check -> durable command ledger -> constrained executor -> verification. An LLM never gets a direct `set_gpu_healthy` or `mark_job_completed` capability.
6. **Hardware is an optional observation source**, not a separate simulator. Physical sensor data uses exactly the same `TelemetryEvent` envelope and resource IDs after ingestion via a gateway. Ground truth about injected faults remains private.
7. **Freeze `contracts.schema.json` at v1.0.0**. All four developers use one checked-in generated TypeScript type package for external messages, plus generated SpacetimeDB client bindings for database tables/reducers. If a field changes, change contract version, regenerate, and update fixtures/tests.

## 1. System diagram and data ownership

```text
                   browser React + SpacetimeDB TS subscriptions
                                   | read live state
                                   v
        +------------------------------------------------------+
        | SpacetimeDB TS module (authoritative transactional)   |
        | resource / GPU / job / clock / incident / plan         |
        | action ledger / leases / workflow / audit / eval       |
        | private injected-fault truth                           |
        +----+------------------------------+------------------+
             | scheduled tick reducer        ^ validated reducers
             v                               |
       pure @dcos/physics                     |
       step(state, faults, seed)              |
       progress, thermal, fault effects       |
             | public observations           |
             v                               |
       metric & signal tables ---> Node.js orchestrator
                                   | 1. read evidence
                                   | 2. Nemotron diagnosis + candidate plans
                                   | 3. pure simulate_plan clone
                                   | 4. evaluateSafety (hard constraints)
                                   | 5. request action via reducers
                                   | 6. reconcile + verify + handoff
                                   v
                              NVIDIA NIM API

       optional later: ESP32/MPU6050 -> hardware gateway -> ingest telemetry reducer
```

**Critical anti-patterns:** do not store separate mutable cluster state in an API service; do not expose the injected `fault_injection` table to Nemotron; do not call model APIs inside a tick reducer; do not use browser-driven WebSocket broadcasts as a persistence layer; do not confuse SpacetimeDB transaction atomicity with exactly-once physical effects.

### Component responsibilities

| Component | Code location | Inputs | Outputs | Owns |
|---|---|---|---|---|
| Pure physics + simulation | `packages/physics` | snapshot, faults, deterministic tick | next state, metric/signal observations | deterministic system behavior and `simulate_plan` |
| Rules and safety | `packages/safety` | state, proposed action, affected dependency closure | allow/deny/retry and evidence | hard resource/workload invariants |
| SpacetimeDB | `apps/spacetimedb` | reducer calls, scheduled clock | durable tables + subscriptions | *only authoritative live state* |
| Node agent orchestration | `services/orchestrator` | subscribed incident/workflow state | plan proposals and commands | reasoning and resilient coordination; no unguarded writes |
| Dashboard | `apps/dashboard` | generated subscriptions | facility / jobs / incidents / explanations / score | UX only |
| Test runner | `packages/evaluation` | seeded scenarios + policy | reproducible metrics | fair evaluation, isolated from live demo |
| Hardware gateway | `hardware/gateway` | `HardwareSample` frames | `TelemetryEvent` frames | sensor authentication/mapping/validation |

**Integration note:** a TypeScript SpacetimeDB module runs in the database host, not a normal Node.js runtime. Audit the existing physics library for Node-specific dependencies and test a real module import immediately. If the physics package cannot run in-module, a single trusted simulation worker may compute transitions externally and submit version-checked state transitions; this fallback requires careful single-writer enforcement, so prefer the in-module pure-function path.

## 2. Modeling scope and fidelity

### Facility graph

Default demonstration preset: **8 racks, one 8-GPU node per rack, three distributed or single-node training jobs**, cooling pump A influencing racks 2–4, simplified shared checkpoint storage, and named failure domains. This is an illustrative model, *not* a claim of NMC²'s exact facility topology.

`resource` supports `rack`, `node`, `gpu`, `cooling_pump`, `cooling_loop`, `network_link`, `checkpoint_store`, `fan_sensor`, `power_domain`. `dependency_edge` direction is `consumer_id -> provider_id`, e.g. a GPU depends on its node, a rack is cooled by pump A, a job uses a checkpoint store. Graph dependencies drive blast-radius search and safety checks. A component can have multiple providers; `weight` is a simplified allocation factor and not a real engineering load-flow model.

**Model only the necessary physics**: thermal headroom from existing cooling/temperature engine, rack power availability and headroom, GPU throughput reduction when the modeled slowdown profile is active, and job progress measured in work units. No invented full fluid-dynamics, real NVLink packet emulation, or per-microbatch GPU architecture behavior. Label all thermal thresholds and recovery times as simulated configurable assumptions. For real profiles, use device-specific documented slowdown/shutdown fields when available.

### First three core fault types

- **Cooling pump degradation**: lowers model cooling capacity; causes correlated rack intake/GPU temperatures; may eventually throttle GPUs. It is not a claim that every cooling failure always migrates jobs.
- **Xid 79**: driver loses PCIe access to a GPU. Generate an Xid event and eventually missing/unavailable telemetry; non-elastic distributed jobs using that GPU fail and lose work since their last *completed accessible* checkpoint.
- **Xid 48** (secondary if time): double-bit ECC fault. In the MVP profile model it requires investigation, cordoning and potential job interruption; real remediation depends on GPU generation and full Xid context. Do not hardcode a universal reset policy.

Tier 2: Xid 74 NVLink connectivity and actual Ethernet/InfiniBand network link faults must remain separate. A real fan sensor anomaly is not itself proof of pump failure. Optionally map it through an *explicit demo policy* to a simulated reduction in cooling, with the mapping visible.

### GPU telemetry mapping

Use `DCGM_FI_DEV_GPU_TEMP_CELSIUS` (150), `DCGM_FI_DEV_CLOCKS_EVENT_REASONS` (112), `DCGM_FI_DEV_SM_CLOCK` (100), `DCGM_FI_DEV_XID_ERROR` (230), `DCGM_FI_DEV_ECC_DBE_VOL_TOTAL` (311), slowdown temp (158), shutdown temp (159), and power fields per NVIDIA's current field ID reference. Xids are discrete `SignalEvent` records as well as optional numeric DCGM-like telemetry: **never treat an Xid code as a persistent temperature-like gauge**. `quality=stale/missing` is a first-class observation when a GPU disappears.

### Job and checkpoint semantics

A job reserves **all** its required compatible GPUs atomically (`same_node` or simplified gang multi-node). A placement is invalid unless all resources are actually free, sufficiently powered/cooled, allowed by failure-domain and GPU-profile constraints, and checkpoint storage is accessible.

Each job contains `gpus_required`, compatible nodes, `preemptible`, `checkpoint_supported`, checkpoint duration, restart duration, checkpoint storage, current `progress_work_units`, `durable_work_units`, and a completed checkpoint ID. For non-elastic training, any required GPU's loss fails the whole job. Progress gained since the latest completed accessible checkpoint is lost on a crash. A new checkpoint only becomes durable when its writing action completes *and* storage/required sources remain valid. Do not mutate `durable_work_units` when a checkpoint merely starts.

Migration is **checkpoint -> complete persisted checkpoint -> free/cordon old placement as appropriate -> atomically allocate all destination GPUs -> restart -> verify progress**. The operation can fail at every stage; never describe it as instant live migration. Non-preemptible jobs are not automatically eligible for voluntary moves, although a hardware failure may still interrupt them. If no safe placement exists, the correct answer may be pause/wait/escalate.

## 3. Runtime state and clocks

Use `sim_time_ms` integer increments of `step_ms=1000` by default; one wall-clock scheduled invocation can advance one logical step (configurable UI speed). This gives stable deterministic replay while allowing 1x–5x demo speed. `decision_epoch` only advances on material changes to availability, placement, topology, active faults, thermal threshold state, or constraints; do **not** invalidate every plan due to every normal metric sample. Individual resource versions advance on relevant state changes. Every external event is assigned an idempotent ID and per-source sequence number.

On each scheduled `advance_tick` transaction:

1. Read run clock + `PhysicsWorld` (public observations plus private active faults/hidden physics state) + private fault schedule.
2. Apply faults due at the new logical time; update provider dependencies; advance physics and job progress.
3. Resolve previously scheduled checkpoint/restart actions whose `due_sim_time_ms` has arrived, subject to **completion-time** safety checks.
4. Emit typed observations (`TelemetryEvent`, `SignalEvent`) and update GPU/job/incident-relevant state. New observations can generate incident candidates; only the orchestrator confirms associations.
5. Update run clock and `decision_epoch` for material changes; commit atomically.

**Delayed-operation ordering:** if a fault and an action completion share a tick, pick a documented stable order (fault applies first, then command completion revalidates). Never depend on SpacetimeDB's cross-schedule dispatch order to provide application ordering.

Use SpacetimeDB's scheduled reducer as the wall clock, but logical time and action due times live in domain tables. Schedule ticks are not equivalent to physical device clocks, and missing scheduled intervals are not blindly replayed on restart.

## 4. Many-incident Nemotron workflow

One incident can contain multiple symptoms; a symptom or a job can belong to several incidents. Don't force a shared cause. An independent Xid 79 that arrives during a cooling incident creates a second incident, while invalidating decisions touching the affected destination GPUs.

**Agent roles (can be functions in one persistent orchestrator process, not five separate infrastructure services):**

1. **Triage & correlation:** subscribe to new symptoms, group temporally/topologically, propose incidents with evidence IDs; never see private injected fault truth.
2. **Diagnosis:** Nemotron receives bounded telemetry timelines, dependency graph snippets and job impact; returns candidate causes, supporting evidence and uncertainty. It can request more tools. Do not directly trust unverified diagnoses.
3. **Planner:** enumerate concrete `keep_running`, `power_cap`, `checkpoint`, `pause_job`, `cordon_gpu`, `migrate_restart`, `escalate` candidates; query deterministic `simulate_plan` on a **snapshot clone**. Each plan stores `based_on_decision_epoch` and assumptions.
4. **Coordinator:** acquire resource leases, reconcile overlaps with all current incidents, validate against current state, submit durable commands. Never let independent LLM actors directly execute against a shared job/GPU.
5. **Verifier/handoff:** check job resumed, GPU unavailable remains cordoned, cooling headroom and work progress improved; record a concise evidence-cited operator handoff. If data is stale or no safe option exists, escalate rather than falsely marking recovery.

**Nemotron access:** connect to a model actually available to the team via NVIDIA's NIM OpenAI-compatible `/v1/chat/completions` and verify `tools`/`tool_choice` support on that model. Keep model identifier and base URL configurable; do not hardcode or assume all Nemotron variants share tool-calling constraints. Validate every tool-call JSON argument against contracts and allowlisted operations. Limit tokens, tool iterations, retries and timeout; persist a structured action/observation summary rather than a private freeform reasoning trace. Model outage -> safe deterministic fallback/needs human approval.

**Tools made available to the LLM (read-only until coordinator):**

- `get_incident_evidence(incident_ids, window_sim_ms)`
- `get_resource_dependencies(resource_ids, depth<=3)`
- `get_job_state(job_ids)` and `list_placement_candidates(job_id)`
- `simulate_plan(plan)` -> projected completion delay, lost progress, thermal/power violations, and assumptions
- `propose_plan(plan)` -> persists proposal, not execution
- `get_action_status(command_key)`

Only the **coordinator** (not an LLM tool call) may invoke `request_action` after a hard safety check.

## 5. Hard safety constraints and counterfactual planner

For each proposed plan, first require:

- all destination GPUs healthy, compatible, available, fully allocated together and not under another lease;
- sufficient headroom on destination nodes/racks for expected heat and power;
- latest checkpoint completed and accessible to destination, unless plan explicitly performs and verifies a new checkpoint;
- never claim a failed GPU repaired by `cordon`, `restart_job`, or `migrate_restart`;
- valid `expected_resource_versions` plus unchanged relevant `decision_epoch`; no new material fault invalidating assumptions;
- no contradictory actions against a shared job, GPU, node or cooling failure domain; no stale fencing token;
- obey job's preemptibility; no unsupported migrations; no unsafe forced rack shutdown;
- stale/uncertain evidence or no feasible plan -> `needs_approval` or `escalate`.

The planner evaluates valid alternatives over a finite horizon (illustratively 5–10 simulated minutes). Suggested multi-objective ranking: first minimize **unsafe executed actions (hard zero)**, then prevent expected irreversible work loss, then minimize aggregate job completion delay, then wasted GPU-busy seconds and number of unnecessary preemptions. The weighting and assumptions must be visible; don't claim an oracle-optimal schedule. The pure engine's `simulate_plan` must be the same function used for every policy and benchmark. **Planner inputs are `ObservedSnapshot` estimates, not `PhysicsWorld.active_faults_private`, `SimulationTickInput.due_faults_private`, or hidden future events**; private world truth remains exclusively with the live simulation and evaluation oracle. Agent-facing results must not contain scenario ground-truth identities or future hidden faults.

## 6. Durable action protocol

`action` lifecycle: `requested -> claimed -> running -> succeeded | failed | cancelled | needs_reconciliation`. Unique `command_key` identifies the logical operation, not just the attempt. `action_event` is append-only for audit. `resource_lease` represents an **action-owned reservation**, with an owner action, `expires_at_unix_ms`, and monotonic `fencing_token`. **Workflow ownership is a separate, short-lived coordinator lease.** An already-running simulator checkpoint must not lose its resource reservation just because the Node agent crashes; the scheduled DB tick maintains it until completion/reconciliation. `workflow` stores stage, incident IDs, last processed event sequence, planned next step, and its coordinator lease ownership.

### Claim and execute

1. **Submission** (atomic reducer): verify caller role, command payload, unique key; compare expected epoch/versions; test hard safety constraints; create action if absent. Repeat with same `command_key` returns existing action without duplicate side effects.
2. **Claim** (atomic reducer): ensure no conflicting action reservation, acquire all required resource reservations in sorted ID order (single transaction) and increment fencing tokens; mark `claimed`. A separate short workflow lease controls *which orchestrator worker* may plan next.
3. **Start** (atomic reducer): compare leases/fencing and revalidate resource versions, mark `running`, schedule completion at `due_sim_time_ms`. A checkpoint does *not* become durable at start.
4. **Complete** (from scheduled tick): verify action still owns its durable reservations/fencing, revalidate **the command-specific affected resources** rather than rejecting every unrelated global epoch change, commit checkpoint/placement/job transition *once*, mark `succeeded` and release leases. If preconditions no longer hold, mark `failed` / `needs_reconciliation`; cancel future dependent actions and trigger replanning. For a failed checkpoint, durable work does not increase.
5. **On any agent restart**: reacquire workflow ownership; query each command by key and reconcile observed state. `succeeded` -> skip; `running` -> wait/reconcile, not resubmit with a new key; absent -> submit with the same key. Use timeouts/leases and compare-and-swap tokens to reject stale owners.

**Lease crash rule:** a claimed but never-started action may eventually time out and release reservations. A **running action** remains reserved under DB supervision even if the agent crashes; only a verified success, cancellation, explicit failure, or reconciliation releases its resources. Agent crash must not turn in-flight work into a duplicate or orphaned command.

**Critical distinction:** transactional once-only simulator transitions are realistic. Exactly-once **external hardware** effects cannot be promised based on database atomicity; adapters must accept idempotency keys and expose read-back/reconciliation. Likewise, a command can be successfully committed even if the caller loses its acknowledgement; ledger queries resolve ambiguity.

**Crash tests:** kill agent (a) before request, (b) after request/ack lost, (c) after claim, (d) during a checkpoint, (e) after checkpoint completion but before next plan step; also inject a second fault during checkpoint. Assert no duplicate completed checkpoints or double GPU allocations, and recovery from persisted state.

## 7. Storage layout in SpacetimeDB

See `CONTRACTS.md` for the frozen table dictionary. The public projection should include run clock, resources, `gpu_current`, `job_current`, incidents/symptoms/links, command status, safe agent event summary and evaluation scores. `fault_injection_truth` and authentication/device mappings are private. Store telemetry history as bounded samples or low-rate rows (sample GPU temperatures <=1 Hz in MVP); do not stream full 64-GPU telemetry at 100 Hz to the database. Prefer aggregated current state for UI; maintain an append-only event/audit log at a bounded rate.

A public SpacetimeDB table is readable by connected clients; it is not an access-control mechanism for privileged *writes*. Validate `ctx.sender`/authorized roles in admin reducers like `inject_fault` and service-only reducers like `ingest_observations` or `submit_action`. Do not store NIM API keys or hardware secrets in public tables.

## 8. Hardware integration now vs later

**Build software now**: mock telemetry producer uses `TelemetryEvent` contract with `source_kind='simulator'`; write `ingest_hardware_sample` gateway tests, but no UI or agent is allowed to depend on the physical fan.

**During the shared hardware sprint, the team** sends `HardwareSample` JSON from ESP32-S3/MPU-6050 via serial or local HTTP to a small Node gateway. The gateway authenticates the sender, checks sequencing/calibration/range, maps `sensor_id` to an existing `fan_sensor` resource, stamps the current `sim_time_ms`, and writes normalized telemetry (`source_kind='hardware'`, `metric='fan.vibration_rms_g'`, `unit='g'`). Reject duplicate/old frames; mark missing and stale data explicitly. Temperature effects still come from deterministic simulation; a special **opt-in demo rule** may translate prolonged fan anomalies into reduced modeled cooling efficiency and must be labeled as such.

Plan for safe physical testing: secure motor and imbalance mechanism inside a guard, use an appropriate motor driver and independent power, and do not make the hardware failure a prerequisite for software acceptance.

## 9. Benchmarks and measurements

**Policies:** (1) reactive rule baseline (recover only from hard errors), (2) threshold-based preventive baseline (simple temperature/power triggers), (3) Nemotron planner. All receive identical *observable* inputs and the same initial fixture/seed, use the same core step and resource/safety constraints, and are tested on both single and stacked faults.

Score: total lost work units since durable checkpoints, added wall/sim completion delay vs a no-fault reference, GPU-busy seconds wasted, needless preventive moves, unsafe actions proposed/blocked/executed, successful recovery and recovery latency. Show distributions, not only best case. Some jobs may not finish within the test horizon: report unfinished count or lower-bound delay; do not treat never-finished jobs as zero delay.

Design at least 10 cases, grow to 20: thermal warning/no actual failure; pump severe; failed GPU; pump+GPU mid-checkpoint; GPU loss after checkpoint; no spare capacity; non-preemptible job; destination hot; checkpoint storage inaccessible; telemetry stale; agent killed at each protocol boundary; two independent incidents; harmless temperature spike; near-complete job where staying wins; preventive move that hurts performance. Keep separate hidden evaluation fault truth away from Nemotron. Record a seed, profile, policy version and all commands for reproducibility.

## 10. Four-software-developer allocation and integration gates

| Person | Core ownership | Deliverables | Acceptance proof |
|---|---|---|---|
| **1 — simulation/safety** | `@dcos/physics`, GPU/job/checkpoint model, deterministic constraints, seeded faults, pure reactive/threshold policies | `step()`, `simulatePlan()`, `evaluateSafety()`, fixtures, pure baseline functions | identical state/seed/actions produce identical results; safety denies impossible placements |
| **2 — DB/durability** | SpacetimeDB TS module, generated bindings, clock, command ledger, actions, leases/reservations, workflow CAS, authorized read paths | schema, reducers, scheduled tick, generated client and evidence/command interfaces | DB progresses without agent; checkpoint lasts multiple ticks; duplicates/stale owners rejected |
| **3 — Nemotron/orchestration** | Node agent, evidence correlation, planning, safe tool calls, incident coordination, persisted workflow/reconciliation | agent service, evidence IDs, plan submissions, recovery verification, verified handoff | fault -> safe decision -> command -> verification; kill/restart resumes safely |
| **4 — frontend/evaluation** | React live dashboard and reproducible baseline comparison harness | GPU heat map, incident/job/action timelines, fault controls, scoreboard, scenario runner, pitch | UI displays live DB subscriptions; baseline metrics come from actual seeded runs |

**Ownership rules:** P1 owns pure simulation and safety semantics plus the cross-service JSON schema; P2 implements durable reducer transactions and generated bindings; P3 consumes only P2's authorized command/evidence interfaces; P4 consumes only public DB/read projections and the common evaluation policy interface. All four review frozen contracts. P2 does **not** build React; P4 does **not** implement an alternate simulator. Hardware is **all four together**, later, and is never required to pass software gates.

### Build order (vertical slices, not feature silos)

**Gate 0 — contracts freeze:** check in this blueprint, `CONTRACTS.md`, `contracts.schema.json`, examples. Generate TS types; SpacetimeDB module compiles, client bindings generate. Confirm import of pure `@dcos/physics` inside SpacetimeDB module.

**Gate 1 — no-AI working vertical slice:** a fixture spins up; cooling degrades; GPU temperature/throughput changes; jobs progress; frontend subscriptions update. Manually submit a validated `checkpoint` command that transitions `requested/running/succeeded` across ticks.

**Gate 2 — agent effect:** Nemotron queries evidence, chooses a valid plan; plan simulator and safety validator run; command appears in durable ledger; job state changes and verification succeeds.

**Gate 3 — overlap + durability:** inject Xid 79 on destination during recovery; stale plan fails; coordinator replans. Kill Node orchestrator mid-checkpoint and restart; ledger proves checkpoint wasn't committed twice.

**Gate 4 — proof:** reactive and threshold baseline runs, seeded scenarios, side-by-side scoreboard with failure cases. Freeze results only after collecting real outputs.

**Gate 5 — optional:** hardware-to-telemetry mapping and fan demo; deeper GPU/network failures.

### Integration contract between pairs

- **P1 -> P2:** `step(snapshot, tickInput)`, GPU/job models, fixture and safety decisions; tests in Node **and** within DB SDK constraints.
- **P1 -> P3:** `ObservedSnapshot` (no private fault truth), `simulatePlan`, `evaluateSafety`, valid action parameters and stable reason codes.
- **P2 -> P3:** generated DB client and authorized evidence/command/workflow APIs: `getSnapshot`, `submitPlan`, `requestAction`, `claimWorkflow`, `heartbeatWorkflow`, `updateWorkflow`, `getActionStatus`.
- **P2 -> P4:** public subscription model, generated client, run/fault administration endpoints with explicit authorization; no private truth in agent channels.
- **P3 -> P4:** public `agent_event` summaries (`incident_id`, `workflow_id`, `stage`, `summary`, `evidence_ids`, `sim_time_ms`) and real command status.
- **P1 + P3 -> P4:** policy runners and plan metrics for identical scenarios; P4 owns evaluator orchestration/reporting, not physics semantics.
- **All four -> hardware later:** canonical `HardwareSample` -> gateway -> `TelemetryEvent`; no change to software state schema.

## 11. Exact minimum demo

1. Show an 8-rack configurable GPU cluster with 3 jobs and initial checkpoints.
2. Inject pump A degradation. A correlated temperature pattern develops; the agent distinguishes underlying pump problem from symptoms.
3. It considers `keep`, `cap`, and `checkpoint+relocate` and logs projected completion delay and lost progress. A hot destination is rejected by deterministic safety.
4. Begin a valid checkpoint. Inject Xid 79 on the intended destination mid-recovery. The destination is disqualified; the second incident is tracked separately and the plan is invalidated.
5. Kill the Node agent process. SpacetimeDB continues the simulated checkpoint. Relaunch the agent: it detects the completed operation by command key and chooses another safe placement without duplication.
6. Show results versus both policy baselines, including false preventive moves and any scenarios where the agent lost.

**Do not demo:** direct hardware control, invented self-healing of broken GPUs, unrestricted arbitrary failure types, and future faults revealed to the planning agent.

## 12. Reference documentation and caveats

- SpacetimeDB tables, reducers, scheduled reducers, transactions, and generated TS bindings: https://spacetimedb.com/docs/tables/ ; https://spacetimedb.com/docs/functions/reducers/ ; https://spacetimedb.com/docs/tables/schedule-tables/ ; https://spacetimedb.com/docs/clients/codegen/
- SpacetimeDB TS fixed-rate tick: https://spacetimedb.com/docs/how-to/games/fixed-rate-game-tick/
- NVIDIA DCGM field IDs: https://docs.nvidia.com/datacenter/dcgm/latest/dcgm-api/dcgm-api-field-ids.html
- NVIDIA Xid catalog: https://docs.nvidia.com/deploy/xid-errors/620/analyzing-xid-catalog.html
- NVIDIA Run:ai checkpointing and shared storage: https://docs.nvidia.com/run-ai/self-hosted/documentation/workloads-in-nvidia-run-ai/using-training/checkpointing-preemptible-workloads
- NVIDIA NIM tool calling: https://docs.nvidia.com/nim/large-language-models/1.15.0/function-calling.html

All numeric thermodynamic constants, transfer times, restart times, and performance estimates must be sourced from actual device profiles or labeled **simulated and configurable**. The prior team's 95 passing physics tests and any existing module code were not independently inspected here. This specification defines interfaces and tests but does not claim all components already compile together.
