# P1 — current remaining work (2026-11-08)

The fixed GPU simulator, safety, forecasts, two baselines and 20 scenario fixtures exist on main. Start with **R1**: phase-aware completion checks and coherent restart failure. Support R6 with detailed runner outputs and regenerated results after semantic changes. Do not rebuild the simulator or add topology configuration.

**Current instructions:** [implementation tasks](IMPLEMENTATION-TASKS.md), [fixed scope](IMPLEMENTATION-SCOPE.md), [audited status](IMPLEMENTATION-STATUS.md). These replace the kickoff schedule and acceptance assumptions below. Ownership boundaries remain. Historical times, test counts, build-from-scratch tasks and old demo instructions below are retained for traceability, not current priorities.

---

## Archived kickoff plan

# Lane P1: simulation + safety + baselines (owner: ___)

**Owns:** `packages/physics/`. The orchestrator (Suvan's Claude session) owns `packages/contracts/`, `plans/`, root config and `scripts/`, and does the merges. A contract change is a request to the orchestrator.
**Branch:** `lane/p1-sim`.
**Must not:** write DB reducers, agent code or UI.
**Reads:** ARCHITECTURE §2, §5; CONTRACTS §0.3–§0.7.

**Already done:**
- the v0 facility physics (95 tests)
- `@dcos/contracts` v1.1.0: 26 generated types, `validatePayload`, 15 tests, validator green

## Deliverables in order (‖ = can run in parallel worktrees)
| ID | By | Task | Owns | Done when |
|---|---|---|---|---|
| **P1-0** | ✅ done | Plan v3 + `@dcos/contracts` on `main` (orchestrator) | — | — |
| **P1-1** ‖ | 8:45 PM | **GPU fixtures for everyone:** `packages/physics/fixtures/gpu/` containing `observed_snapshot_demo.json` (ObservedSnapshot for `gpu_demo_8` at t=0), `observed_snapshot_pump_degraded.json` (t=120 s after pump-a degradation), `tick_result_example.json`, `signal_xid79.json`. All validate with `validatePayload`. Hand-built or script-built; must match the §0.3 IDs | `fixtures/gpu/**`, `scripts/make-gpu-fixtures.ts` | A test validates every fixture; P2, P3 and P4 are pinged |
| **P1-2** ‖ | 9:30 PM | Move the v0 exports to `@dcos/physics/v0` (package `exports` map). The new root exports §0.6 names. The 95 v0 tests keep passing | `src/index.ts`, `src/v0/index.ts`, `package.json` | `pnpm -r test` green; `import { step } from '@dcos/physics'` is the new GPU `step` |
| **P1-3** | 10:00 PM | **`buildPreset('gpu_demo_8')` + world model:** resources, dependency edges (§0.3), per-loop cooling (pump-a → loop-a → r2–r4), 64 GPUs, 3 jobs with specs and starting checkpoints, `toObserved()` | `src/gpu/preset.ts`, `src/gpu/world.ts`, `src/gpu/observe.ts` | Snapshot validates; 64 GPUs; job placements as in §0.3; `toObserved` has no private fields |
| **P1-4** | 11:00 PM | **`step()`:** rack inlet temp from loop cooling (reuse the v0 thermal formula); GPU temp, throttle at 85 °C and shutdown at 92 °C (§0.4); job progress = Σ GPU rate × clock factor; faults due now apply first; XID 79 → GPU unavailable → non-elastic job fails back to `durable_work_units`; emits TelemetryEvent (≤1 Hz per GPU) and SignalEvent; `material_change` bumps `decision_epoch` | `src/gpu/step.ts`, `src/gpu/faults.ts`, `src/gpu/telemetry.ts` | **Gate 1 physics test:** pump-a degradation at 10 s heats r2–r4 GPUs past 85 °C within the horizon while r5–r8 stay cool; XID 79 on `gpu-r3-n1-0` fails job-a and resets progress; the same seed gives an identical result |
| **P1-5** | 11:45 PM | **Actions inside `step()`:** each command has a `due_sim_time_ms` and completes on a later tick. `checkpoint` (30 s; durable only on completion, and only if the storage is accessible), `migrate_restart` (all-or-nothing allocation, 120 s restart), `power_cap`, `pause_job`, `cordon_gpu`, `keep_running`, `escalate`. Returns `completed_command_keys` / `failed_command_keys` | `src/gpu/actions.ts` | Tests: a checkpoint isn't durable mid-write; a migration to busy GPUs fails atomically; cordon never marks a GPU healthy |
| **P1-6** ‖ | 12:30 AM | **`evaluateSafety()`** with every §0.7 reason code (headroom = projected rack temp vs. slowdown, over a 120 s look-ahead) | `src/gpu/safety.ts` | One test per reason code; a move onto r6 is denied with `DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT` |
| **P1-7** ‖ | 1:15 AM | **`simulatePlan()`:** clone an *estimated* world from the ObservedSnapshot (no private faults; current observed degradation persists), apply the commands, step over a 600 s horizon, return PlanMetrics, plus a "do nothing" reference | `src/gpu/simulate.ts` | Deterministic; in the pump-degraded fixture, job-a's checkpoint + move beats keep-running, and for job-b keep/cap beats move |
| **P1-8** ‖ | 2:00 AM | **Baseline policies:** `reactivePolicy` (only on XID 48/79: cordon + restart from checkpoint on free GPUs) and `thresholdPolicy` (GPU over 83 °C → checkpoint + move the job if safe). Pure functions | `src/gpu/policies.ts` | Tests on fixtures; neither reads private fields |
| **P1-9** | 3:30 AM | **Scenarios:** at least 10 (20 stretch) seeded `fixtures/scenarios/*.json` from ARCHITECTURE §9 (warning-only, severe pump, failed GPU, pump + GPU mid-checkpoint, no spare capacity, non-preemptible, hot destination, storage inaccessible, stale telemetry, two independent incidents, near-complete job, harmful preventive move…), plus `loadScenarios()` and an offline `runScenario(scenario, policy)` → `EvaluationResult` | `fixtures/scenarios/**`, `src/gpu/scenarios.ts`, `src/gpu/run.ts` | `runScenario` with reactive and threshold returns valid EvaluationResults; hand them to P4 |

## Claude sub-agent prompts (each in its own worktree)
- **P1-1:** "Build `packages/physics/fixtures/gpu/` per plans/LANE-P1-sim.md P1-1 and CONTRACTS §0.3–§0.5. Use `@dcos/contracts` types and `validatePayload` in a vitest test. Own only `fixtures/gpu/**`, `scripts/make-gpu-fixtures.ts` and `test/gpu-fixtures.test.ts`."
- **P1-2:** "Do P1-2: add a `v0` subpath export for the existing facility API without changing its behavior; all 95 tests must pass. Own only `src/index.ts`, `src/v0/index.ts`, `package.json` and test import paths."
- **P1-3 + P1-4 + P1-5:** one agent, sequential, since they share the world model: "Implement the GPU layer per P1-3..P1-5. Pure TS, no Node APIs (it must run inside SpacetimeDB), seeded RNG only. Own `src/gpu/{preset,world,observe,step,faults,telemetry,actions}.ts` + tests."
- **P1-6 and P1-7 and P1-8:** three parallel agents once P1-5 is merged; each owns its single file plus its test.

## Rules for this package
- **No `fs`, `Date.now()`, `Math.random()` or network.** Everything takes `seed` / `rng_state` explicitly, so the code runs inside the SpacetimeDB module.
- Private fields (`active_faults_private`, `hidden_physics_state_json`, `due_faults_private`) never appear in `ObservedSnapshot` or `PlanMetrics`.
- Every number comes from §0.4 constants in `src/gpu/constants.ts`, labeled simulated.
