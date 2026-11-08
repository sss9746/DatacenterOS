# Niche decision: what we learned (Sat Nov 7, 2026)

> **Historical.** This records *why* we picked GPU reliability. The build details below are outdated; [`../PLAN.md`](../PLAN.md) and the lane files are current.

This file records how we picked DataCenterOS's niche, and why, so the team can check the reasoning.
- **Sources:** [`RESEARCH.md`](RESEARCH.md) has the incident and industry research, with links.
- **GPU numbers:** GPU research was skipped for time; the current plan is [`../PLAN.md`](../PLAN.md) and [`ARCHITECTURE.md`](ARCHITECTURE.md).

> **Decision:** **GPU cluster reliability.**
> *"NVSentinel reacts when a GPU fails. We find the shared cause across cooling, network and GPUs, and save the training jobs before they die."*

---

## 1. What NorthMark (NMC²) told us
- **Their advice:** "do research and pick one of" **storage, GPU or networking**, and specialize instead of building broad "AI ops for data centers".
- **CMDB:** they mentioned CMDB failures as an example.
- **The constraint:** we don't have time to keep debating, so we're picking one and building.

## 2. What we know about NMC² (judge context)
- They're building a **$2.8B, 400 MW NVIDIA GPU facility** in Spartanburg, SC.
- They're hiring:
  - electrical and mechanical ops staff on 24/7 shifts
  - controls staff
  - a **bare-metal Kubernetes team** (Slurm/Volcano)
- **Their HackUTD 2025 brief:** work orders, dispatch and technician automation. The 3rd-place winner, DcDaddy, did technician routing.
- **Takeaway:** their judges understand GPUs, power and cooling. A GPU-focused project matches both their business and NVIDIA's track.

## 3. The options we compared
| Option | What it is | Strengths | Weaknesses | Verdict |
|---|---|---|---|---|
| **Broad DataCenterOS** (original) | Break anything; agents diagnose, test fixes and repair | All the code is built | Too broad; NMC² asked us to specialize | Replaced by a niche |
| **Storage (Ceph)** | Simulate a distributed storage cluster: drives, erasure coding, recovery | Failure rules are well documented and easy to simulate | **Ceph already heals itself** ("doesn't Ceph do this?"); weak NVIDIA fit; loses the fan demo; rebuilds the physics | Rejected, but kept as one Tier 2 safety rule |
| **Networking** | Emulate real network protocols and faults | Can run real protocols | Complex to build; weak visual; weak fit with the physics we have | Not chosen |
| **CMDB pre-flight check** | Check records against live telemetry before a technician acts | Real incidents (Singapore, South Dakota); clear pitch; ~2–3 h extra | **Not one of NMC²'s three areas**; CMDB accuracy stats are mostly unverified vendor claims | Becomes one safety rule |
| **GPUs break → get fixed** (plain) | Detect a GPU fault, move the job | Strong NVIDIA fit | **NVIDIA's NVSentinel and Komodor already do this** | Rejected as-is |
| **GPU cluster reliability with cross-system root cause** | Stacked failures across cooling, network and GPUs; agents find the shared cause, checkpoint and move jobs, replan | One of NMC²'s areas; strongest NVIDIA fit; reuses our physics; durable agents fit SpacetimeDB; measurable against a baseline | GPU realism needs research; ~4–5 h extra; tighter Tier 1 deadline | **Chosen** |

## 4. Key lessons
1. **Specialize, but keep the code.** The physics engine, `simulate_plan` (testing fixes on a clone), the safety engine (95 tests) and the fan pipeline all carry over to the GPU niche.
2. **Don't claim what existing tools already do.** Ceph self-heals, and NVSentinel drains failed GPU nodes. Our claim has to be what they *don't* do: **find one root cause behind many GPU symptoms, act before the GPU fails, and coordinate safely when failures stack.**
3. **Turn the difference into a number.** Not "durable coordination" (too vague), but **GPU-hours lost: ours vs. an NVSentinel-style baseline**, across 20 scenarios with stacked failures, from real runs.
4. **Keep GPU realism small and documented.** Model 5 faults NVIDIA documents (XID codes, DCGM telemetry). Don't try to simulate "realistic GPU behavior" in general.
5. **Use our hardware for the strongest version of the pitch.** The real fan becomes rack 3's GPU node fan: a judge shakes it, and the jobs move *before* any GPU reports a problem.
6. **Sponsor stack:**
   - NMC²: their GPU facility's reliability
   - NVIDIA: GPUs, Nemotron agents, DCGM/XID realism
   - SpacetimeDB: live twin, plus durable agent state that survives a crash

## 5. What we're building (summary)
- **The cluster twin:**
  - 8 racks, each with one 8-GPU node, on the existing power and cooling physics
  - a network switch with a link to each rack
  - training jobs spanning several nodes, each with progress, a last checkpoint and GPU-hours
- **Failures (stackable):** thermal throttling, a memory ECC error (XID 48), a GPU off the bus (XID 79), an NVLink/network link down (XID 74) and a node crash. These add to the existing pump failure, load spike, ticket lie and real fan.
- **The rule that makes it hard:** if one GPU in a job dies, the whole job crashes back to its last checkpoint.
- **The agent loop (Nemotron):**
  1. detect
  2. correlate symptoms to a shared cause
  3. diagnose the root cause
  4. plan (checkpoint and move / wait / fix the cause)
  5. test each plan on the clone
  6. safety check
  7. execute
  8. **replan when a new failure lands**
  9. verify with telemetry
  10. write a verified handoff
- **Safety rules (block):**
  - moving a job to a rack without cooling or power headroom
  - moving it to a GPU with recent errors
  - crashing a job that has no checkpoint
  - moving it to a node whose records don't match reality (from the CMDB idea)
  - Tier 2: a rack shutdown that would drop a storage pool below the shards it needs (from the Ceph idea)
- **Durability:** agent steps are stored in SpacetimeDB. Kill the agent mid-recovery and it resumes without repeating actions (`request_key` deduplication).
- **Baseline:** NVSentinel-style. Take a node out of service on a GPU error and restart from the last checkpoint; it ignores the cause and never acts early.
- **Metrics:**
  - GPU-hours lost (ours vs. the baseline)
  - jobs saved
  - unsafe actions blocked
  - false blocks
  - time to recover

## 6. Demo (3 minutes)
1. **Hook:** "Meta: 419 interruptions in 54 days training Llama 3, 58.7% GPU-related. Existing tools react after the GPU fails."
2. **Build** a GPU cluster with 3 jobs running.
3. **Break pump A.** 24 GPUs throttle, and the agents trace it to one cause. They checkpoint and move the jobs, and one bad move is blocked.
4. **Stack failures:** XID 79 on the destination GPU, plus a network link down. The agents throw out the plan and replan live.
5. **Kill the agent process.** It restarts and resumes cleanly.
6. **Shake the real fan.** The jobs move before the GPUs heat up.
7. **Score:** GPU-hours lost, ours vs. the baseline.

## 7. Lane changes
| Lane | New work |
|---|---|
| S | GPU node, job and checkpoint model; the 5 faults; throttle physics; network links; baseline policy; scenario generator; 20-scenario eval |
| B | `gpu_telemetry`, `job` and `network_link` tables; `checkpoint_job`, `migrate_job` and `cordon_node` reducers; durable agent state |
| C | correlation, job-aware planning, the replan loop, resume after a crash, new GPU and job tools |
| D | GPU heat-map grid, jobs timeline with checkpoint markers, baseline vs. ours scoreboard, the pitch |
| A | the fan becomes rack 3's GPU node fan |

## 8. Risks and open questions
| Risk / question | Plan |
|---|---|
| GPU fault realism | Use `GPU-RESEARCH.md` (NVIDIA XID docs, DCGM fields, H100 temperatures) for every number |
| Overlap with NVSentinel | Pitch it as *building on* NVSentinel: same signals, plus facility-level root cause and early action |
| Scope: ~4–5 h extra, Tier 1 due by 1 AM | Replan and resume-after-crash move into Tier 1; the drag-drop builder and the 2-vs-3-pump comparison stay cut |
| The baseline must be fair | Copy NVSentinel's documented behavior; same simulation and scenarios for both |
| Our racks are 6 kW, and a real 8×H100 node draws ~10 kW | Call it a scaled twin, or raise rack load once the research confirms the numbers |
| Unverified stats | Use only Uptime Institute, the Meta paper and confirmed incidents on slides; the CMDB vendor stats stay off |

## 9. How to evaluate this decision
- [ ] Does the one-line pitch land with someone outside the team?
- [ ] Can we state, in one sentence, what we do that NVSentinel doesn't?
- [ ] Is the baseline comparison fair, and does it come from real runs?
- [ ] Are the 5 faults backed by NVIDIA documentation?
- [ ] Does the demo show one cause → many symptoms → early action → replan → resume?
- [ ] Can Tier 1 ship by 1 AM with this scope? If not, cut in this order: network link → node crash → resume-after-crash demo.
