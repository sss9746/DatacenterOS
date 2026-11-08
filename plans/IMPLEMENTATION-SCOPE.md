# Fixed-cluster implementation specification

**Decision date:** 2026-11-08, America/Chicago. **Approved direction:** remove the topology editor; finish a focused GPU reliability demonstration. This is the current product scope. [Implementation status](IMPLEMENTATION-STATUS.md) separates existing code from proof; [remaining tasks](IMPLEMENTATION-TASKS.md) assigns the work; [research](RESEARCH.md) records sources and limitations. Shared identifiers and interfaces remain governed by [CONTRACTS.md §0](CONTRACTS.md).

## 1. Product and explicit boundary

Help an operator understand a GPU workload incident, compare recovery options, execute a constrained response, and hand over the unresolved work. Demonstrate this on the fixed `gpu_demo_8` cluster with simulated infrastructure and actual Nemotron calls when available.

The user can inspect resources, select a supported fault target, inject overlapping faults, pause/speed the simulation, and inspect recovery evidence. The topology is read-only. There is no component builder, custom rack count, mixed GPU profile editor, arbitrary fault interpreter, physical repair, or production infrastructure control. Keep existing extra scenario fixtures and v0 tests; removing UI scope does not require deleting working code.

**Submission requirements:** live pump recovery; unsafe destination blocked; a second independent fault; actual orchestrator crash/restart; durable operator handoff; measured comparison with disclosed model usage. Superior performance is a hypothesis, not a required result to manufacture.

## 2. Exact component inventory

| Component | Fixed inventory / IDs | State and decision purpose | Boundary |
|---|---|---|---|
| Racks | `rack-r1` … `rack-r8` | Cooling membership and projected thermal headroom | Display-only layout; one node per rack |
| Compute nodes | `node-r1-n1` … `node-r8-n1` | Eight GPUs each; same-node/gang placement, availability and headroom | No CPU/RAM/NUMA scheduling |
| GPUs | 64 `gpu-r{1..8}-n1-{0..7}`, profile `demo_gpu` | Availability, temperature, SM clock, power/limit, throttle bits, last-seen time, Xid, version | Illustrative profile; not calibrated H100 hardware |
| Cooling | `pump-a` → `loop-a` → r2/r3/r4; `pump-b` → `loop-b` → r1/r5/r6/r7/r8 | Shared cause, observed pump power/capacity estimate, evolving loop temperature | Lumped heat balance; no flow/pressure/CFD or automatic pump repair |
| Power | `power-main`; existing node GPU-power headroom | Constrain placement and compare power-cap response | GPU-only draw. Preset has no rack/domain `power_budget_w`; do not display invented facility capacity. Budget checking in safety remains supported for tests |
| Checkpoint storage | `ckpt-store-1` | Shared checkpoint accessibility and completed durable work | Boolean accessibility and fixed write time; no bandwidth, replication or corruption model |
| Jobs | `job-a`, `job-b`, `job-c` | Current/durable work, exact placement, checkpoint age, eligibility | Fixed non-elastic workloads, not arbitrary training frameworks |
| Orchestrator | Node process outside the DB | Workflow stage, ownership, command reconciliation, evidence and handoff | Roles in one durable process are sufficient; no service-per-agent requirement |
| Optional observations | `fan-sensor-r3`, `gpu-real-0` on `node-real-0` | Clearly attributed hardware telemetry | Not a software gate. Real GPU never allocatable; no `gpu_current` row until ingestion |

Existing `link-r1` … `link-r8` resource records may remain. A link-down alarm does not currently change training throughput or connectivity; no network control is advertised.

### Job fixture

| Job | Placement / GPUs | Protected state at run start | Recovery constraint |
|---|---|---|---|
| `job-a` | r2+r3 / 16 | Durable 86,400; progress 95,040; checkpoint 9 min old | Preemptible, checkpoint supported; 8,640 work units initially at risk |
| `job-b` | r4 / 8 | Durable 40,000; progress 40,480; checkpoint 1 min old | Preemptible; consider keep/cap after accounting for job-a's heat removal |
| `job-c` | r6 / 8 | Progress 30,000; no checkpoint | Non-preemptible, no checkpoint support; r6 is occupied and deliberately hot |

Free racks at start: r1, r5, r7, r8. Do not hardcode an expected destination; inspect the selected plan. A synchronous job's required-GPU loss fails that modeled job and rolls progress back to durable work. This is a workload assumption, not a universal property of every training system.

### Numeric model contract

All values below are **simulated defaults**, visible in a compact model-assumptions panel; users do not edit them during the demonstration.

| Parameter | Current value |
|---|---|
| Run start / tick / speed | 600,000 sim-ms / 1,000 sim-ms / 1–5 logical steps per scheduled wall second |
| Nominal / idle / capped GPU draw | 700 W / 70 W / 500 W |
| Nominal clock / thermal / cap factor | 1,980 MHz / 0.70 / 0.85 |
| Healthy inlet / hot-r6 offset | 35°C / +12°C |
| Slowdown / shutdown | 85°C / 92°C |
| Pump capacity | A 24 kW; B 40 kW; loop rows mirror pumps and must not be summed twice |
| Checkpoint / restart | 30 / 120 simulated seconds |
| Plan horizon / safety look-ahead | 600 / 120 simulated seconds |
| Required destination thermal margin | 5°C over the predictive safety window |
| GPU evidence maximum age | 10,000 sim-ms for operations requiring those readings |

Eight full-load GPUs account for 5.6 kW of **modeled GPU draw**, not server/rack input. The 35°C inlet is deliberately illustrative; sources do not certify this as a DGX environmental design. Throughput sums modeled GPU work rates; communication and slowest-rank bottlenecks are omitted. `checkpoint_interval_ms` is descriptive today: automatic periodic checkpoints are not implemented. Changing these assumptions requires regenerating fixtures and benchmark results, not silently relabeling old results.

## 3. Supported faults and controls

### Required infrastructure controls

| Control | Existing wire representation | Form fields / default | Visible consequence |
|---|---|---|---|
| Degrade pump | `cooling_pump_degradation` on pump-a or pump-b | Target; capacity-loss preset 0.3/0.6/0.8 (default A/0.6); delay 0/10/30 sim-s; persistent duration `null` | Pump/capacity changes, correlated warming, possible throttle/shutdown; evaluate affected jobs |
| GPU inaccessible (Xid 79) | `gpu_xid_79` on a simulated GPU | GPU selector; delay 0/10/30 sim-s; severity 1, duration `null` | Timestamped Xid signal, GPU unreachable, rollback of its allocated non-elastic job |

Implement these form choices over the existing admin `injectFault`. Delay zero means the next tick: build `start_sim_time_ms` from the freshly read current sim clock plus one step, or the selected positive offset. Show accepted/pending in the presenter controls only. Agent tools must not receive pending fault schedules or private truth. Record effective capacity when pump losses combine: current factors multiply, so two 60% losses leave 16% capacity, not minus 120%.

**Agent crash is a separate process test.** A trusted local script kills/restarts its own orchestrator child after observing the required ledger state. It is not a new GPU fault kind and the public browser does not receive remote shell/process privileges.

### Existing secondary scenarios

Retain these in regression/benchmark fixtures. Only add an advanced judge control after its live behavior is verified; none expands the fixed topology.

| Fault / condition | Encoding and exact current effect | Exposure |
|---|---|---|
| Pump outage | `cooling_pump_outage`, pump capacity zero; finite duration can restore modeled capacity | Optional preset |
| Local heat spike | `gpu_thermal_load`, GPU temperature offset (default severity × 20°C); finite duration | Regression / optional preset |
| Xid 48 | `gpu_xid_48`, degraded GPU and job interruption in this profile | Optional; no universal real-device reset advice |
| Xid 74 | `gpu_xid_74`, degraded GPU; no NVLink traffic simulation | Test-only, no fabric-recovery claim |
| Node crash | `node_crash` on node; allocated jobs fail; finite expiry clears the node-crash latch as modeled reboot | Regression / optional preset |
| Checkpoint store unavailable | `network_link_down` on `ckpt-store-1` (existing alias; `node_crash` also supported) | Regression; label as storage accessibility, not switch emulation |
| Stale GPU readings | `sensor_stale` on simulated GPU; values/last-seen freeze while physics can evolve | Regression; no non-GPU sensor control until implemented |
| No safe spare / hot destination / non-preemptible job | Initial fixture constraints, not fake error events | Regression and safety explanation |

Xids are driver signals with context-dependent causes; the simulator's latch/failure rules are explicit assumptions. Expiring an Xid injection does not repair hardware. Ordinary `network_link_down` on a link currently emits an alarm only. Power outages from v0 are not GPU-layer capabilities. Unsupported combinations/targets must be rejected, never silently treated as implemented.

## 4. Decision and execution behavior

1. Read only observed, attributed telemetry and dependency relationships. Group correlated symptoms; preserve separate incidents when evidence supports independent causes.
2. Enumerate concrete keep/cap/checkpoint/move/pause/escalate choices. Evaluate alternatives on cloned **estimated** state. Score job-b after accounting for the candidate job-a action, not as if the other job never changes.
3. Nemotron assesses evidence, chooses/explains options, and revisits the plan after new evidence. Code handles candidate generation, numerical simulation, safety and durable execution. Show the actor on every event.
4. Coordinator obtains workflow ownership and submits through the ledger. No model tool directly changes GPU/job state. Model latency requires a fresh snapshot before execution.
5. Apply hard safety at request and start, and phase-appropriate checks when delayed operations complete. Preserve the same semantics across live DB and offline simulation.
6. Verify observed effect and progress. Persist a handoff distinguishing workload mitigation from unresolved pump/GPU service.

Forecasts assume no hidden future faults, with current observed degradation persisting. A single deterministic trajectory is not a calibrated failure probability. Display `failure_risk_estimate`, if used, as a model risk score.

### Actions and success criteria

| Operation | Effect / verification requirement |
|---|---|
| `keep_running` | Explicit decision; verify job still running/completed and progress over an observed window, with relevant fresh evidence |
| `power_cap` | Read back targeted GPUs' limit, modeled draw/clock effect and continued job progress; 500 W default; do not declare pump repaired |
| `checkpoint` | Writing is not durable; verify a complete accessible checkpoint for its command key and protected progress |
| `migrate_restart` | Entire compatible destination allocated atomically **at start**; restart takes 120 sim-s. Verify exact destination, fresh health, progress, and current/predictive headroom |
| `pause_job` | Check eligibility and observed paused state. Pause does not create a durable checkpoint or necessarily free GPUs |
| `cordon_gpu` | Prevent new placement, preserve failure status; do not claim it evicts an existing job or repairs a GPU |
| `escalate` | Persist reason, affected work, remaining risk and next human action; acknowledged escalation is not recovery success |

`uncordon_gpu` remains internal/test-only; it cannot clear a failure latch. No reset-device, repair-pump, arbitrary shell or physical control tools are added.

### Required safety repairs (not yet claims of existing behavior)

- **Request/start:** any nonempty safety violation list prevents execution, including `EVIDENCE_STALE` and stale versions. A violation-free `needs_approval` follows the explicit demo approval policy; fallback never overrides a violation.
- **Delayed completion:** a source fault due on the checkpoint-completion tick prevents new durability. A destination-only fault does not invalidate a healthy source checkpoint. An unrelated epoch change alone does not abort a running operation.
- **Restart completion:** revalidate the actual destination after due faults, including allocation ownership, health, relevant freshness and predictive thermal/power constraints. For this conservative model, checkpoint storage must be accessible at restart start and finish. Use a phase-aware check that recognizes the job's own allocations/reservations; calling the request validator unchanged would reject the running job as busy.
- **Completion failure:** do not mark the job running or the action succeeded. Fail the restart, release its allocation coherently, keep progress at durable work, retain failed hardware state and record the reason. Do not pretend the original placement was rolled back. The workflow replans or escalates.
- **Verification:** if time did not advance, data is stale, or a relevant postcondition is missing, report unverified/operator review. Ledger success is not sufficient evidence of workload recovery.

## 5. Durable recovery and operator display

Workflow records save coordination progress; training checkpoints save model work; the action ledger saves operation outcomes; fencing tokens reject stale ownership. Workflow leases may expire after an agent crash while running actions retain DB-supervised resource reservations. Retrying the same logical command uses the same key and payload. Changed semantics require a new command key; do not mutate an already-accepted command to avoid a collision.

Use the existing dashboard. Required displays:

- Fixed 8×8 cluster, cooling grouping, selected resource evidence and evidence age; distinguish thermal slowdown from power cap.
- Current versus durable job work, checkpoint writing/completion, source and destination, remaining restart time.
- Separate incidents and **per-workflow** stages: triage, diagnosis, compare, safety, execute, verify; explicit waiting, replanning, resumed and escalated states. No invented model-completion percentages.
- Candidate comparison with predicted work loss/delay, assumptions, snapshot epoch, chosen/rejected options. Candidates stay visible without being executed just to populate a chart.
- `onActionDetails` for operation, targets, dependencies, actual safety evidence and history. Estimated action progress comes from sim start/due times; only ledger plus verification establishes success.
- Connection/freshness and source labels: simulated data, mock/scripted preview, live DB, Nemotron, code/fallback. A persistent brand badge cannot imply every event came from a model.
- Durable handoff: evidence/hypothesis, affected jobs, accepted/blocked/completed actions, checkpoint/placement outcome, verification interval, unresolved pump/GPU state and next human action. Use existing workflow state, action verification and bounded event summaries; no new incident-management service.

Public deployment is read-only. Presenter controls use the existing local-only admin mode. Before a live reset, stop the agent and drain/terminate its client session; reset reuses fixed run/resource IDs and clears ownership counters. Then reconnect and start a new process. Concurrent reset/takeover across generations is outside this submission's proof.

## 6. Live demonstration and proof

Run integration tests on a designated disposable dev/local target. Test scripts must name their target and reset behavior; never default a destructive test to prod. Capture commit, model, seed, speed, timestamps, command keys and assertions. For the presentation, use the previously rehearsed target.

1. Start seed 42 at sim 600000. Show job checkpoint ages and the fixed model label.
2. Inject pump-a 60% loss. Show common-cause evidence and the agent's actual keep/cap/move comparison. Use speed 2 for the initial rehearsal; measure wall time before promising a three-minute live sequence.
3. Submit a **separate manual safety probe** for hot r6 with fresh epoch/version and no overlapping running action. Show the actual thermal/busy denial. Do not force the planner to choose an unsafe move.
4. Observe job-a's checkpoint `running` and a selected future move destination. Inject Xid 79 into one of those actual destination GPUs while the source write is in progress. If the plan has no future destination yet, the harness must wait for an observable proposal or fail the test; it must not guess r7/r8.
5. Kill the actual orchestrator child. The DB continues the source checkpoint. Restart a fresh process, reclaim the workflow, reconcile existing keys, exclude the failed destination and complete a safe recovery or explicit escalation if capacity is insufficient.
6. Show the two incidents, no duplicate checkpoint/allocation, observed progress and handoff: workload recovered, infrastructure service still required.
7. Show measured benchmark artifacts and their limitations. If a full live sequence exceeds the pitch slot, use a labeled recording of the actual rehearsal with reproducible logs; do not accelerate physics beyond supported speed or fabricate events.

The fixed offline `sc17` hits `gpu-r1-n1-0` at +90s and may hit during restart; it does not prove step 4. The state-triggered live test is separate from fixed-schedule policy benchmarks. Preserve fake-backed five-boundary crash tests as regression coverage, but only actual process termination/restart proves the live claim.

## 7. Evaluation specification

Keep all 20 existing fixtures. The minimum published matrix uses these **12 preselected** cases: `sc01`, `sc03`, `sc04`, `sc05`, `sc07`, `sc08`, `sc09`, `sc10`, `sc11`, `sc13`, `sc14`, `sc17` (full IDs from `loadScenarios()`). This covers no-action warnings, cooling, hard GPU loss, mid-write loss, no spare, non-preemptible, hot destination, inaccessible storage, stale observations, near-complete work, unnecessary intervention and a scheduled destination fault. Do not select cases after viewing outcomes. Run all 20 when the model budget permits.

- Bind the existing P1 runner and P3 policy through one checked-in P4 adapter. Each policy gets an independent world with the same starting state, scenario/seed, horizon and safety rules. Observations diverge naturally after different actions; only their interface/information restrictions are identical.
- Use one comparison `run_id` across policies for each case; explicitly override P1's policy-specific default. Construct a fresh Nemotron policy per case and capture counters before disposal; `reset()` alone does not reset all usage statistics.
- Preserve observable-only policy inputs; scenario truth stays inside the runner. Cache uses are disclosed, and a replayed model response is not an independent fresh trial.
- Ship optional `EvaluationResult.provenance` as specified in CONTRACTS §0.14 before publishing certified results. Old rows remain readable as **provenance unavailable**. A `policy: nemotron` identifier alone does not establish a model ran.
- Show model-assisted, cached, mixed-fallback and deterministic-only cases accurately. A no-model rehearsal remains useful but cannot substantiate a Nemotron performance claim. No-action cases may legitimately make zero model requests.
- Report lost work units, finite-horizon work-deficit delay, GPU-busy waste, unnecessary interventions, unsafe proposals blocked/executed, recovery successes/failures and unfinished jobs. Use `runScenarioDetailed().details` for unfinished/failed jobs and command traces. Unknown is not zero.
- Offline policy calls pause simulated time: label **zero simulated decision latency**. Record wall decision time separately; measure live NIM/recovery latency during rehearsal. Offline `agent_crash_resumes = 0` is not crash evidence.
- Save raw per-case rows, command traces and a batch manifest with code/model/profile versions. Surface losses/ties. Claim no real-world savings, calibrated probabilities, production certification or superiority to NVIDIA's production tools.

## 8. Scope cuts and completion

Cut in this order: optional hardware/ingestion; advanced fault buttons; presentation polish beyond readability; 20-case extension down to the fixed 12-case matrix. Preserve already-implemented power cap as a candidate, with its verification task. Do not spend time rebuilding the simulator, dashboard, ledger or policy scaffolds.

Never cut: hard safety, hidden-truth boundary, real overlap/crash evidence, operator handoff, honest provenance and results. If a claim lacks proof at submission, mark it incomplete; do not convert a passing unit test into a live acceptance claim.
