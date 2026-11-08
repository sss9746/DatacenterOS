# DataCenterOS: GPU cluster reliability plan (v2, Sat Nov 7, 2026)

**Precedence:** this file overrides the niche sections of `PLAN.md`. [`NICHE-DECISION.md`](NICHE-DECISION.md) explains why we chose this niche.

**v2 includes six review fixes:**
- A. the fault model is corrected
- B. a real job-migration model
- C. real durability
- D. many-to-many incidents
- E. a defensible baseline
- F. reduced demo scope

> **One line:** When a GPU data center starts failing, our Nemotron agents decide, job by job, whether to keep running, cap power, or checkpoint and move. They track each separate failure, survive their own crash mid-recovery, and waste fewer GPU-minutes than a reactive rule-based baseline.

---

## 1. Where we are
| Piece | Status |
|---|---|
| Physics engine (`@dcos/physics`): power, cooling, temps, UPS, failures, `simulate_plan` on a clone, safety engine, monitors | ✅ Built, 95 tests, on `main` |
| Fixtures + presets | ✅ Built |
| Contracts (`CONTRACTS.md`) | ⚠️ Still the broad version; **needs a GPU update (next step)** |
| GPU, job and incident model | ❌ Not started |
| SpacetimeDB module (B), agents (C), dashboard (D) | ❌ Waiting on the contract update |
| Fan hardware (team) | 🔄 In progress, optional for the demo |
| Research | ✅ `RESEARCH.md`; GPU deep research skipped (numbers below are labeled *simulated*) |

## 2. Fault model (fix A: each fault is kept distinct)
| Fault | Simulated signal (DCGM-style names) | Impact | Tier |
|---|---|---|---|
| **Cooling pump degradation / failure** | pump kW drops, rack temps rise (existing physics) | Less thermal headroom | 1 |
| **GPU thermal throttling** | `DCGM_FI_DEV_GPU_TEMP` rises; `DCGM_FI_DEV_CLOCK_THROTTLE_REASONS` shows thermal; `DCGM_FI_DEV_SM_CLOCK` drops | Lower compute throughput, so the job slows | 1 |
| **XID 48: double-bit ECC** | `DCGM_FI_DEV_XID_ERRORS = 48`, `DCGM_FI_DEV_ECC_DBE_VOL_TOTAL` +1 | GPU memory error; drain or reset that GPU | 1 |
| **XID 79: GPU off the bus** | `DCGM_FI_DEV_XID_ERRORS = 79`; GPU stops reporting | GPU unreachable over PCIe; any job on it crashes | 1 |
| **XID 74: NVLink fault** | `DCGM_FI_DEV_XID_ERRORS = 74`, NVLink error counter rises | GPU-to-GPU link inside the node fails; jobs on that node degrade | 2 |
| **Network link failure** (Ethernet/InfiniBand) | `network_link.up = false` | Multi-node jobs across that rack stall | 2 |

The DCGM field spellings should be checked against NVIDIA's docs before slides go out. Existing failures still work: load spike, ticket lie, and the fan reading.

**Default simulated numbers** (shown in the UI as *simulated*):
- normal GPU temperature ~70 °C
- throttling at 85 °C, cutting clocks by 30%
- shutdown at 92 °C
- GPU temperature follows rack inlet temperature plus load

## 3. Job model (fix B: not every job can move)
Each job has:
- `gpus_required`, `nodes[]`
- `progress`
- `last_checkpoint_at` (checkpoint age)
- `checkpoint_duration_s`, `restart_duration_s`
- `preemptible`
- `compatible_nodes[]`
- `priority`

**The agent compares the options for each job:**

| Option | Cost | Good when |
|---|---|---|
| **Keep running** | Risk × work since the last checkpoint | The fix lands before the thermal limit |
| **Cap power** (lower clocks) | Slower progress | Small loss of headroom; the job is near a checkpoint |
| **Checkpoint, then move** | Checkpoint time + restart time | The checkpoint is old, and a compatible node has headroom |
| **Checkpoint, then pause** | Pause time | No safe destination exists |
| **Take the GPU out of service** (cordon/drain) | That GPU's capacity | XID 48 or 79 on that GPU |

**The baseline rule:** a job that isn't preemptible, or that has no compatible destination, can't be moved.

**`simulate_plan` scores every option on the clone** by GPU-minutes wasted, and the agent picks the lowest.

## 4. Incidents (fix D: many-to-many, no forced single cause)
- Tables: `incident`, `symptom`, `incident_symptom`, `incident_resource`, `action`.
- **The agent correlates symptoms only when the evidence supports it.**
  - For example, 24 throttling GPUs on racks 2–4 with pump A at 0 kW is **one incident**.
  - An XID 79 that arrives during that incident is **a second, separate incident**, even if it affects the same recovery plan.
- When two incidents touch the same job or node, the plan must account for both. That's what triggers a replan.

## 5. Durability (fix C: real crash recovery)
- **Every action goes through a ledger** (`action` table): `request_key` (unique) → `requested → started → completed | failed`. Reducers are atomic, so a state change and its ledger entry are committed together.
- **Simulator actions are reducers**, so a checkpoint happens exactly once per `request_key`.
- **A lock on each resource** (`resource_lock`: job/node → incident) stops two incidents from moving the same job at once.
- **The agent process** (Python, outside SpacetimeDB) persists its own workflow state in SpacetimeDB after every step.
- **On restart**, it reads its open workflows and checks each action's status against the ledger:
  - already completed: move on
  - started but not finished: wait for it, or reconcile
  - never started: retry with the same key

  It never repeats an action.
- **Honest limit, said in the pitch:** for real hardware we'd need a durable command ledger plus idempotent device adapters. Database transactions alone can't guarantee an external action happens exactly once.

## 6. Baseline (fix E: defensible)
- **The name is "reactive rule-based baseline"**, *not* "NVSentinel". The real NVSentinel does more, including proactive health checks and preflight diagnostics.
- **Rules:**
  - XID 48/79 on a GPU: take the node out of service, kill its jobs, restart them from the last checkpoint on free nodes
  - throttling: no action
  - pump failure: no job action (facility alarms only)
- **Both systems get identical scenarios**, the same random seeds and the same injected faults.
- **Metrics:**
  - wasted GPU-minutes
  - job completion delay
  - time to recover
  - unsafe interventions (blocked or executed)
  - **unnecessary preventive moves** (a move where keeping the job running would have been fine), so moving every job at the first warning can't win the score

## 7. Demo (fix F: reduced scope, about 3 minutes)
1. **Hook:** "Meta saw 419 interruptions in 54 days training Llama 3, most of them GPU-related. Each one wastes hours of GPU time."
2. **A cluster running:** 8 racks × 8 GPUs, 3 training jobs.
3. **Pump A degrades.** GPUs on racks 2–4 head toward throttling.
4. **The agents decide per job:**
   - job A has an old checkpoint and is preemptible: **checkpoint and move**
   - job B checkpointed 1 minute ago: **cap power and keep running**
   - the safety engine **blocks** a move onto rack 6 (no cooling headroom)
5. **XID 79** on a destination GPU mid-move. The agent opens **a second, separate incident**, sees it affects job A's plan, and **replans**.
6. **Kill the agent mid-checkpoint.** It restarts, reads the ledger, recognizes the checkpoint as complete and doesn't repeat it.
7. **Score:** wasted GPU-minutes, ours vs. the reactive baseline, across 20 scenarios, including the unnecessary-moves count.

**Optional, only if it's working by 11 PM:** the judge shakes the real fan, and that acts as the cooling degradation in step 3.

**Off the demo path:** Ceph storage rule, the CMDB rule, network link failure, XID 74, and the real-GPU Brev node.

## 8. Tiers
**Tier 1 (tag by 1 AM):**
- GPU, job and checkpoint model
- throttling from rack temperature
- XID 48 and XID 79
- per-job decision options
- many-to-many incidents
- the action ledger + resource locks
- resume after a crash
- replan on a new incident
- safety blocks
- the reactive baseline
- a 20-scenario eval
- dashboard: GPU heat map, jobs timeline, incidents, agent steps, scoreboard

**Tier 1.5 (team, in parallel):** fan hardware driving rack 3 cooling. Use replay mode if the hardware is flaky.

**NVIDIA-track features (added Nov 7, approved by Suvan):**
- **F-NV1: Nemotron reasoning on screen** (Tier 1, lanes C + D, ~1 h). For every agent step, show its tool call and a one-line reasoning summary live in the dashboard feed. Example: *"24 GPUs on racks 2–4 + pump A at 0 kW → one incident. XID 79 on rack 7 → unrelated, separate incident."* The point is to make it obvious that the diagnosis, the incident grouping and the replanning are Nemotron's work, while the code only does the math (`simulate_plan` scoring). C logs `reasoning` + `tool` + `args` in `log_agent_step`; D renders them.
- **F-NV2: one real GPU node** (Tier 1.5, lane S or team, ~45 min). A script on the Brev instance polls `nvidia-smi --query-gpu=temperature.gpu,power.draw,utilization.gpu,clocks.sm --format=csv,noheader,nounits` every second and reports to SpacetimeDB as node `real_gpu_0`. The dashboard labels it "REAL NVIDIA GPU (Brev)". A load test heats it live. Real telemetry only: faults stay simulated, and we say so.
- **Rejected:** having Nemotron Omni classify the fan's audio (not doable for us).

**Tier 2 (ranked):**
1. XID 74 NVLink
2. network link failure
3. 50-scenario eval
4. real Brev GPU telemetry node
5. Results page
6. storage pool safety rule

**Cut if behind, in order:**
1. Tier 2 items
2. power-cap option (keep move/pause/keep)
3. the 20-scenario eval drops to 10

**Never cut:** resume after a crash, the replan, the safety block, the baseline number.

## 9. Lanes
| Lane | Work |
|---|---|
| **S (Suvan)** | Contract update; physics: GPUs, jobs, checkpoints, throttling, XID faults, the per-job cost model in `simulate_plan`, the baseline policy, the scenario generator, the eval |
| **B (SpacetimeDB)** | Tables: `gpu`, `job`, `incident`, `symptom`, `incident_symptom`, `incident_resource`, `action` ledger, `resource_lock`, `agent_workflow`. Reducers: `checkpoint_job`, `migrate_job`, `cap_power`, `pause_job`, `cordon_gpu`, `acquire_lock`/`release_lock` |
| **C (Agents)** | Tools for the above; correlation (evidence-gated); the per-job decision step using `simulate_plan`; replan on a new incident; workflow persistence and resume-after-crash reconciliation |
| **D (Frontend + pitch)** | GPU heat map (8×8); jobs timeline with checkpoint markers; incident list showing linked symptoms; agent step feed; baseline vs. ours scoreboard; pitch deck |
| **Team (A)** | Fan → rack 3 cooling (Tier 1.5), replay recording by 9 PM |

## 10. Next steps
1. **Suvan:** update `CONTRACTS.md` with §2–§6 (names, tables, reducers, tools, JSON shapes), then push.
2. **Everyone:** pull, re-read your lane in this file, and start against the fixtures.
3. **Sync at 9:00 PM:** the GPU model ticking in SpacetimeDB, and the heat map rendering.
4. **Sync at 11:00 PM:** pump degradation → per-job decisions → safety block, end to end.
5. **1:00 AM:** replan + resume after a crash + baseline number → **tag `tier1`**.
