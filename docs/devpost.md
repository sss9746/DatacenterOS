# DataCenterOS — Devpost draft

> DRAFT (C1). Every `[[TODO: …]]` must be filled from a saved artifact or removed before submitting. No number goes on Devpost unless a saved run produced it.

## One-liner

When a GPU cluster starts failing, DataCenterOS decides which training jobs to keep, cap, checkpoint or move. **NVIDIA Nemotron decides, deterministic code computes, and SpacetimeDB remembers**, so recovery survives even if the agent itself crashes.

## Inspiration: the problem

Large training runs lose work to hardware constantly. In Meta's Llama 3 paper, the 54-day pre-training snapshot had **419 unexpected interruptions**, and **58.7%** of them were GPU-related (faulty GPUs, HBM3 memory, etc.). Source: *The Llama 3 Herd of Models*, arXiv:2407.21783.

When a cooling pump degrades or a GPU throws an XID error, operators have minutes to decide, job by job, which work to protect and where it can safely go. Bad moves make it worse: if you migrate a job onto a rack that's already hot, or onto a GPU that's about to fail, you lose the work twice.

## What it does

On a simulated 64-GPU cluster (8×8 grid), DataCenterOS:

1. **Groups symptoms into incidents by shared cause.** Pump A degrades → racks r2–r4 heat up → **one** incident, because code walks the dependency path (GPU → node → rack → cooling loop → pump) and anchors every thermal symptom to the upstream pump.
2. **Lets Nemotron decide, and has code compute.** For each affected job, code enumerates the options (keep, power-cap, checkpoint, restart, move to the top-3 placements, pause, escalate). It simulates each one 600 s ahead and safety-checks it. Nemotron picks among the top eligible options and explains why. The feed shows every option, with the chosen one marked and labeled **NEMOTRON** or **CODE**.
3. **Blocks unsafe actions, with the reason.** If you try to move a job onto the hot rack r6, it's **BLOCKED**: *"The destination rack has too little thermal headroom for this placement."* The SpacetimeDB module re-runs the safety check itself, so neither the agent nor the presenter can bypass it.
4. **Keeps separate faults separate.** An **XID 79** on the planned destination GPU opens a **second, separate incident**, and the plan adapts to a new destination.
5. **Survives its own crash.** Kill the agent mid-recovery: the database keeps ticking and the checkpoint finishes. A fresh agent takes over the workflow lease and **resumes** with no duplicate actions ("resumed by …"). Then the move is verified.
6. **Hands off honestly.** The handoff card separates **recovered** (verified from fresh telemetry) from **needs a human** (the degraded pump needs service; the XID GPU needs hardware service). A cordon is never called a repair.
7. **Shows its score, losses included.** A scoreboard compares the real Nemotron batch against two baselines (reactive, threshold) on 12 fixed scenarios, with the cases where Nemotron did worse.
8. **Reads a real NVIDIA GPU.** A tile streams live `nvidia-smi` telemetry from an NVIDIA Brev GPU. Under load you can watch temperature and power rise. It's observation-only: the agent can't allocate the real GPU.

## How we built it

- **Agent** (TypeScript, `apps/agent`): triage → diagnose → plan → execute → verify. Nemotron runs via **NVIDIA NIM** through an OpenAI-compatible endpoint, with exactly two structured tool calls: triage (confirm, split or merge the incident groups code built) and planning (choose one option per job). A circuit breaker falls back to deterministic mode and labels it.
- **Agent team** (`DCOS_AGENT_TEAM_MODE=multi`): in planning, a Cooling agent and a Workload agent each see only their half of the evidence, ask each other one question, and report to a Recovery Lead, which picks from code-validated options. At most 6 model calls and 30 seconds per round. If a specialist times out, the other covers for it; if the Lead fails, deterministic code decides, labeled CODE. Findings are claims shown as claims: they inform the choice, and deterministic safety decides what can run. The Workflows tab shows each round live. Proven on a local database in single runs; whether the team improves recovery scores is unmeasured.
- **Physics and safety** (`packages/physics`): a pure simulation of thermal and power behavior, the actions, plan estimates, 20 scenarios, the baselines, and a frozen list of safety reason codes (e.g. `DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT`, `STALE_DECISION_EPOCH`, `EVIDENCE_STALE`, `REAL_GPU_NOT_ALLOCATABLE`).
- **Durable state** (`apps/db`, **SpacetimeDB** on Maincloud): workflows hold leases with fencing tokens and compare-and-swap versions. Every action has a unique command key, so a repeated request is a no-op and a different payload under the same key is rejected. Resource leases outlive the agent that took them. A decision epoch rejects stale plans. This is what lets a brand-new agent pick up exactly where a dead one left off.
- **Dashboard** (`apps/web`): React 19, Vite 7 and Tailwind 4, subscribed live to SpacetimeDB. Simulated vs REAL and NEMOTRON vs CODE are labeled on every surface.
- **Real GPU** (`hardware/nvidia-smi-collector`): SSHes to a Brev GPU, streams `nvidia-smi -l 1`, and writes it into the DB with a gateway-only identity. A bounded fp16 matmul (`hardware/brev/load.py`, max 120 s) generates load.
- **Evaluation** (`apps/evaluation`): runs a fixed set of 12 scenarios across 3 policies, and every result row records its provenance.

## Sponsor tools

- **NVIDIA Nemotron via NIM**: the decision-maker for triage and plan choice (`[[TODO: confirm final model id used in the eval batch, e.g. nvidia/nemotron-3.5-lightning-30b-a3b]]`).
- **NVIDIA Brev**: the real GPU behind the live telemetry tile (`[[TODO: GPU type, e.g. L4]]`).
- **SpacetimeDB** (Maincloud): durable workflow, action ledger and leases; it's what makes crash-resume possible.
- **NMC² GPU track** `[[TODO: confirm exact track name]]`

## Results

`[[TODO: fill from apps/evaluation/results/nemotron-fixed12/ only after "eval done". Include wins AND losses vs reactive and threshold baselines. If the batch is missing, say so.]]`

## Challenges we ran into

`[[TODO: 2–3 honest bullets, e.g. making resume idempotent under a dead lease holder; keeping the LLM from picking unsafe options (code rejects any pick that is not an eligible option); grouping by cause instead of by time.]]`

## Accomplishments we're proud of

- The agent can be killed at any point, and a fresh one finishes the job with no duplicate actions. `[[TODO: cite the R5 L1 live result]]`
- Safety is enforced in the database, not just in the agent.
- We show our losses.

## Honest limits

- **The cluster is simulated.** It's a fixed 64-GPU cluster. The GPU profile is **illustrative, not calibrated H100 hardware**: modeled GPU draw (not rack input), an illustrative 35 °C inlet, no communication or slowest-rank effects, and no automatic periodic checkpoints.
- **No real hardware control.** We don't claim to repair or control anything real. The Brev GPU is observation-only.
- **Supervised restart is not agent recovery.** `[[TODO: keep only if the K3 PyTorch kill-and-resume shipped]]` The real PyTorch job restart is labeled "supervised restart (not agent)".
- **Real GPU tile.** `[[TODO: "live" or "labeled REPLAY of a real recording", per Kaushik's 08:00 call]]`
- **Benchmark scope.** It's 12 fixed scenarios, so it's not a general benchmark. Predictions don't include future hidden faults.

## What's next

- Calibrated GPU and thermal profiles from real telemetry.
- A topology editor for real facilities.
- More live crash and overlap evidence at scale.

## Built with

TypeScript · Node.js 22 · pnpm · React 19 · Vite 7 · Tailwind CSS 4 · SpacetimeDB 2.14 (Maincloud) · NVIDIA NIM · NVIDIA Nemotron · NVIDIA Brev · nvidia-smi · Python · PyTorch · OpenAI SDK (OpenAI-compatible client for NIM) · zod · Vitest · Playwright · Vercel

## Links

- Live demo: https://datacenteros.vercel.app `[[TODO: confirm it's live on dcos after C5]]`
- Video: `[[TODO]]`
- Repo: https://github.com/sss9746/DatacenterOS
