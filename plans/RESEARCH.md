# Research basis for the fixed GPU reliability demo

**Reviewed:** 2026-11-08, America/Chicago. Primary-source review plus source-code audit; not certification of a real facility. The old CMDB/industry research is preserved in [archive/RESEARCH-2026-11-07.md](archive/RESEARCH-2026-11-07.md). Its proposed niche, competitor claims and cut order are historical.

Current decisions: [scope](IMPLEMENTATION-SCOPE.md). Owners/acceptance: [tasks](IMPLEMENTATION-TASKS.md). Code and live-evidence boundaries: [status](IMPLEMENTATION-STATUS.md).

## 1. Primary-source register

Sources were opened directly during the research. Documentation may evolve; installed SDK 2.14.x and checked-in bindings govern actual implementation. No numeric deployment reducer limit was established.

| ID | Source | Verified fact | Project decision / limit |
|---|---|---|---|
| S1 | [Meta, Llama 3 §3.3.4](https://arxiv.org/html/2407.21783v3#S3.SS3.SSS4) | Reports 419 unexpected interruptions over 54 days; 58.7% GPU issues. Also reports >90% effective training time and only three needing significant manual intervention | Motivate work preservation without implying operators lack automation or inferring a simulator failure rate |
| S2 | [DGX H100/H200 introduction](https://docs.nvidia.com/dgx/dgxh100-user-guide/introduction-to-dgxh100.html) | Eight GPUs plus CPUs/interconnects/NICs/storage/PSUs; specified maximum system input 10.2 kW, ambient 5–30°C | Eight-GPU node is a structural reference. Our 35°C inlet and GPU-only power are illustrative, not calibrated DGX engineering |
| S3 | [SuperPOD network fabrics](https://docs.nvidia.com/dgx-superpod/reference-architecture-scalable-infrastructure-h100/latest/network-fabrics.html) | Compute, storage and management fabrics have distinct roles | Omit general network simulation; never equate NVLink errors, storage accessibility and arbitrary switch failures |
| S4 | [NVIDIA Xid catalog 620](https://docs.nvidia.com/deploy/xid-errors/620/analyzing-xid-catalog.html) | Xid79 concerns PCIe inaccessibility; 48 uncorrectable double-bit ECC; 74 an NVLink connection. Causes/remediation depend on context/hardware | Use accurate vocabulary; simulator latch/failure behavior is an assumption, not universal reset advice |
| S5 | [Xid introduction](https://docs.nvidia.com/deploy/xid-errors/620/introduction.html) | Xids are driver-reported error events | Timestamped signals, not continuous gauges or complete root-cause diagnoses |
| S6 | [DCGM current field IDs](https://docs.nvidia.com/datacenter/dcgm/latest/dcgm-api/dcgm-api-field-ids.html), [constants](https://docs.nvidia.com/datacenter/dcgm/latest/dcgm-api/dcgm-api-field-constants.html), [3.1 legacy fields](https://docs.nvidia.com/datacenter/dcgm/3.1/dcgm-api/dcgm-api-field-ids.html) | Temperature, clocks, power and device thresholds are separate fields; clock reasons are masks; field155 has legacy/current power names | Preserve frozen labels with mapping; 0x20 thermal and 0x04 cap. Fixed thresholds/penalties remain simulated |
| S7 | [Run:ai checkpointing](https://docs.nvidia.com/run-ai/self-hosted/v3.0/documentation/workloads-in-nvidia-run-ai/using-training/checkpointing-preemptible-workloads) | Restart on another node requires accessible checkpoint state and application save/restore support | Keep eligibility, shared storage and completed-write semantics; no instant arbitrary migration |
| S8 | [DGX power capping](https://docs.nvidia.com/dgx/dgxh100-user-guide/power-capping.html) | GPU limits are real controls with platform-specific enforcement | Simulated cap is plausible; 500 W/fixed throughput penalty remain model parameters; no real control |
| S9 | [SpacetimeDB reducers](https://spacetimedb.com/docs/functions/reducers/), [languages](https://spacetimedb.com/docs/intro/language-support/) | Reducer transactions commit atomically or roll back; external I/O restricted; TS runs on V8 | Pure physics inside DB, NIM outside, durable tables rather than globals; do not call TS runtime WASM |
| S10 | [SpacetimeDB scheduling](https://spacetimedb.com/docs/tables/schedule-tables/) | Missed interval calls skipped; overdue dispatch order not guaranteed by timestamp | Domain sim clock/due times; explicit fault-before-completion ordering |
| S11 | [AWS idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/) | Stable request identity, atomic recording/effect, and validation of reused identity with changed intent support safe retries | Keep command keys, canonical hashes and collision rejection |
| S12 | [Kleppmann fencing](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html), [AWS leader election](https://aws.amazon.com/builders-library/leader-election-in-distributed-systems/) | Former owners can resume after lease expiry; receiver must enforce fencing | Tokens reject stale writers, not store progress; separate workflow leases from running-action reservations |
| S13 | [NIM 1.15 function calling](https://docs.nvidia.com/nim/large-language-models/1.15.0/function-calling.html) | Structured tool arguments depend on model/configuration support | Preserve verified setup, validate tools, keep writes under coordinator code |
| S14 | [NVSentinel overview](https://docs.nvidia.com/nvsentinel/getting-started/overview/), [remediation](https://docs.nvidia.com/nvsentinel/components/fault-remediation) | Broad monitoring/remediation includes quarantine, draining and device/node recovery | Simple project baselines are not replicas; no superiority claim against NVSentinel |
| S15 | [NVIDIA Recovery](https://docs.nvidia.com/recovery/overview), [jobs/workflows](https://docs.nvidia.com/recovery/jobs-and-workflows) | Automated training recovery distinguishes attempts, checkpoint restoration and progress | Do not claim job-aware recovery is novel; demonstrate inspectable simulated choices and recovery evidence |
| S16 | [Google incident management](https://sre.google/sre-book/managing-incidents/), [incident document](https://sre.google/sre-book/incident-document/) | Clear ownership, maintained incident state and explicit handoff aid response | Persist operator status, unresolved risk and next action; animation alone is insufficient |

## 2. Component decision

Retain eight racks, eight nodes, 64 simulated GPUs, two pumps/two loops, one power-domain boundary, one shared checkpoint store and three jobs. Healthy compatible GPUs, modeled thermal/power headroom and saved state are the dependencies necessary for this demo. Cooling membership explains common symptoms; checkpoint age explains the cost of waiting or moving.

This is a project scope judgment informed by S2/S3/S7 and the implementation. Real clusters contain additional systems; we are not claiming to model them. Power is a placement constraint/cap response, storage is accessibility/durability, and ordinary links remain metadata/test alarms. A component editor multiplies unvalidated configurations and is removed from the submission.

## 3. Fault semantics

Core: pump degradation and Xid79, independently and together. The former produces correlated warming; the latter abrupt GPU loss. The agent observes evidence and topology, not private injection records.

Actual implementation assumptions, distinct from the vendor catalog:

- Pump degradation multiplies capacity by `1 - severity`; multiple losses multiply factors. Pump outage sets capacity to zero; temperature changes over ticks.
- Xid79 latches unreachable state and fails an affected non-elastic job. An unused GPU's failure does not fail unrelated jobs. Injection expiry does not repair hardware.
- Xid48 degrades a GPU and interrupts its job in this profile. Xid74 degrades a GPU without modeling a fabric.
- Store outage uses the existing `network_link_down`/`node_crash` alias on `ckpt-store-1`, with no network propagation claim.
- GPU `sensor_stale` freezes observations. Broader accepted target kinds do not establish broader physics behavior.
- Fixed scenario17 may hit a predetermined GPU during restart. A state-triggered test using the actual planned destination is needed to prove a mid-checkpoint overlap.

Source-backed vocabulary is S4/S5. Exact control parameters, exposure and acceptance are in [scope §3](IMPLEMENTATION-SCOPE.md#3-supported-faults-and-controls).

## 4. Fidelity and uncertainty

The engine uses loop-level heat balance and simplified work accounting. It omits fluid dynamics, GPU kernels, communication/slowest-rank bottlenecks, whole-server electricity and checkpoint bandwidth contention. Pump electrical power is a modeled capacity proxy, not a general real capacity estimator.

The 35°C inlet, 85/92°C thresholds, 700/500 W limits, fixed clock penalties and 30/120-second operations are code assumptions. S2 does not validate them for real deployment. Keep them labeled/versioned; recalibration is outside the submission. The checkpoint interval field is descriptive; periodic automatic checkpoints are not implemented.

`simulatePlan` constructs estimated state from observations, assumes current degradation persists and receives no future faults. Its risk score is a heuristic from one trajectory. Predictions need fresh execution checks and verification; they are not calibrated probabilities or engineering guarantees.

## 5. Durable recovery

Atomic reducers (S9) do not make an entire workflow atomic or make external effects exactly once. Command keys/ledger resolve lost acknowledgements; workflow state saves coordination; training checkpoints save work; fencing rejects outdated ownership.

Wall-time leases and sim time differ (S10/S12). Pausing physics does not stop lease expiration. Running simulated work belongs to the DB and must survive Node process death. Explicit ordering handles faults and completion on the same tick.

Existing evidence proves useful parts: ledger durability, real caller SIGKILL and real NIM pump recovery. Remaining requirements are start-time stale-evidence rejection, phase-aware restart completion, observed verification and real orchestrator restart under overlap. R1–R5 are not already-proved claims.

## 6. Evaluation and competitive claims

Research supports distinguishing protected work, restart and verified recovery; it does not establish that an LLM beats strong rules. Keep threshold-baseline wins and ties. S1/S14/S15 demonstrate existing recovery automation.

Use identical initial scenario/seed/horizon and safety rules. Actual observations diverge after different actions. Preserve per-case live/cache/fallback counts, versions and traces. A no-model rehearsal with wire enum `nemotron` needs a deterministic label; cache reuse is not an independent model trial.

Offline simulation pauses while the policy thinks. Disclose zero simulated decision latency and record wall time separately. Use detailed-runner unfinished jobs. Actual process crash/resume is a separate live experiment, never inferred from an offline counter.

The small simulator-specific matrix supports only results on these seeded cases under stated assumptions. No real-facility savings, calibrated failure probabilities or industry-wide superiority follows.

## 7. Operator value and unresolved evidence

Project-specific UI informed by S16: affected work, evidence/age, hypothesis/uncertainty, selected/blocked options, action outcomes, workflow ownership/stage, remaining infrastructure condition and next human action. The handoff persists after restart; a saved job can coexist with a pump requiring service.

Close through implementation:

1. Actual live browser behavior and action-detail projection.
2. Actual orchestrator restart with a destination fault during source checkpoint.
3. Delayed safety and operation-specific verification regressions.
4. Matched benchmark with model/provenance disclosure.
5. Presentation wall duration and model latency at chosen speed/load.
6. Deployment reducer budget and organizer requirements still marked unconfirmed in reports.

No reviewed source establishes physical accuracy of the toy cooling model. Explicit labels and limited claims address that gap; no calibration result is invented.
