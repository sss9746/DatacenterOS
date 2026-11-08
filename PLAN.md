# DataCenterOS: master plan (v3, Sat Nov 7, 2026, HackUTD "Zero Day")

> **Start here, then read [`plans/README.md`](plans/README.md).** The design is [`plans/ARCHITECTURE.md`](plans/ARCHITECTURE.md) (Kaushik's kit), and every shared name is in [`plans/CONTRACTS.md`](plans/CONTRACTS.md) (**read §0 first**). Older plans live only in git history (before commit `85e2653`).

## One line
**When a GPU data center starts failing, our Nemotron agents decide, job by job, whether to keep running, cap power, or checkpoint and move.** They keep separate failures separate, survive their own crash mid-recovery, and waste less training work than rule-based baselines.

## Problem and people
- Large training runs span many GPUs. If **one** GPU in a job dies, the whole job falls back to its last checkpoint.
- Meta reported **419 unexpected interruptions in 54 days** training Llama 3 405B on 16,384 H100s, 58.7% of them GPU-related ([arXiv 2407.21783](https://arxiv.org/pdf/2407.21783)).
- Existing tools (such as NVIDIA's NVSentinel) focus on GPU health and node remediation.
- **Who we're building for:** the night-shift operator at a GPU facility like NMC²'s 400 MW Spartanburg site.

## Tracks
| Track | Why we qualify |
|---|---|
| **NMC²** | GPU infrastructure reliability, one of the three areas NMC² told us to choose from |
| **NVIDIA** | Nemotron (NIM on Brev) does diagnosis, planning and replanning through tool calls; the telemetry uses DCGM/XID names; **F-NV1** shows its tool calls live; **F-NV2** streams one real Brev GPU |
| **SpacetimeDB** | It's the authoritative live twin plus a durable action ledger, leases and workflow state, which is why the agent survives its own crash |

## Demo (3 minutes, ARCHITECTURE §11)
1. An 8-rack, 64-GPU cluster with 3 training jobs (`gpu_demo_8`).
2. **Pump A degrades.** Racks r2–r4 heat up, and the agent identifies one cooling incident instead of 24 GPU alerts.
3. **Choices per job**, scored by `simulatePlan` and shown on screen:
   - `job-a` (old checkpoint) checkpoints and moves.
   - `job-b` (fresh checkpoint) keeps running or caps power.
   - A move onto hot `rack-r6` is **blocked** with `DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT`.
4. **XID 79** hits the destination GPU mid-checkpoint. A second incident opens, the plan is invalidated, and the agent **replans**.
5. **Kill the agent process.** SpacetimeDB finishes the checkpoint. On restart, the agent reconciles by `command_key` and doesn't duplicate anything.
6. **Scoreboard:** Nemotron vs. the reactive and threshold baselines on the same seeded scenarios, including needless moves and the cases where we lost.

Optional (Gate 5): a judge pinches the real fan (Pico) to trigger step 2, and the real Brev GPU tile heats up live.

## Gates (pass/fail, details in plans/README.md)
| Gate | What passes | Due |
|---|---|---|
| **0** | Contracts package green; DB module publishes and imports physics; NIM returns a valid tool call; web renders mock rows | **9:00 PM** |
| **1** | World with no AI: pump degrades, GPUs heat, jobs progress, XID 79 kills a job back to its durable checkpoint; live in the browser | **11:30 PM** |
| **2** | Durable manual actions: checkpoint goes requested → running → succeeded over ticks; 10× retry gives one checkpoint; unsafe moves rejected with reason codes | **1:30 AM** |
| **3** | Agent + stacked fault + crash: two incidents, replan, kill and resume with no duplicates; F-NV1 feed live | **4:30 AM** → tag `tier1` |
| **4** | ≥10 seeded scenarios × 3 policies, real results on the scoreboard; pitch done | **8:30 AM** |
| **5** (optional) | Pico fan via gateway; F-NV2 real GPU; XID 48 / XID 74 / network link | After Gate 3, stop at 9:00 AM |

Then: **9:30 AM** backup video recorded · **10:00 AM** feature freeze · **11:30 AM** submitted (deadline 12:00) · **1–4 PM** judging. Devpost is registered by **10:45 PM** Saturday (P4).

## Team
**Integrator:** Suvan's Claude orchestrator session. It owns `plans/`, the contracts and root config, merges to `main` at every sync and runs the gate checks. It writes no lane code.

| Lane | Person | Plan |
|---|---|---|
| P1: simulation, safety, baselines | ___ | [`plans/LANE-P1-sim.md`](plans/LANE-P1-sim.md) |
| P2: SpacetimeDB + durability | ___ | [`plans/LANE-P2-db.md`](plans/LANE-P2-db.md) |
| P3: Nemotron + orchestration | **Suvan** | [`plans/LANE-P3-agent.md`](plans/LANE-P3-agent.md) |
| P4: frontend + evaluation + pitch | ___ | [`plans/LANE-P4-web.md`](plans/LANE-P4-web.md) |
| HW: Pico fan + real GPU (shared, optional) | everyone | [`plans/LANE-HW-shared.md`](plans/LANE-HW-shared.md) |

## Cut order if behind (from IMPLEMENTATION_TASKS)
1. XID 74, network links, CMDB and Ceph (already Tier 2)
2. Hardware demo
3. Power-cap (keep `keep_running`, checkpoint/pause, move/restart)
4. Evaluation from 20 cases to 10

**Never cut:** one stacked-fault overlap, crash recovery, one blocked unsafe action, and real baseline numbers.

## Honesty rules
- Every number shown is either from a real run or labeled **simulated**.
- Never call the baseline "NVSentinel". It's a "reactive rule-based baseline".
- Never show raw chain-of-thought; show tool calls and summaries.
- The private fault truth never reaches the agent.
