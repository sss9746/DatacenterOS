# DataCenterOS: every feature (as of 06:00 Sun, Nov 8)

**One-liner:** a crash-proof team of Nemotron agents for GPU clusters. When cooling or GPUs fail, the agents decide per training job whether to keep, cap or move it, keep separate failures separate, coordinate through SpacetimeDB, and cover for each other if one goes down.

**Status legend:**
- ✅ **LIVE:** proven on a real database with real Nemotron
- 🧪 **TESTED:** built, with unit/integration tests passing; not yet proven live
- 🚧 **BUILDING:** in progress on a branch
- 🎭 **MOCK:** works only on mock/example data, labeled as such

Integration branch: `int/r-sprint`. Safe fallback: `stable/working-single-agent` @ `a153f6d`.

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
| **Multiple agent processes** (`AGENT_NAME`, e.g. agent-alpha / agent-beta) coordinating only through SpacetimeDB leases | 🧪 (two agents took two incidents in parallel live; full L7 pending) |
| **One workflow per incident**, so several failures at once are handled in parallel by different agents | 🧪 (seen live; L7 pending) |
| **Zones** (`AGENT_ZONE=loop-a / loop-b`): each agent prefers incidents in its part of the data center; takeover is global | 🧪 |
| **Agent-to-agent messages** over SpacetimeDB: cross-zone move → ack/conflict, incident update, takeover broadcast, stand-by | 🧪 |
| **Automatic takeover** without a restart: a standby agent adopts a dead agent's workflow when its lease expires | 🧪 |
| Agent tests: 444 (multi-agent branch) / 404 (int) | 🧪 |

## 4. Live recovery proof: R5 harness (`apps/agent/scripts/live-recovery-test.ts`)
| Case | What it proves | Status |
|---|---|---|
| L1 | Agent SIGKILLed mid-checkpoint → DB finishes the checkpoint → fresh agent resumes → move verified, no duplicates | ✅ 8/8 |
| L2 | XID on the planned destination during the checkpoint → separate incident, new safe destination | ✅ 9/9 |
| L3 | L1 + L2 combined (centerpiece) | ✅ 13/13 |
| L4 | Stale fencing token rejected after takeover | ✅ 8/8 |
| L5 | Source GPU fails on the checkpoint due tick → no false durability | 🧪 (harness fixed; re-run pending) |
| L6 | Nemotron unreachable → safety holds, all events CODE | ✅ 5/5 |
| L7 | Two agents, two incidents in parallel, messages, kill one → the other takes over | 🚧 (parallel split seen live; harness fix ready) |
| L8 | Three incidents, two agents | 🚧 |
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
| Agent room: role seats, chat handoffs, alpha/beta owner chips, takeover dividers, agent-to-agent bubbles | 🚧 (EXAMPLE fixture in mock; live once multi-agent merges) |
| Public site https://datacenteros.vercel.app | ⏳ still the old mock build; live deploy at 08:30 |
| Web tests 101–137 + Playwright e2e with axe accessibility checks | ✅ |

## 8. Engineering
- **One integration branch** (`int/r-sprint`), a stable fallback branch, and per-feature branches.
- **~980 tests** across 7 packages, type-checked clean.
- No secrets in git; tokens only in `.env.local` files.

## Honest limits (say these if asked)
- The 64-GPU cluster is **simulated** (an illustrative `demo_gpu` profile with H100-class numbers, not calibrated). Only the L40S tile is real hardware, and it's observation-only.
- Evaluation numbers come from 12 simulated scenarios; no real-world savings claims.
- Agent roles (triage, planner, …) live inside each agent process; separate processes are per agent, not per role.
- The scripted EXAMPLE views in mock mode are not live runs.
