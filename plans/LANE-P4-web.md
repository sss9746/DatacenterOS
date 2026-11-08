# P4 — current remaining work (2026-11-08)

The dashboard and evaluator exist on main (P4's branch is recorded as `P4` in its handoff). Start with **R4** live integration using `onActionDetails` and per-workflow progress, then **R6** checked-in adapter/provenance and **R7** rehearsal. Required fault controls: pump degradation and Xid79; no topology editor. `actor=model` gets a Nemotron badge; code/fallback events get a code badge. Use 5 °C modeled headroom, not the old 7 °C example. Older live-client/loop-row blockers are resolved upstream.

**Current instructions:** [implementation tasks](IMPLEMENTATION-TASKS.md), [fixed scope](IMPLEMENTATION-SCOPE.md), [audited status](IMPLEMENTATION-STATUS.md). These replace the kickoff schedule and acceptance assumptions below. Ownership boundaries remain. Historical times, test counts, build-from-scratch tasks and old demo instructions below are retained for traceability, not current priorities.

---

## Archived kickoff plan

# Lane P4: frontend + evaluation + demo + pitch

**Owns:**
- `apps/web/`: React + Vite + TypeScript + Tailwind + shadcn/ui, deployed on Vercel
- `apps/evaluation/`: the scenario × policy harness
- `docs/pitch/`, `docs/devpost.md`, `demo/`

**Branch:** `lane/p4-web`.
**Must not:**
- mutate state except through admin reducers via `@dcos/db-client`
- implement a second simulator
- hardcode or invent scores

**Reads:** ARCHITECTURE §9, §11; CONTRACTS §0.3–§0.8.

**Data modes:** `VITE_DATA_MODE=mock` uses `createMockClient()` (fixtures) and `live` uses `connect()` to SpacetimeDB. Build everything in mock mode first.

## Screens (one page, judge-friendly)
1. **Header:** run clock (sim time + wall time, both labeled), speed, pause, and a "SIMULATED" badge.
2. **GPU heat map 8×8:** each tile is colored by `temp_c`; throttled tiles show a ⚡; unavailable or XID tiles show ✕ + the code; job color outlines; the r2–r4 loop-a group is visible. A separate **REAL NVIDIA GPU (Brev)** tile for `gpu-real-0` (F-NV2) shows "no data" until HW is live.
3. **Cooling + racks strip:** pump-a/pump-b state, loop-a/loop-b, rack headroom bars.
4. **Jobs timeline:** progress vs. durable work for each job, checkpoint markers (writing/complete), move/restart segments, lost-work highlights.
5. **Incidents panel:** each incident with linked symptoms and resources and its hypothesis. **Two incidents must be visibly separate.**
6. **Agent feed (F-NV1):**
   - stage chips: triage → diagnose → plan → safety → execute → replan → verify
   - for each event: the summary, evidence IDs and **tool calls** (`tool(args) → result`)
   - **every row has an actor badge** (CONTRACTS §0.8):
     - **NEMOTRON** (NVIDIA green) for diagnosis, grouping, choosing and replanning
     - **CODE · math** (grey) for `simulate_plan`, `evaluate_safety`, ranking and ledger steps

   Nemotron's conclusion sentence is shown large, e.g. "24 GPUs on racks 2–4 + pump A at 0 kW → one incident. XID 79 on rack 7 → unrelated, separate incident." Judges should see at a glance that Nemotron diagnoses and replans, and the code only computes.
7. **Action ledger:** `command_key`, operation, status lifecycle, and a **BLOCKED** state with the reason code in plain English (e.g. "rack r6 thermal headroom 2 °C < 7 °C required").
8. **Judge controls** (admin token, presenter laptop only): degrade pump A, XID 79 on a chosen GPU, XID 48, pause, reset run, speed 1–5×.
9. **Scoreboard:** reactive vs. threshold vs. Nemotron on identical scenarios. Shows lost work, delay, wasted GPU-seconds, needless moves, unsafe blocked/executed, unfinished jobs, and **the cases where we lose**, from real `evaluation_result` rows. If the Nemotron cache was used, the scoreboard says so.

## Deliverables in order (‖ = parallel)
| ID | By | Task | Owns | Done when |
|---|---|---|---|---|
| **P4-0** | 8:45 PM | Scaffold `apps/web` (Vite React TS, Tailwind, shadcn); deploy the blank app to Vercel **now** | `apps/web/**` | A live Vercel URL |
| **P4-1** | 9:30 PM | **Heat map + header** in mock mode from `observed_snapshot_demo.json` | `apps/web/src/{app,components/heatmap,components/header}/**` | **Gate 0:** the 8×8 grid renders with correct IDs |
| **P4-2** ‖ | 10:45 PM | **Devpost registration** + track check with organizers (how many tracks; NVIDIA/NMC²/Spacetime requirements); `docs/devpost.md` draft | `docs/devpost.md` | Registered; rules noted in `plans/status/P4.md` |
| **P4-3** | 11:30 PM | **Live mode:** `connect()` subscriptions for GPUs, cooling, jobs and signals; the cooling strip + jobs timeline | `apps/web/src/{data,components/cooling,components/jobs}/**` | **Gate 1:** the pump fault heats r2–r4 tiles live; XID 79 shows ✕ and job-a falls back |
| **P4-4** | 1:30 AM | **Action ledger + judge controls** (admin reducers) + BLOCKED reason text | `apps/web/src/components/{ledger,controls}/**` | **Gate 2:** a manual move onto r6 shows BLOCKED with the reason |
| **P4-5** | 4:30 AM | **Incidents panel + agent feed (F-NV1)** | `apps/web/src/components/{incidents,feed}/**` | **Gate 3:** two separate incidents and live tool calls visible |
| **P4-6** | 7:30 AM | **Evaluation harness** `apps/evaluation`: `loadScenarios()` × {`reactivePolicy`, `thresholdPolicy`, `nemotronPolicy`} through P1's `runScenario` (pure, offline); write `results/*.json` + `publishEvaluationResult` to the DB; summary statistics, including distributions and losses | `apps/evaluation/**` | ≥10 scenarios × 3 policies produce real EvaluationResults |
| **P4-7** | 8:30 AM | **Scoreboard** from `evaluation_result` | `apps/web/src/components/scoreboard/**` | **Gate 4:** the scoreboard shows real numbers, losses included |
| **P4-8** | 9:30 AM | **Pitch + video:** a 3-minute deck in `docs/pitch/` following the PLAN.md demo; record the backup video of the full run; Devpost final text, screenshots, links; name every sponsor tool | `docs/**`, `demo/**` | Video saved; Devpost filled |

## Design notes
- Run `/impeccable critique` once the main screen exists (CLAUDE.md phase 3). Dark operator-console look; one accent color for "agent acted".
- Every simulated number gets a small "simulated" label. Hardware or real-GPU values get a "REAL" label.
- Never show raw model chain-of-thought; show `agent_event.summary` + `tool_calls_json` only.
- **Judge-facing copy:** "reactive rule-based baseline", **not** "NVSentinel".

## Claude sub-agent prompts
- **P4-0/P4-1:** "Scaffold `apps/web` per plans/LANE-P4-web.md (Vite React TS + Tailwind + shadcn) with `VITE_DATA_MODE=mock` using `createMockClient()` from `@dcos/db-client`. Build the 8×8 heat map + header. Own only `apps/web/**`."
- **P4-3 ‖ P4-4 ‖ P4-5:** separate component folders, so they can run in parallel worktrees once the data layer (`src/data`) exists.
- **P4-6:** "Build `apps/evaluation` per P4-6. Use only `@dcos/physics` (`loadScenarios`, `runScenario`, policies) and `agent`'s `nemotronPolicy`. Never fabricate numbers. Own only `apps/evaluation/**`."
