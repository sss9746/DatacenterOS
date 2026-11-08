# DataCenterOS: every feature (as of 07:40 Sun, Nov 8)

**One-liner:** a crash-resilient team of Nemotron agents for GPU clusters. When cooling or GPUs fail, specialist agents question each other and a lead picks, per training job, whether to keep, cap or move it. Safety checks are deterministic, separate failures stay separate, a failed agent's work is picked up by a teammate, and SpacetimeDB preserves recovery if the agent process dies.

**Status legend:**
- ✅ **LIVE:** proven on a real database with real Nemotron
- 🧪 **TESTED:** built, with unit/integration tests passing; not yet proven live
- 🚧 **BUILDING:** in progress on a branch
- 🎭 **MOCK:** works only on mock/example data, labeled as such

Integration branch: `int/r-sprint`. Agent-team work: `Prod-Multi-Agent-System`, not yet merged to `int/r-sprint`. Safe fallback: `stable/working-single-agent` @ `a153f6d`.

---

## 1. Simulated GPU cluster (digital twin): `packages/physics`
| Feature | Status |
|---|---|
| Fixed `gpu_demo_8` cluster: 8 racks × 8 GPUs = 64 GPUs, 8 nodes, one checkpoint store, `power-main` | ✅ |
| Two cooling loops: pump A → racks r2–r4, pump B → r1, r5–r8; heat-balance model per loop | ✅ |
| GPU model: temperature from inlet + load, throttle at 85 °C (−30% clock, DCGM `0x20` bit), shutdown at 92 °C | ✅ |
| Power cap at 500 W (−15% clock, DCGM `0x04` bit) | ✅ |
| Three training jobs: job-a (16 GPUs, r2+r3, old checkpoint), job-b (r4, fresh checkpoint), job-c (r6, non-preemptible, hot rack) | ✅ |
| Synchronous-job semantics: losing one GPU fails the job and rolls back to its last durable checkpoint | ✅ |
| Actions take real (simulated) time: checkpoint 30 s, durable only when complete; move-and-restart 120 s, all-or-nothing allocation | ✅ |
| **Phase-aware completion safety (R1):** a checkpoint or restart re-checks health, freshness, thermal/power headroom and storage on its completion tick; a clean failure releases GPUs and keeps durable work | ✅ |
| Faults: pump degradation/outage, XID 79 (fell off bus), XID 48, XID 74, node crash, local heat spike, checkpoint store unavailable, stale GPU telemetry | ✅ (pump + XID 79 live; the rest in tests/scenarios) |
| Deterministic and seeded: the same seed always gives the same run; no hidden randomness | ✅ |
| Hidden truth stays hidden: agents only see an observed snapshot, never the fault schedule | ✅ |
| Plan simulator (`simulatePlan`): forecasts lost work, delay and GPU waste over 600 s for each option | ✅ |
| Hard safety (`evaluateSafety`): 30+ reason codes (hot destination, busy GPU, stale evidence, no checkpoint, …) | ✅ |
| 20 seeded failure scenarios + two rule-based baselines (reactive, threshold) | ✅ |
| 370 physics tests | ✅ |

## 2. Durable database: SpacetimeDB (`apps/db`, `packages/db-client`)
| Feature | Status |
|---|---|
| The physics runs inside the database every second, so the world keeps ticking even with no agent | ✅ |
| Roles: admin / agent / gateway, each with its own token | ✅ |
| **Action ledger:** requested → claimed → running → succeeded/failed, idempotent by command key | ✅ |
| Safety checked at request time **and again at start** (R2, fail-closed: any violation, including stale evidence, blocks) | ✅ |
| Workflow leases + **fencing tokens**: a stale owner can't change anything after a takeover (L4 proven) | ✅ |
| Resource reservations held by the database while actions run, so they survive agent crashes | ✅ |
| Incidents, symptoms, plans, agent events, evaluation results tables | ✅ |
| Typed client: live + mock, subscriptions (`onWorkflows`, `onPlans`, `onActionDetails`, `onAgentEvents`, …), `controlledReset` | ✅ |
| `ingest_observations`: gateway-only real telemetry intake (dedupe, sequence order) for `gpu-real-0` | ✅ on dev |
| Evaluation provenance round-trip (which model, how many calls, cache, fallbacks) | ✅ |
| Databases: `dcos-dev` (shared dev) and `dcos` (prod, switched over at 08:30) | ✅ dev / ⏳ prod switch |

## 3. Agents: `apps/agent` (Nemotron via NVIDIA NIM)
| Feature | Status |
|---|---|
| Real Nemotron (`nemotron-3.5-lightning-30b-a3b`) through NIM, with tool calls (`submit_incident_assessment`, `choose_options`) | ✅ |
| **Triage:** groups correlated symptoms into one incident (pump A → racks 2–4) and keeps independent failures separate (XID on r7) | ✅ (L2/L3) |
| **Planner:** enumerates keep / power cap / checkpoint / checkpoint+move / pause / escalate per job; sequential planning (job-b scored after job-a's action) | ✅ |
| Code computes, Nemotron chooses: simulation + safety are deterministic; NEMOTRON vs CODE attributed on every event | ✅ |
| **Coordinator:** submits through the ledger, re-stamps the decision epoch, reconciles by command key | ✅ |
| **Replan:** when the situation changes (e.g. the destination GPU fails), supersede and choose a new safe destination | ✅ (L2/L3) |
| **Crash-safe resume:** a fresh process reclaims the workflow, reuses existing command keys, no duplicate checkpoint or allocation | ✅ (L1/L3) |
| **Verification (R3):** read-back per operation (two fresh samples, exact destination, progress advancing, headroom); stale/paused/ledger-only → "unverified" | ✅ |
| **Durable operator handoff:** recovered vs needs a human (pump, failed GPU), next human step; survives restarts | ✅ (L3) |
| Saved candidate options (`state.candidates`: chosen + rejected, with reasons; unsimulated → null, never fabricated) | 🧪 |
| Resume marker (`state.resumed`, `resume_count`) | 🧪 |
| Model outage fallback: bounded timeouts, deterministic code fallback, attributed to CODE, safety still holds | ✅ (L6) |
| **Agent team** (`DCOS_AGENT_TEAM_MODE=multi`, default `single`): Cooling, Workload and Recovery Lead with separate contexts and partitioned evidence | ✅ on local DB (L1, L3 in team mode, one run each) |
| **Agents talk:** each specialist asks the other a question; answers reach the asker or the Lead as real model input. A round where a specialist times out has no conversation | ✅ on local DB, in L1, L3 and SBK; not in SB |
| **Agents cover each other:** if a specialist fails, the other answers for it; if the Lead fails, deterministic code chooses, labeled CODE | ✅ specialist cover seen live on local DB; Lead fallback seen once before the breaker fix |
| **New-fault watch** during recovery: an unrelated incident triggers a replan at the next safe boundary (multi mode only) | 🧪 |
| **Supervisor** (`supervised` script): relaunches a crashed agent, which reclaims the workflow after its lease expires | 🧪 (stand-in child only; not yet run with the real agent) |
| **Waiting recovery:** failed checkpoint-backed jobs wait for capacity, then restart; jobs with no checkpoint go to an operator | ✅ on local DB (SB, SBK) |
| Per-incident workflows, zones, inter-process agent messages and automatic hot-standby takeover (`r/multi-agent`) | Dropped, not merged |
| Agent tests: 540 (`Prod-Multi-Agent-System`) | 🧪 |

## 4. Live recovery proof: R5 harness (`apps/agent/scripts/live-recovery-test.ts`)
| Case | What it proves | Status |
|---|---|---|
| L1 | Agent SIGKILLed mid-checkpoint → DB finishes the checkpoint → fresh agent resumes → move verified, no duplicates | ✅ 8/8 |
| L2 | XID on the planned destination during the checkpoint → separate incident, new safe destination | ✅ 9/9 |
| L3 | L1 + L2 combined (centerpiece) | ✅ 13/13 |
| L4 | Stale fencing token rejected after takeover | ✅ 8/8 |
| L5 | Source GPU fails on the checkpoint due tick → no false durability | 🧪 (harness fixed; re-run pending) |
| L6 | Nemotron unreachable → safety holds, all events CODE | ✅ 5/5 |
| L1, L3 in team mode | Same checks, plus Lead decided, peer answer consumed, 6 model calls per round at most | ✅ 12/12 and 18/18 on local DB |
| SB, SBK | Scene B: all nodes crash, jobs wait, nodes return, checkpoint-backed jobs restart; SBK adds a SIGKILL during the wait | ✅ SBK 25/25; SB 20/21 (recovery passed, no peer answer after a Workload timeout) on local DB |
| L7, L8 | Multi-process cases from `r/multi-agent` | Dropped, not merged |
| Refuses to reset prod; `--hold-s` keeps the final state up for recording; JSON + markdown reports | ✅ |

## 5. Evaluation: `apps/evaluation`
| Feature | Status |
|---|---|
| Checked-in adapter: same scenarios, seeds, horizon and rules for every policy; one comparison run ID per case | ✅ |
| Per-case provenance: model ID, model requests, live responses, cache hits, fallbacks, wall time, unfinished/failed jobs, trace hash | ✅ |
| **Real Nemotron fixed-12 batch** (`results/nemotron-fixed12/`): 76 live NIM responses + 51 cached + 3 fallbacks | ✅ |
| **Results:** lost work **18,800** vs threshold **35,468** (−47%) vs reactive **127,558**; delay −42% vs threshold; **0 unsafe actions**; vs threshold: **4 wins / 7 ties / 1 loss** (sc14); 2 unnecessary preemptions, 1 failed recovery (disclosed) | ✅ |
| Deterministic-only batch kept separately and labeled as such | ✅ |

## 6. Real NVIDIA hardware: Brev L40S (`hardware/`)
| Feature | Status |
|---|---|
| L40S on Brev (Nebius, $1.90/hr) streaming real `nvidia-smi` telemetry (temperature, power, utilization, SM clock, throttle reasons) | ✅ on dev |
| Collector: handles `[N/A]` (never sent as 0), detects driver field names, reconnects, `--dry-run` / `--record` / `--replay` | ✅ |
| Into SpacetimeDB through `ingest_observations` as `gpu-real-0` (observation only: never allocated, capped or changed) | ✅ on dev |
| Real 119 s recording under load (24–56 °C, up to 326 W) + a replay labeled "REPLAY OF REAL RECORDING" | ✅ |
| Load script (`load.py`, torch matmul, ≤120 s) to heat the GPU live | ✅ |
| Prod: gateway role + collector running during judging (optionally on the box itself) | ⏳ 08:30 |

## 7. Dashboard: `apps/web` (React + Vite, Vercel)
| Feature | Status |
|---|---|
| Live mode (SpacetimeDB subscriptions) + labeled mock mode; a failed live connection never silently shows mock | ✅ |
| 8×8 GPU heat map, cooling loops with a degraded-loop highlight computed from data | ✅ |
| Jobs: current vs durable work, checkpoints, moves | ✅ |
| Incidents, per-workflow stage tracks, candidate options, handoff card | ✅ |
| Agent feed with NEMOTRON (green) vs CODE (grey) badges, filter chips | ✅ |
| Action ledger with lifecycle and BLOCKED reasons in plain English | ✅ |
| Scoreboard with provenance labels, refusing to mix batches, wins/ties/losses | ✅ |
| REAL NVIDIA GPU tile (live / REPLAY / collector offline) | ✅ |
| Presenter controls (local only, never on Vercel): pump fault, XID 79, hot-r6 safety probe, reset | ✅ |
| Polish pass (story order, larger type, accessibility WCAG AA, 390 px) | ✅ |
| **UI v2:** previous look + left sidebar + separate pages (Cluster overview, Training jobs with animated progress, Recovery activity with the **Agent room** and incident explanations, Workflows, Benchmarks, Real GPU) + simple demo buttons | 🚧 `r/ui-v2` (awaiting owner review) |
| Agent room: role seats, chat handoffs, alpha/beta owner chips, takeover dividers, agent-to-agent bubbles | 🚧 (EXAMPLE fixture in mock only; its alpha/beta design came from the dropped `r/multi-agent`, so live roles would be Cooling, Workload and Lead) |
| Public site https://datacenteros.vercel.app | ⏳ still the old mock build; live deploy at 08:30 |
| Web tests 101–137 + Playwright e2e with axe accessibility checks | ✅ |

## 8. Engineering
- **One integration branch** (`int/r-sprint`), a stable fallback branch, and per-feature branches.
- **~980 tests** across 7 packages, type-checked clean.
- No secrets in git; tokens only in `.env.local` files.

## Honest limits (say these if asked)
- The 64-GPU cluster is **simulated** (an illustrative `demo_gpu` profile with H100-class numbers, not calibrated). Only the L40S tile is real hardware, and it's observation-only.
- Evaluation numbers come from 12 simulated scenarios; no real-world savings claims.
- The three team agents share one Node process, so a process crash stops all of them until it restarts and reclaims the work. No separate agent takes over.
- Two recovery actions never run at once, and a running action cannot be interrupted.
- Team mode's effect on recovery scores is unmeasured.
- Agent findings can be factually wrong. The Lead picks only from code-validated options, and hard safety never depends on what an agent claims.
- The scripted EXAMPLE views in mock mode are not live runs.
