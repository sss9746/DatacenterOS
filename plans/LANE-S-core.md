# LANE-S-core.md: Lane S (Suvan): physics engine + eval + integrator

> **Authority:** `plans/CONTRACTS.md` (latest v1.x) is the source of truth. Where this file and CONTRACTS differ, **CONTRACTS wins**. Where CONTRACTS is silent, this file decides for Lane S; those decisions are in §2 and get folded into CONTRACTS as `v1.x` notes.
> Written Sat Nov 7, ~4:45 PM. Submission is Sun 12:00 PM. **Feature freeze is Sun 10:00 AM.**
> SpacetimeDB work (`spacetime/module/**`, publishing, tokens, bindings) belongs to **Lane B**: see `plans/LANE-B-spacetime.md`. This file only covers the interface with it (§4).

---

## 1. Role, paths, schedule

### 1.1 Role summary
Suvan is the team lead and runs Lane S with many parallel Claude Code agents (Claude Max). Lane S:
1. **Builds `@dcos/physics`:** the pure, deterministic TypeScript engine. It contains the compiler, `step`, actions, failures, `simulate`, `checkAction` (the safety engine), `detect` (the monitors), `makeRng`, the fixtures and the builder presets. B's module, B's `simulate_plan` procedure and the eval all run this one implementation.
2. **Builds the evaluation:** a seeded 50-scenario generator, the rules baseline, the `run_eval` harness, an offline Node cross-check and the plots. Its outputs are `eval/results/summary.csv`, `summary.png` and `summary.json` (CONTRACTS §9).
3. **Owns the repo root:** workspace, `CODEOWNERS`, `.env.example`, `.gitignore`, the root `README.md` (pasting in the other lanes' sections), the license and `scripts/sync-physics.mjs`.
4. **Owns `plans/CONTRACTS.md`** and processes every contract-change request (CONTRACTS §12), including B's §3 changes.
5. **Integrates the team.** Suvan is the only person who merges to `main`, in the order **S → B → C → A → D**. He runs the go/no-go checks and tags `contracts-v1`, `mvp`, `hard-piece` and `freeze`.

### 1.2 Owned paths (only Lane S edits these)
- `packages/physics/**` (including `fixtures/**` and `fixtures/presets/**`)
- `eval/**`
- `scripts/sync-physics.mjs`
- `plans/CONTRACTS.md`, `plans/LANE-S-core.md` and `plans/status/S.md`
- The root files `package.json`, `pnpm-workspace.yaml`, `.env.example`, `.gitignore`, `README.md`, `CODEOWNERS` and `LICENSE`
- At merge time only: `pnpm-lock.yaml` conflict resolution (CONTRACTS §11)

### 1.3 Never touch (open an issue `REQUEST <lane>: …` instead)
- **B:** `spacetime/module/**`, `scripts/gen-bindings.sh` and `apps/web/src/module_bindings/**`. Suvan never publishes `dcos-dev` or `dcos` and never mints or allow-lists identities, except as a fallback that B explicitly hands over.
- **C:** `agents/**`
- **D:** `apps/web/**`, `docs/pitch/**` and `docs/devpost.md`
- **A (shared):** `hardware/**`, `scripts/demo_check.py` and `qa/**`. Suvan may claim an A task in `plans/status/A.md` like anyone else; while working on it, the A rules apply.
- Other lanes' `plans/status/*.md` files

`scripts/sync-physics.mjs` is S's script, but it **writes into B's folder** (`spacetime/module/src/physics/`). **B runs it and commits its output; S never commits there.**

### 1.4 Sync schedule (merges to `main`, done only by Suvan, in the order S → B → C → A → D)
| Time | Merge | Gate (details in §6.4) |
|---|---|---|
| **6:15 PM** | Fixture drop: an S-only fast-forward of the scaffold + `packages/physics/fixtures/**` (exception E1, §6.1) | The 3 fixtures parse |
| **7:00 PM** | S → B → C → A → D | **CONTRACTS v1 frozen.** Physics `step`/`compile`/failures/actions are real. B's schema is on `dcos-dev` and the bindings are regenerated |
| **9:00 PM** | S → B → C → A → D | `simulate`/`checkAction`/`detect` are real. The tick is live (B). The dashboard moves |
| **11:00 PM** | S → B → C → A → D | PLAN §4.2 MVP checklist green on `dcos`. `git tag mvp` |
| **1:30 AM** | S → B → C → A → D | 50 scenarios generated. The none/rules eval runs on `dcos-eval`. Pre-sleep status lines |
| **3:00 AM** | **S + B + C only** (exception E2) | Hard-piece check (4 scenarios) plus ≥ 20 agent eval rows, then `git tag hard-piece` |
| **7:30 AM** | S → B → C → A → D | Builder + presets, the 50-scenario chart, a full demo run, the local fallback practiced |
| **9:45 AM** | S → B → C → A → D (last) | `demo_check.py` green 3× on prod |
| **10:00 AM** | — | **FREEZE.** `git tag freeze`. After this, only `fix(demo):` commits approved by Suvan |

### 1.5 Suvan's sleep slot: **4:15 → 7:15 AM** (a deliberate change from PLAN §6.1's 4:30–7:30)
- **Why it shifts 15 minutes earlier:** the 7:30 AM merge is the biggest of the night (builder, eval, handoff), and Suvan needs 15 minutes to pull every lane branch and dry-run it first.
- **Before sleeping (by 4:15):**
  1. Start the resumable 50-scenario agents run in the background (S-P3-04).
  2. Write `plans/status/S.md`.
- **Nothing needs Suvan from 4:15 to 7:15.** There are no merges in that window, and lanes keep committing to their own lane branches.
- **If `hard-piece` isn't tagged by 3:30 AM:** Suvan applies the PLAN §9 cuts first and sleeps 4:30 → 7:20 instead. Never sleep less than 2.5 h.

---

## 2. Decisions this file makes (clarifications; Suvan adds them to CONTRACTS as v1.x notes before 7:00 PM)

| ID | Decision | Why |
|---|---|---|
| **S-D1** | `degraded` (≥ 45 °C) is **a status and counts toward downtime only. It does not halve load** in v1 | CONTRACTS §1's sanity numbers ("55 °C in about 5.5 min", "all racks shut down in about 6 min") only hold without PLAN §3.4's 50% load drop. With the drop, shutdown takes about 8 min |
| **S-D2** | `sensor_age_s` is the number of **seconds since the last fresh sample**: 0 each tick for a live sensor, and `+= dt` while frozen. There is **no sensor noise**, so `observed_temp_c === true_temp_c` unless the sensor is frozen | Matches CONTRACTS §2 ("equals true unless the sensor is frozen"). PLAN's "since the reading last changed" would flag every steady rack as frozen |
| **S-D3** | Cooling uses **design-balanced valves**, as specified in §3.1 step 7. A rack's share comes from its `base_load_kw`; surplus cooling only pulls a satisfied rack back toward ambient | This is the only simple model that hits CONTRACTS' fan sanity number (4.2 kW deficit) and still lets a rack recover after a plan. It also makes CONTRACTS §6.1's "Migrate 3 kW off rack_3" plan genuinely work |
| **S-D4** | `facility.status` values are `normal`, `degraded` and `critical` (from `facilityStatus(s)`, exported in §3.2) | CONTRACTS §3.1 types it as a string without listing values. B writes it, D colors it |
| **S-D5** | The cooling margin is `C − Q_it`, where C is the cooling from online, powered pumps and Q_it is the effective rack load. The real fan's fault shows up through `fan_vibration_anomaly` and the rack's own heating, not through the margin | Matches PLAN §4.2's "+2 kW" and the symptom definition |
| **S-D6** | Lane A's fan lead-time CSV lives at `hardware/bridge/results/fan_leadtime.csv` (A's path), **not** in `eval/results/` (S's path). S's `plot.py` reads it into `summary.json` `fan` | PLAN P2-A-03 wrote into `eval/`, which A doesn't own |

---

## 3. Physics spec (S-2, S-3 and S-4 implement exactly this)

**Rules for everything in the package:**
- **Pure.** Each function `clone()`s its input with a hand-written deep clone (no `structuredClone`, no `JSON` round-trip in hot paths) and returns a new object.
- **No** `Math.random`, `Date.now`, mutable module state, I/O, Node or DOM APIs, or runtime dependencies.
- **Output must survive `JSON.stringify`:** no `undefined`, `NaN` or `Infinity` in the state.

**Internal constants** live in `src/internal/params.ts`. They aren't part of the contract:
- `CTRL_TAU_S = 30`
- `PUMP_DRAW_FRAC = 0.05`
- `T_MIN_C = 18`, `T_MAX_C = 90`
- `T_RECOVER_C = 40` (degraded → online)
- `SENSOR_STALE_S = 15`

### 3.1 `step(s, dtSec, rng)`, in this order
`rng` is accepted but unused in v1. It's kept for future noise, and B passes `makeRng(seed × 1_000_003 + tick)`.
1. **Clone the state.** `tick += 1` and `sim_time_s += dtSec`.
2. **Tech repairs.** For each component with `repair_eta_tick > 0 && tick >= repair_eta_tick`:
   - set `true_status = observed_status = 'online'`, `sensor_frozen = false` and `repair_eta_tick = 0`
   - set `active = false` on every failure targeting it (B syncs those flags back to its table)
   - a tech can't fix the physical real fan
3. **Continuous failure effects** (derived from active failures every step):
   - a rack's `sensor_frozen` = any active `sensor_freeze` targets it
   - each active `load_spike` adds `params.extra_kw` (default 4) to its rack's heat
4. **Fan timeout.** If `is_real_hardware && fan_last_seen_tick > 0 && tick − fan_last_seen_tick > FAN_ONLINE_TIMEOUT_TICKS`: set `fan_online = false` and `fan_health = 1`. Keep `fan_anomaly`, `fan_fault_class` and `fan_rms` as they were.
5. **Effective rack load:** `L_i = shutdown ? 0 : load_kw + spike_i`. `Q_it = Σ L_i`.
6. **Power:**
   - **Demand** `P = Q_it + Σ PUMP_DRAW_FRAC × capacity`, over pumps that are online.
   - **Supply** = Σ capacity of online utilities.
   - **If supply ≥ P:** powered.
   - **Else, if an online UPS has `ups_energy_kwh > 0` and `P − supply ≤ max_output_kw`:** powered from the UPS. It drains `E = max(0, E − (P − supply) × dtSec / 3600)`, and the UPS `power_kw` is the discharge.
   - **Else:** unpowered. Every rack latches to `shutdown` and pumps give 0 cooling.
7. **Cooling (S-D3).** For each rack that isn't shut down:
   - `C` = Σ `capacity_kw` of pumps that are online and powered. Each pump's `cooling_kw` is its capacity if it contributes, else 0. Its `load_kw` is its draw.
   - `share_i = C × base_i / Σ base_j`, where `base` = `params.base_load_kw` of the racks that aren't shut down.
   - `h_i` = `fan_health`, or 1 for a rack without the real fan.
   - `capacity_i = share_i × h_i`.
   - **If `capacity_i ≥ L_i` (satisfied):** `cooling_i = min(capacity_i, L_i + M_i × max(0, T − T_AMBIENT_C) / CTRL_TAU_S)`. This recovers the rack toward ambient.
   - **Else:** `cooling_i = min(share_i, L_i) × h_i`.
   - The rack's `cooling_kw` is `cooling_i`, and its `power_kw` is `L_i`.
8. **Thermal update (the CONTRACTS §1 formula).** `T' = T + dtSec × ((L_i − cooling_i) / M_i − PASSIVE_K_PER_S × (T − T_AMBIENT_C))`, clamped to `[T_MIN_C, T_MAX_C]`. Here `M_i = thermal_mass_kj_per_c`.
9. **Thresholds** (true temperature):
   - **≥ `T_SHUTDOWN_C`:** `shutdown`, latched until `restore_component` or a tech repair.
   - **≥ `T_DEGRADED_C`:** an `online` rack becomes `degraded` (S-D1: no load change).
   - **< `T_RECOVER_C`:** a `degraded` rack returns to `online`.
   - `observed_status = true_status` (in v1 the lies are in tickets, not in statuses).
10. **Sensors (S-D2):**
    - **Not frozen:** `observed_temp_c = true_temp_c` and `sensor_age_s = 0`.
    - **Frozen:** `observed_temp_c` is unchanged and `sensor_age_s += dtSec`.
    - Non-rack components have both temperatures fixed at 22.

### 3.2 The other functions
- **`applyFailure(s, f)`.** Pushes `f` and then:
  - `pump_fail` sets the pump `offline` (latched)
  - `utility_loss` sets the utility `offline` (latched)
  - `sensor_freeze` sets `sensor_frozen = true`
  - `load_spike` makes no immediate change
  - `ticket_lie` makes **no physical change**

  A wrong target kind throws `INVALID: <kind> needs a <pump|utility|rack> target`. An unknown id throws `NOT_FOUND: component <id>`.
- **`applyAction(s, a)`:**

  | Action | Effect |
  |---|---|
  | `shutdown_component` | Status becomes `shutdown` |
  | `restore_component` | Status becomes `online` (clears a latched rack shutdown, or a pump/utility that was shut down). **Throws** `INVALID: <id> has an active fault; dispatch_tech required` if an active `pump_fail`/`utility_loss` targets it |
  | `shed_load` | `load_kw = max(0, load − (params.kw ?? load))` |
  | `migrate_load` | Moves `min(params.kw ?? load, load)` to `params.to`. The destination must be a rack that isn't shut down, else it throws `INVALID: migrate target` |
  | `set_load` | `load_kw = params.kw` (throws `INVALID` if it's missing or negative) |
  | `dispatch_tech` | `repair_eta_tick = tick + TECH_REPAIR_TICKS` |
- **`setFanReading(s, rackId, anomaly, tick, faultClass = '', rms = 0)`:**
  - the rack must be `is_real_hardware`, else it throws `INVALID: <id> is not the real-fan rack`
  - clamps `anomaly` to [0, 1]
  - sets `fan_anomaly`, and `fan_health = 1 − clamp((anomaly − 0.3) / 0.6, 0, 1) × 0.7`
  - sets `fan_fault_class = faultClass`, `fan_rms = rms`, `fan_online = true` and `fan_last_seen_tick = tick`
- **`simulate(s, actions, ticks, rng)`:**
  - applies the actions to a clone (an invalid action throws), then runs `ticks` steps with `dt = 1`
  - `min_cooling_margin_kw` is the minimum of `C − Q_it`
  - `peak_temp_c` is the maximum true rack temperature
  - `racks_degraded` counts distinct racks that were ever degraded and never shut down
  - `racks_shutdown` counts distinct racks that were ever shut down (including ones already shut down at the start)
  - `downtime_rack_s` = Σ dt × (racks degraded or shut down)
- **`checkAction(s, a, rng, horizon = SAFETY_HORIZON_TICKS)`.** It **blocks only when the action is worse than doing nothing**, so helpful actions in an already-bad state stay allowed.
  - **Baseline:** `base = simulate(s, [], h)` and `act = simulate(s, [a], h)`.
  - **Invalid action:** returns `{ok: false, reason: 'BLOCKED: invalid action: <msg>', predicted: base}` and never throws.
  - **Checks, in order:**
    1. `act.racks_shutdown > base.racks_shutdown` → `BLOCKED: <n> racks shut down within <t> s`
    2. `act.peak_temp_c > T_DEGRADED_C && act.peak_temp_c > base.peak_temp_c + 0.5` → `BLOCKED: rack <id> exceeds 45 °C`
    3. `act.min_cooling_margin_kw < −1 && act.min_cooling_margin_kw < base.min_cooling_margin_kw − 1` → `BLOCKED: cooling <C> kW < load <Q> kW`, with C and Q taken at the worst tick
  - **When blocked,** it extends the action run to 600 ticks and appends `; projected: <n> racks shut down within <t> s` (or `; projected: peak <p> °C in 600 s`).
  - **Otherwise** it returns `OK: margin <m> kW, peak <p> °C over <h> s`.
  - Numbers are formatted with `fmt = x => String(Math.round(x * 10) / 10)`. `predicted` is `act`.
- **`detect(s, history, openSymptoms)`.** Uses **observed fields only** (`observed_status`, `observed_temp_c`, `sensor_age_s`, `load_kw`, `cooling_kw`, the `fan_*` fields, `ups_energy_kwh`) plus `history`. It never reads `true_*` or `sensor_frozen`, and it skips any symptom already in `openSymptoms`.

  | Symptom | Fires when | `component_ids` | Severity |
  |---|---|---|---|
  | `cooling_margin_negative` | The observed `C − Q_it` is < 0 | offline pumps + all racks | critical below −10, else high |
  | `rack_temp_warning` | Any rack's observed temp is ≥ 35 | those racks | critical at ≥ 45, else high |
  | `thermal_imbalance` | (a) a rack's `sensor_age_s > SENSOR_STALE_S` while other racks report fresh (`sensor_age_s = 0`), or (b) best effort: its reported temp has stayed flat ±0.05 for 20 history points while its observed `load_kw > cooling_kw + 1` | that rack | high |
  | `fan_vibration_anomaly` | A real rack's `fan_online && fan_anomaly ≥ 0.5` | real rack | high |
  | `power_on_ups` | The utility is observed offline and UPS energy is > 0 | utility + UPS | critical below 25% energy, else high |
  | `fan_offline` | A real rack has `fan_online === false && fan_last_seen_tick > 0` (it never fires before the bridge's first reading) | real rack | low |
- **Extra exports** (additive, Suvan records them in CONTRACTS §2 as v1.1):
  - `computeBalance(s, view: 'true' | 'observed') → {supply_kw, demand_kw, powered, cooling_kw, load_kw, margin_kw}`
  - `facilityStatus(s) → 'normal' | 'degraded' | 'critical'`:
    - `critical` = any rack shut down, or the margin is below −10
    - `degraded` = any rack degraded, or the margin is below 0
  - `PRESET_CONFIGS: Record<'enterprise_2pump' | 'ai_hall_3pump' | 'edge_small', FacilityConfig>`

### 3.3 Expected numbers (the vitest suite asserts them, with tolerance)
For the default facility, `compileTopology(defaultDemoConfig())`, with racks starting at 22 °C:
- **Healthy:** every rack stays at 22.0 ± 0.1 for 600 ticks. The margin is +52 (100 − 48).
- **`pump_fail pump_B`:** the margin is +2.0, and every rack stays < 23 °C for 600 ticks.
- **Both pumps down:** each rack heats at about 0.1 °C/s. It's degraded by **≈ 245 s** (assert ≤ 260) and shut down by **≈ 360 s** (assert ≤ 380, so "about 6 min").
- **The Pump A trap** (pump_B failed, then `checkAction(shutdown_component pump_A)`):
  - `ok = false`
  - the reason starts with `BLOCKED: cooling 0 kW < load 48 kW` and contains `projected: 8 racks shut down within`
  - the same action with both pumps healthy is `OK:`
- **Real fan:**
  - `setFanReading(rack_3, 0.9)` gives health 0.3; 0.6 gives 0.65; 0.3 gives 1.0.
  - With both pumps up and anomaly 0.9, only rack_3 heats, at about 0.07 °C/s, and passes 35 °C in ≈ 185 s (assert 150–220). The other racks stay at 22.
  - `migrate_load rack_3 → rack_1, 3 kW` then brings rack_3 back below 35, and rack_1 stays < 30. That is CONTRACTS §6.1's winning plan.
  - With pump_B failed and anomaly 0.9, `dispatch_tech pump_B` + `migrate_load rack_3 → rack_1 3 kW` beats doing nothing in `simulate(…, 300)`.
- **`sensor_freeze rack_5`:** the observed temperature stays fixed, `sensor_age_s` grows by 1 per tick, and `thermal_imbalance` fires within ≤ 16 ticks. Meanwhile rack_5's true temperature evolves (test it with pump_B and pump_A failed).
- **`load_spike rack_7 {extra_kw: 4}` with pump_B failed:** the margin is −2 and `cooling_margin_negative` fires.
- **`utility_loss util_1`:** the UPS drains about 53 kW (48 of racks plus 5 of pump draw), so a 20 kWh UPS lasts ≈ 22.6 min. Racks stay up until it reaches 0, then all 8 shut down. `power_on_ups` fires.
- **`dispatch_tech pump_B` after a `pump_fail`:** pump_B is online at tick + 60, and its failure is `active = false`.
- **Purity and determinism:** deep-freeze the input, and every function still runs. The same input gives a byte-identical `JSON.stringify` after 600 steps.
- **Performance** (Node, 12 components):
  - `step` < 0.2 ms
  - `simulate(300)` < 10 ms
  - `checkAction` < 25 ms

  The tests log the timings and assert < 100 ms so they aren't flaky. B's tick and procedure budgets depend on these numbers.

---

## 4. Interfaces with Lane B (SpacetimeDB)

### 4.1 What S delivers to B
| By | Deliverable | How B gets it |
|---|---|---|
| **5:25 PM** | `@dcos/physics` scaffold: `constants.ts`/`types.ts` verbatim from CONTRACTS, the frozen `index.ts` export list, and stub functions that throw `INVALID: not implemented`. It builds to `dist/` (ES2022 ESM + `.d.ts`) | `main` (Phase-0 bootstrap) |
| **6:00 PM** | Real `compileTopology` + `defaultDemoConfig` (seed works); `scripts/sync-physics.mjs` (+ `--check`) | `origin/lane/s-core` (B may `git merge origin/lane/s-core` at any time; it only contains S-owned paths) |
| **6:15 PM** | Fixtures (CONTRACTS §9), whose column names match CONTRACTS §3.1 including `request_key`, `fan_fault_class`, `fan_rms` and history `fan_anomaly` | `main` (E1 drop) |
| **7:00 PM** | Real `step`, `applyFailure`, `applyAction`, `setFanReading`, `computeBalance`, `facilityStatus` | 7:00 sync |
| **8:15 PM** | Real `simulate` + `checkAction` (B's `request_action` and `simulate_plan` need them) | `origin/lane/s-core` merge; `main` at 9:00 |
| **8:30 PM** | Real `detect` (B's tick opens incidents) | Same |
| **4:30 AM** | `PRESET_CONFIGS` + `fixtures/presets/*.json` for D's builder (D needs them by 4:30 AM; B's `build_facility` validates them) | `origin/lane/s-core` |

**Guarantees S gives B:**
1. Frozen signatures (CONTRACTS §2).
2. No runtime dependencies, and no Node or DOM APIs.
3. Thrown errors are always `Error('NOT_FOUND: …' | 'INVALID: …')`, so B can rethrow them unchanged.
4. The state is plain JSON, safe to store in `ground_truth.state_json`.
5. The performance numbers in §3.3.
6. **The bundling fallback:** `node scripts/sync-physics.mjs` copies `packages/physics/src/**` → `spacetime/module/src/physics/**` with a "GENERATED, edit packages/physics" header on each file, and `--check` exits 1 when that copy is stale. **S writes and maintains the script; B runs it, commits the copy and switches its single import shim.**

### 4.2 What S needs from B
| By | Need | Used by |
|---|---|---|
| 7:00 PM | B confirms the published column names match CONTRACTS §3.1 (so the fixtures are right). B also reports the HTTP shape of `simulate_plan` and the u64 JSON encoding | S-3 fixtures; S-6 `stdb_http.py` |
| 7:30 PM | B's bundling decision (workspace import vs `sync-physics`) | S keeps `sync-physics.mjs --check` in the merge checklist if it's active |
| **11:30 PM** | **Local `dcos-eval`**, published from the latest `lane/b-spacetime`, on **Suvan's laptop** (`spacetime start`; B publishes it there), with: <ul><li>`reset_to_seed(config_json)` that leaves the run paused at tick 0</li><li>`admin_advance(ticks ≤ 600)` taking < 2 s for 600 ticks</li><li>`set_run_config`, `inject_failure`, `clear_all_failures`, `request_action` (with `request_key`), `execute_action`</li><li>metrics `downtime_rack_s`/`unsafe_*`/`agent_*`</li></ul> | S-6 `run_eval.py` |
| 11:30 PM | **Eval tokens** (CONTRACTS §10): an **eval admin token** for the harness, preferably the **owner** token of `dcos-eval` so the harness can SQL the private `ground_truth` for true temperatures, and an **eval agent token** for C's worker in eval mode. Both are handed over locally on Suvan's laptop and written to `eval/.env.eval.local` (gitignored, matched by `.env*`) | S-6, C's worker |
| 1:30 AM | `dcos-eval` survives 50 `reset_to_seed` cycles with no unbounded table growth | The full eval |
| Every sync | B's lane checks green + bindings regenerated on `lane/b-spacetime` before its PR | Integrator (§6.2) |

**If the owner token can't be shared:** the harness gets the true root cause from the scenario JSON (it injected the failures itself), and it uses observed temperatures for time-to-stabilize, which is disclosed in `eval/README.md`. **The eval never depends on B for truth.**

---

## 5. Running this lane with parallel Claude agents

### 5.1 Topology and timing
| Agent | Scope | Window | Parallel with | Feeds |
|---|---|---|---|---|
| **S-1** Repo root | Root files, CODEOWNERS, the physics scaffold (constants/types/index/rng + stubs), `sync-physics.mjs` | 4:50–5:25 PM | (first) | Everyone at 5:25 |
| **S-2** Physics core | `balance`, `step`, `actions`, `failures`, `facilityStatus` + tests | 5:25–7:00 PM; tuning until 12:30 AM | S-3, S-4 | B (7:00), S-4 |
| **S-3** Compiler + fixtures | `compile`, `defaultDemoConfig`, layout, fixtures, presets + tests | 5:25 PM–6:15 PM; presets 7:30–8:30 PM | S-2, S-4 | **C/D fixtures 6:15**, B seed |
| **S-4** Safety + monitors | `simulate`, `safety`, `monitors` + tests (written against the signatures; real tests once `step` lands ~7:00) | 5:45–8:30 PM; `detect` tuning until 12:30 AM | S-2, S-3 | B `request_action` (8:15), B tick (8:30) |
| **S-5** Scenarios + offline runner | `eval/scenarios.ts`, `eval/offline.ts` (none/rules in pure Node: a fast cross-check and the fallback), `eval/package.json` | 7:00–10:30 PM | S-2/S-4 tails | S-6 |
| **S-6** Eval harness | `eval/stdb_http.py`, `rules_baseline.py`, `run_eval.py`, `pyproject.toml`, `README.md` | 9:00 PM–1:30 AM; runs until 7 AM | S-5, S-7 | `hard-piece`, the chart |
| **S-7** Plots + summaries | `eval/plot.py` → `summary.csv`/`.png`/`.json`, `same_failure.csv` | 11:30 PM–3:30 AM; final at 7:15 AM | S-6 | D's Results page, the pitch |
| **S-8** Reviewer | A read-only `/review` of `lane/s-core` vs `main`, plus the contract-conformance checklist | At each sync, T−25 min | — | Each merge |

- **Concurrency cap:** at most **4 code agents at once** (peak 5:45–7:00 PM: S-2, S-3, S-4 + S-1's tail). That leaves Suvan time for integration, CR triage and B/C/D questions.
- **Sequential dependencies:**
  - S-1 → (S-2 ∥ S-3 ∥ S-4)
  - S-2 `step` → S-4's real tests
  - S-3 `compileTopology` → S-5
  - S-5 scenarios + B's `dcos-eval` → S-6 runs
  - S-6 `runs.csv` → S-7

### 5.2 Worktrees and branches (CONTRACTS §11 naming: `wt/s-<n>-<topic>`)
Run these from the main clone `C:\Users\suvan\Desktop\Desktop\code\hackathon\datacenteros` in Git Bash:
```bash
git switch lane/s-core
git worktree add ../dcos-s2 -b wt/s-2-physics-core    lane/s-core
git worktree add ../dcos-s3 -b wt/s-3-compile-fixtures lane/s-core
git worktree add ../dcos-s4 -b wt/s-4-safety-monitors  lane/s-core
git worktree add ../dcos-s5 -b wt/s-5-scenarios        lane/s-core   # at 7:00 PM, after the S-2/S-3 merge into lane/s-core
git worktree add ../dcos-s6 -b wt/s-6-eval-harness     lane/s-core   # at 9:00 PM
git worktree add ../dcos-s7 -b wt/s-7-eval-plots       lane/s-core   # at 11:30 PM
cd ../dcos-s2 && pnpm install && claude        # one terminal per worktree; paste COMMON RULES + the prompt
```
S-8 runs from Suvan's orchestrator session as an Agent-tool subagent of type `skilled-reviewer` (read-only).

**Bringing work back into the lane** (Suvan, every 60–90 min, and always at T−30 before a sync):
```bash
cd ../datacenteros && git switch lane/s-core && git merge --no-ff wt/s-2-physics-core
pnpm -r build && pnpm -F @dcos/physics test && git push origin lane/s-core
cd ../dcos-s4 && git merge lane/s-core          # refresh the dependent worktrees
```
When S-4 needs S-2's `step`, Suvan merges `wt/s-2` into `lane/s-core`, then runs `git merge lane/s-core` inside `../dcos-s4`. Agents never merge each other's branches.

### 5.3 Common rules (start every agent prompt with this block)
```text
COMMON RULES: Lane S agent, DataCenterOS (HackUTD 2026). Hackathon mode: working beats elegant.
1. Read plans/CONTRACTS.md fully and plans/LANE-S-core.md §2–§4 before writing code. CONTRACTS wins, then LANE-S-core.md.
   Names, signatures, column names, error prefixes and checkAction reason prefixes are FROZEN: copy them exactly.
2. Physics code is pure and deterministic: no Math.random, Date.now, structuredClone, mutable module state, I/O, or Node/DOM APIs.
   Never mutate inputs. number (not bigint) everywhere. Throw only Error('NOT_FOUND: …') or Error('INVALID: …').
3. SpacetimeDB is Lane B's. Never edit spacetime/**, scripts/gen-bindings.sh or apps/web/src/module_bindings/**. When your work
   touches SpacetimeDB behavior (HTTP API, procedures, scheduled ticks, private tables), read the official docs at https://spacetimedb.com/docs
   (TypeScript module reference, HTTP API) instead of guessing, and design around: private-by-default tables, a scheduled tick
   (ScheduleAt.interval(1_000_000n)), deterministic reducers (ctx.random()/ctx.timestamp only; our module uses makeRng(seed×1_000_003+tick)),
   simulate_plan as a procedure. Never publish to dcos-dev or dcos.
4. Edit ONLY the files under OWNS. Need another file changed, a new dependency, or a contract change? STOP and put it in your REPORT.
   Never edit plans/CONTRACTS.md, root files, or other lanes' paths.
5. Commit small and often on YOUR worktree branch only: `feat(s): …` / `fix(s): …` + the attribution trailer. Never push, merge,
   rebase or switch branches. No secrets in any file (tokens live only in gitignored .env* files).
6. Tests (vitest / pytest) only where the logic is tricky: physics, compiler, safety, monitors, eval math. Verify the rest by running it.
7. Done means: `pnpm -F @dcos/physics build && pnpm -F @dcos/physics test` green (physics agents) or your ACCEPTANCE list (eval agents).
REPORT (your final message): ## Done / ## Files changed / ## How to verify (exact commands) / ## Measured numbers /
## Deviations from CONTRACTS or LANE-S (should be none) / ## Requests (deps, contract changes, other lanes) / ## Open risks
```

### 5.4 Agent prompts (paste after the COMMON RULES block)

#### S-1: repo root, CODEOWNERS and the physics scaffold (4:50 PM)
```text
GOAL: The monorepo skeleton + the @dcos/physics scaffold with the frozen API, so S-2/S-3/S-4 and Lanes B/C/D can start at 5:25 PM.
OWNS: package.json, pnpm-workspace.yaml, .gitignore, .env.example, README.md (skeleton), CODEOWNERS, LICENSE (MIT), tsconfig.base.json,
  scripts/sync-physics.mjs, packages/physics/{package.json,tsconfig.json,vitest.config.ts}, packages/physics/src/{constants,types,index,rng}.ts,
  STUBS (later owned by S-2/S-3/S-4) packages/physics/src/{balance,step,actions,failures,compile,simulate,safety,monitors,presets}.ts,
  packages/physics/test/smoke.test.ts, plans/status/S.md (template in LANE-S §10).
MUST NOT TOUCH: spacetime/**, scripts/gen-bindings.sh, agents/**, apps/**, hardware/**, scripts/demo_check.py, qa/**, eval/**.
CONTRACTS: §0 (→ CODEOWNERS), §1 (constants.ts verbatim), §2 (types.ts verbatim incl. fan_fault_class/fan_rms; index signatures), §7 (data dir
  committed), §8 (.gitignore list), §10 (every env name), §11.
STEPS:
1. pnpm-workspace.yaml: packages ["packages/*", "spacetime/module", "apps/*", "eval"]. Root package.json: private, "packageManager": "pnpm@9.x",
   engines node >=22, scripts { build: "pnpm -r build", test: "pnpm -r test", "sync:physics": "node scripts/sync-physics.mjs" }.
2. .gitignore: node_modules, dist, coverage, __pycache__, .venv, .env, .env.*, !.env.example, spacetime/module/scripts/.identities.env,
   .spacetime/. Do NOT ignore hardware/bridge/data/ (add a comment saying why: CONTRACTS §7).
3. .env.example: every CONTRACTS §10 name, with PLAN §2.2 comments (STDB_MODE=live|fixture, VITE_DATA_MODE=fixture|live|http). No token values.
4. CODEOWNERS (GitHub syntax) from CONTRACTS §0: `* @<SUVAN_GH>`; /packages/physics/ /eval/ /plans/CONTRACTS.md /scripts/sync-physics.mjs @<SUVAN_GH>;
   /spacetime/ /scripts/gen-bindings.sh /apps/web/src/module_bindings/ @<B_GH>; /agents/ @<C_GH>; /apps/web/ /docs/pitch/ /docs/devpost.md @<D_GH>;
   /hardware/ /scripts/demo_check.py /qa/ @<SUVAN_GH> @<B_GH> @<C_GH> @<D_GH> (shared); /plans/status/B.md @<B_GH> etc.
   (A later rule wins in CODEOWNERS: put module_bindings AFTER /apps/web/.) Leave the placeholders and list them in the report.
5. packages/physics/package.json: name "@dcos/physics", "type": "module", exports "." → { types: "./dist/index.d.ts", import: "./dist/index.js" },
   "files": ["dist","src"], scripts { build: "tsc -p .", test: "vitest run" }, devDeps typescript ^5 + vitest ^2 only. NO runtime deps.
   tsconfig: target ES2022, module ESNext, moduleResolution Bundler, strict, declaration, lib ["ES2022"] (no DOM), no @types/node in src.
6. constants.ts and types.ts: copy CONTRACTS §1/§2 character for character. index.ts exports exactly:
   export * from './constants.js'; export * from './types.js';
   export { defaultDemoConfig, compileTopology } from './compile.js'; export { step } from './step.js'; export { applyAction } from './actions.js';
   export { applyFailure, setFanReading } from './failures.js'; export { simulate } from './simulate.js'; export { checkAction } from './safety.js';
   export { detect } from './monitors.js'; export { makeRng } from './rng.js'; export { computeBalance, facilityStatus } from './balance.js';
   export { PRESET_CONFIGS } from './presets.js';
   rng.ts: a real mulberry32 makeRng(seed) → [0,1) (handle a negative or huge seed via `seed >>> 0`).
   Each stub throws Error('INVALID: not implemented'); PRESET_CONFIGS stub = {}.
7. scripts/sync-physics.mjs (Node 22, no deps): copy packages/physics/src/** → spacetime/module/src/physics/** (create the dir), prepend
   "// GENERATED by scripts/sync-physics.mjs: edit packages/physics/src instead" to each .ts file, delete stale files in the target.
   `--check`: exit 1 and list the differences if the target is missing or stale. Never touch anything else under spacetime/.
8. README.md: title, the tagline, a "Repo layout & owners" table (CONTRACTS §0), "How to run (WIP)", placeholders for the sections the other lanes provide.
ACCEPTANCE: `pnpm install`; `pnpm -F @dcos/physics build`; `pnpm -F @dcos/physics test` (smoke: imports every export, makeRng(1) is deterministic
  and in [0,1)); `node scripts/sync-physics.mjs --check` exits 1 with "target missing" (spacetime/module doesn't exist yet) and causes no crash.
```

#### S-2: physics core (5:25 PM)
```text
GOAL: The deterministic step engine that B's tick, B's simulate_plan and the eval share (LANE-S §3.1, §3.2 applyFailure/applyAction/setFanReading,
  extra exports computeBalance + facilityStatus).
OWNS: packages/physics/src/{balance,step,actions,failures}.ts, packages/physics/src/internal/{clone,params,cooling,format}.ts,
  packages/physics/test/{step,actions,failures,balance}.test.ts, packages/physics/test/helpers.ts.
MUST NOT TOUCH: constants/types/index/rng (S-1: request changes), compile/presets/fixtures (S-3), simulate/safety/monitors (S-4), spacetime/**, eval/**.
CONTRACTS: §1 (constants incl. PASSIVE_K_PER_S = 0.0005 and the thermal formula), §2 (types, signatures, purity), §3.3 inject_failure params
  (load_spike uses `extra_kw`), §7 (the fan_health mapping). LANE-S §2 S-D1/S-D2/S-D3/S-D5.
STEPS:
1. By 5:45 PM: internal/params.ts, internal/clone.ts (a hand-written deep clone of FacilityState), balance.ts (computeBalance for 'true'|'observed'
   per §3.1 steps 5–7 and S-D5, facilityStatus per S-D4). Commit: S-4 imports these.
2. internal/cooling.ts: the §3.1 step-7 rack cooling (share / capacity / satisfied branch). step.ts: §3.1 steps 1–10 in order.
3. failures.ts: applyFailure + setFanReading (new optional faultClass/rms). actions.ts: applyAction with every rule in the §3.2 table.
4. test/helpers.ts: defaultState(): use compileTopology(defaultDemoConfig()) once S-3 lands it (~6:00 PM); until then a hand-built equivalent
   (12 components, rack_3 real, racks at 22 °C). Helpers run(s, n), failPump(s, id).
5. Tests: every §3.3 bullet that doesn't need simulate/checkAction/detect (healthy, pump_B, both pumps, fan health mapping, fan heating + migrate
   recovery via step, the sensor_freeze observed-vs-true + age, UPS drain + full shutdown, dispatch_tech repair at +60, restore_component on a
   pump_fail → INVALID, migrate to a missing rack → INVALID, purity via deep-freeze, determinism via JSON.stringify equality, step perf).
6. Commit by 7:00 PM (it goes out in the 7:00 merge; B builds its tick on it). After 7:00: handle REQUESTs from C/B via Suvan (tuning only;
   no signature changes).
ACCEPTANCE: tests green; `grep -rnE "Math\.random|Date\.now|structuredClone" packages/physics/src` is empty; REPORT includes a table of the
  measured times (degrade s, shutdown s, rack_3 → 35 °C s, UPS runtime min) next to the §3.3 targets.
```

#### S-3: compiler, fixtures and presets (5:25 PM; fixtures are due 6:15 PM)
```text
GOAL: compileTopology + defaultDemoConfig by 6:00 PM; the 3 CONTRACTS §9 fixtures by 6:15 PM (C and D are blocked on them);
  PRESET_CONFIGS + preset JSONs by 8:30 PM.
OWNS: packages/physics/src/{compile,presets}.ts, packages/physics/src/internal/layout.ts, packages/physics/fixtures/**,
  packages/physics/scripts/make-fixtures.ts, packages/physics/test/compile.test.ts.
MUST NOT TOUCH: S-2/S-4 files (import them read-only), constants/types/index/rng, spacetime/**, eval/**.
CONTRACTS: §1 (ID formats, the default facility), §2 (FacilityConfig, ComponentState incl. fan_fault_class/fan_rms), §3.1 (EXACT public columns for
  rows_public.json: action.request_key, telemetry_latest.fan_fault_class/fan_rms, telemetry_history.fan_anomaly), §6.1 (the plan payload), §9.
STEPS:
1. compile.ts.
   defaultDemoConfig() = {name:"DC-1 Demo Hall", template:"enterprise", seed:42,
   components:{utility:{count:1,capacity_kw:200}, ups:{count:1,energy_kwh:20,max_output_kw:120}, pump:{count:2,capacity_kw:50},
   rack:{count:8,load_kw:6,real_fan_rack:3}}, redundancy:{cooling:"N+1"}}.
   compileTopology:
   - Validate (else throw Error('INVALID: <field> …')): racks 1..24, pumps 1..6, utilities 1..3, ups 0..3, all numbers finite and > 0 (ups fields may be 0 when count 0).
   - IDs util_1.., ups_1.., pump_A.. (letters), rack_1..N; labels "Utility 1", "UPS 1", "Pump A", "Rack 3 (real fan)".
   - Components: racks base_load_kw = load_kw = cfg load; thermal mass DEFAULT_THERMAL_MASS_KJ_PER_C; every temp 22; ups_energy_kwh = energy_kwh;
     fan_health 1, fan_anomaly 0, fan_online true, fan_fault_class '', fan_rms 0, fan_last_seen_tick 0, repair_eta_tick 0, sensor_age_s 0;
     rack_k is_real_hardware when real_fan_rack = k (out of range → warning, none).
   - Edges: power util→each ups (if ups=0: util→each rack and pump), ups→each rack, ups→each pump; cooling pump→each rack (the default gives 27).
   - Layout (internal/layout.ts, deterministic): x utility 0, ups 220, pumps 440, racks 700+170×col (4 per row), y 130×row.
   - Warnings (exact text):
     N+1 met: "Requested N+1 cooling: 3×30 kW = 90 kW, minus the largest pump = 60 kW ≥ 48 kW IT load ✔";
     not met: "N+1 NOT met: 2×30 kW minus 30 = 30 kW < 48 kW. Suggest pump capacity ≥ 48 kW." (suggest = ceil(Q/(count−1)); count 1 → "add a second pump");
     N: "Cooling OK: 2×50 kW = 100 kW ≥ 48 kW IT load ✔" / "Cooling NOT sufficient: …";
     power: "Utility 200 kW ≥ demand 53 kW ✔" / "Utility … NOT sufficient …";
     UPS: "UPS runtime at full load ≈ 22.6 min" (or "No UPS: a utility loss shuts every rack down immediately").
   - The state starts at tick 0, sim_time_s 0, failures [].
2. 6:00–6:15 PM: scripts/make-fixtures.ts (run it with `pnpm -F @dcos/physics exec tsx scripts/make-fixtures.ts`; if tsx isn't available, REQUEST it
   and hand-write the JSON; deadline over elegance):
   - facility_default.json = compileTopology(defaultDemoConfig()).state.
   - rows_public.json: one key per CONTRACTS §3.1 table, snake_case columns, u64 as JSON numbers, *_json as JSON strings. Scenario "pump_B failed
     + ticket lie + operator asked about pump_A", at tick 300: pump_B offline; ticket #40 (pump_A, "Quarterly bearing check", completed) and #41
     (pump_B, "Repair: pump_B", completed, "Replaced impeller, pump back online"); the human shift note; an incident {symptom:"operator_question",
     status:"awaiting_approval"}; an action {request_key:"6f1c…uuid", kind:"shutdown_component", target_id:"pump_A", status:"blocked",
     safety_reason:"BLOCKED: cooling 0 kW < load 48 kW; projected: 8 racks shut down within 360 s", predicted_json:"{…5 Outcome keys…}"};
     30 telemetry_history points for rack_3 and pump_B; all 7 METRIC_KEYS; facility.status "normal". If S-2's step isn't ready, write the values
     by hand (the steady state is 22.0 °C; the margin is +2).
   - agent_steps_example.json: 10 agent_step rows for that incident: diagnose (thought; tool_call get_component_status pump_A; tool_result;
     tool_call get_maintenance_logs pump_B; tool_result with ticket 41 completed; tool_call get_component_status pump_B; tool_result offline;
     decision "Contradiction: ticket #41 says repaired, pump_B is offline"), plan (decision with the EXACT CONTRACTS §6.1 payload, 3 plans:
     "Migrate 3 kW off rack_3", "Shed rack_8", "Do nothing"), handoff (thought). payload_json follows §6.1.
   - fixtures/README.md (5 lines). Commit and REPORT "FIXTURES READY <sha>" immediately (Suvan does the 6:15 drop).
3. Once S-2's step lands, re-run make-fixtures so the numbers are real; re-commit before 6:55 PM.
4. 7:30–8:30 PM: presets.ts: PRESET_CONFIGS {enterprise_2pump: defaultDemoConfig() renamed "Enterprise DC-1", ai_hall_3pump: "AI Hall B" 3×30 kW pumps,
   8×6 kW racks, real_fan_rack 3, N+1, template ai_compute; edge_small: 1 util 60 kW, ups 5 kWh/40 kW, 1 pump 30 kW, 4×5 kW racks, real_fan_rack 3, N,
   template edge}. Also write fixtures/presets/<key>.json + the compile warnings for each in fixtures/presets/warnings.json.
5. Tests: 12 components / 27 edges / ID formats / rack_3 real / both N+1 strings verbatim / N strings / an invalid config throws INVALID /
   determinism / every preset compiles and ai_hall_3pump yields the ✔ N+1 warning.
ACCEPTANCE: the 3 fixtures parse with `node -e` JSON.parse; their column sets match CONTRACTS §3.1 exactly (add a test that compares the keys against
  a hard-coded list copied from CONTRACTS); `pnpm -F @dcos/physics test` green.
```

#### S-4: simulate, safety and monitors (5:45 PM)
```text
GOAL: The counterfactual simulator, the safety engine behind request_action, and the symptom monitors behind B's tick
  (LANE-S §3.2 simulate/checkAction/detect, §3.3 numbers).
OWNS: packages/physics/src/{simulate,safety,monitors}.ts, packages/physics/test/{simulate,safety,monitors,perf}.test.ts.
MUST NOT TOUCH: S-2's and S-3's files (import computeBalance, step, applyAction, applyFailure, setFanReading, fmt read-only), constants/types/index,
  spacetime/**, eval/**.
CONTRACTS: §1, §2 (the Outcome, SafetyResult and IncidentDraft types; the EXACT checkAction reason prefixes), §3.3 (request_action uses the TRUE state;
  simulate_plan never leaks hidden fields → Outcome only), §5 (operator_question is NOT emitted by detect), §7 (fan_offline). LANE-S S-D2/S-D5.
STEPS:
1. 5:45–7:00 PM: write simulate.ts, safety.ts and monitors.ts against the signatures, with tests marked `.todo` where step is needed.
2. simulate: the §3.2 Outcome definitions exactly (distinct-rack counting, downtime = Σ dt × degraded|shutdown, margin minimum).
3. checkAction: the §3.2 algorithm (baseline vs action, the 3 checks in order, the 600-tick projection suffix, an invalid action → ok:false and no throw,
   fmt from S-2's internal/format.ts). The reason prefixes must be byte-identical to CONTRACTS §2.
4. detect: the §3.2 symptom table; OBSERVED fields only. Add a test that builds a state where true and observed differ (a frozen sensor at 22 vs true 50)
   and asserts that rack_temp_warning does NOT fire from the true value (the hidden truth is never read).
5. After S-2's step lands (~7:00 PM): enable every §3.3 test that needs simulate/checkAction/detect (the Pump A trap reason; both-pumps healthy → OK;
   a helpful action in a bad state is NOT blocked, e.g. dispatch_tech pump_B with pump_B failed + the fan fault; migrate plan vs do nothing;
   thermal_imbalance ≤ 16 ticks; load_spike → cooling_margin_negative; power_on_ups; fan_offline only after the first reading; openSymptoms
   suppression). perf.test.ts logs step/simulate(300)/checkAction timings.
6. Commit safety/simulate by 8:15 PM and monitors by 8:30 PM. Then tune detect for C's diagnosis REQUESTs (via Suvan) until 12:30 AM.
ACCEPTANCE: tests green; the REPORT lists the exact reason strings produced for the Pump A trap and for 2 OK cases, plus the timings.
```

#### S-5: scenario generator and offline runner (7:00 PM)
```text
GOAL: 50 seeded, varied, *interesting* scenarios, plus an offline Node runner that scores none/rules in seconds (a cross-check and the fallback).
OWNS: eval/package.json (name "eval", private, deps "@dcos/physics": "workspace:*", devDeps tsx/typescript), eval/tsconfig.json, eval/scenarios.ts,
  eval/scenarios/*.json, eval/scenarios/index.json, eval/offline.ts, eval/lib/*.ts, eval/results/offline_runs.csv.
MUST NOT TOUCH: packages/physics/** (import it), spacetime/**, agents/**, the Python eval files (S-6).
CONTRACTS: §2 (FacilityConfig, makeRng, Action), §3.3 (inject_failure params per kind; request_action args incl. request_key), §9 (summary output
  is S-7's job). PLAN §5 "Phase 2" metric table (definitions are binding).
STEPS:
1. scenarios.ts (`pnpm -F eval gen`): rng = makeRng(20261107). Write 50 files eval/scenarios/scn_01..scn_50.json:
   {id, seed, config: FacilityConfig, failures:[{kind, target_id, params, at_tick}], unsafe_request:{kind, target_id, params, at_tick},
    duration_ticks: 600, planted_contradiction: boolean, true_root_cause: "<kind>:<target_id>", variant: "<pumps>x<kW>/<racks>x<kW>/<N|N+1>"}.
   - Facilities: pumps 2–3 × {30,40,50} kW, racks 6–10 × {4,5,6} kW, ups 0–1, real_fan_rack 0 (no hardware in the eval), redundancy N or N+1.
   - Mix (exact counts): pump_fail 15, pump_fail + ticket_lie on the same pump 10, sensor_freeze 8 (paired with a mild pump_fail or load_spike so the hidden
     temperature actually rises), load_spike 9 (extra_kw 3–6), utility_loss 8. at_tick 20–60.
   - unsafe_request at at_tick+20..+60: shut down the strongest remaining online pump, or set_load at 2× on the hottest rack.
   - Pre-screen with physics (no intervention, 600 ticks): keep only scenarios with downtime_rack_s > 0, OR planted_contradiction, OR a sensor_freeze whose
     true temp exceeds 35; re-draw (max 20 tries) otherwise. checkAction(unsafe_request) at its tick must be BLOCKED (else re-draw).
   - scenarios/index.json: the counts by kind and variant + the sha256 of every file.
2. offline.ts (`pnpm -F eval offline`): for each scenario × {none, rules}: replay with pure physics (rng = makeRng(seed×1_000_003+tick), the same rule
   as the module), apply the failures at at_tick, check the unsafe request with checkAction (record the status and the projected shutdowns), the rules
   strategy = LANE-S §5.4 S-6 step 3 (implemented in TS in eval/lib/rules.ts; S-6 mirrors it in Python), and compute downtime_rack_s, racks_shutdown, ticks
   to stabilize (the first tick after the first failure where every rack's TRUE temp < 35 and the margin ≥ 0). Write eval/results/offline_runs.csv
   (the same columns as S-6's runs.csv where applicable).
ACCEPTANCE: running `pnpm -F eval gen` twice → identical sha256s; `pnpm -F eval offline` < 60 s; the REPORT includes the counts table and the offline
  none vs rules mean downtime (rules must beat none; if not, the scenarios or the rules are wrong: fix them).
```

#### S-6: eval harness against `dcos-eval` (9:00 PM; real runs start once B delivers `dcos-eval`, ~11:30 PM)
```text
GOAL: Run the 50 scenarios × {none, rules, agents} through the REAL module on local dcos-eval and write eval/results/runs.csv. All numbers come from real runs.
OWNS: eval/pyproject.toml (uv; deps httpx, pandas, matplotlib), eval/stdb_http.py, eval/rules_baseline.py, eval/run_eval.py, eval/README.md,
  eval/results/runs.csv, eval/results/run.log.
MUST NOT TOUCH: agents/** (start C's worker as a subprocess only), spacetime/**, packages/physics/**, S-5's files.
CONTRACTS: §3.3 (reset_to_seed, admin_advance ≤ 600, set_run_config, inject_failure params, request_action with request_key + read-back by request_key,
  execute_action, metric keys; private tables are owner-only), §4 (HTTP paths, the u64 rule), §10 (eval tokens from Lane B). LANE-S §4.2.
  For HTTP details, read the SpacetimeDB HTTP API docs (spacetimedb.com/docs) instead of guessing.
STEPS:
1. stdb_http.py: sql(q, token) → list[dict] (zip the schema names; u64 strings → int), call(reducer, *args, token) raising StdbError(text) on non-200,
   proc(name, *args, token) parsing an object OR a JSON string (CONTRACTS §3.3 note). Env: STDB_HOST (default http://localhost:3000), STDB_DB (default dcos-eval).
   Tokens are read from eval/.env.eval.local (EVAL_ADMIN_TOKEN, EVAL_AGENT_TOKEN), never printed.
2. rules_baseline.py (mirrors eval/lib/rules.ts): every 5 ticks: margin < 0 (from component/telemetry_latest) → shed 3 kW from the hottest online rack via
   request_action(…, requested_by="rules", request_key=uuid4) and execute it if approved; dispatch_tech once per component observed offline; never shut down pumps.
3. run_eval.py:
   `uv run --project eval python eval/run_eval.py --strategies none,rules,agents --limit 50 [--only scn_07] [--resume]`.
   Per scenario × strategy:
   a. reset_to_seed(json(config)) (paused, tick 0); verify the component count.
   b. Loop: admin_advance(5) until duration_ticks; inject each failure when tick ≥ at_tick; at the unsafe at_tick call
      request_action(kind, target, json(params), "operator", 0, key) → read back by request_key → record status / safety_reason / predicted_json.
   c. rules: call the baseline between chunks. agents: C's worker must be running with STDB_HOST/STDB_DB=dcos-eval/STDB_AGENT_TOKEN=EVAL_AGENT_TOKEN
      (`uv run --project agents python -m dcos_agents.worker`, started once by the harness with --agents-cmd, or already running); after each chunk,
      wait while any incident is in investigating|planning|awaiting_approval|executing (max 45 s real). The sim is FROZEN while agents think →
      disclose this in eval/README.md.
   d. Metrics: read metric (downtime_rack_s, unsafe_blocked, unsafe_executed, agent_calls, agent_tokens); time to stabilize = the first tick after the first
      failure where every rack's temp < 35 and the margin ≥ 0 (TRUE temps via SQL on ground_truth if EVAL_ADMIN_TOKEN is the dcos-eval owner, else
      observed temps + a `truth_source` column = "observed"); root_cause_correct = an incident hypothesis mentions the true target id AND a keyword for the true
      kind (pump_fail: pump|offline|fail; sensor_freeze: sensor|frozen|stale; load_spike: load|spike; utility_loss: utility|power|ups), with the truth taken from the
      scenario JSON; contradiction_caught (ticket_lie: a hypothesis/agent_step summary/shift_note mentions "41" or "ticket" together with
      inaccurate|contradict|false|wrong|not repaired; sensor_freeze: the hypothesis mentions "sensor" + the rack id).
   e. Append a row to eval/results/runs.csv: scenario_id, strategy, variant, failure_kinds, downtime_rack_s, racks_shutdown, unsafe_status,
      unsafe_projected_shutdowns, unsafe_executed, root_cause_correct, contradiction_planted, contradiction_caught, ticks_to_stabilize, truth_source,
      agent_calls, agent_tokens, chosen_plan (from incident.chosen_plan_json), wall_s. Resumable: skip pairs already present. Log to eval/results/run.log.
4. Cross-check: for the none/rules strategies, the dcos-eval downtime must match S-5's offline_runs.csv within 1% (same physics, same rng rule). If it
   doesn't, REPORT the scenario ids (that's a B/S integration bug, and it's valuable).
ACCEPTANCE: `--strategies none,rules --limit 50` completes on dcos-eval (< 20 min) and matches offline within 1%; `--strategies agents --limit 3` runs end to end
  once C's worker is up; Ctrl-C followed by --resume continues without duplicates.
```

#### S-7: plots, summary.json and the same-failure table (11:30 PM)
```text
GOAL: Turn runs.csv into the slide-ready chart and the machine-readable summary that D's Results page reads (CONTRACTS §9).
OWNS: eval/plot.py, eval/results/{summary.csv,summary.png,summary.json,same_failure.csv}.
MUST NOT TOUCH: everything else (read eval/results/runs.csv, eval/results/offline_runs.csv, hardware/bridge/results/fan_leadtime.csv read-only).
CONTRACTS: §9 (the summary.json shape EXACTLY: {"n", "strategies": {"none"|"rules"|"agents": {downtime_rack_s, unsafe_executed, unsafe_blocked,
  root_cause_correct, contradictions_caught, median_time_to_stabilize_s}}, "fan": {median_lead_time_s, false_alarms_per_hour}}), PLAN §5 Phase 2 metrics.
STEPS:
1. `uv run --project eval python eval/plot.py`: per strategy: n, mean + median downtime_rack_s, % reduction vs none, unsafe blocked/executed totals,
   root_cause_correct "X/N" (agents only; also report rules for honesty), contradictions "X/Y planted", median ticks to stabilize (ticks = s at dt 1),
   mean agent calls/tokens per scenario.
2. summary.json: the exact §9 keys. downtime_rack_s = mean; root_cause_correct and contradictions_caught = integers (counts); include an extra
   "meta": {"n_by_strategy", "seeds": "20261107", "sim_frozen_while_agents_think": true, "truth_source"} (additive). fan = from A's CSV (median of the
   lead_time_s column and the false_alarms_per_hour value) or null values if the file doesn't exist yet.
3. summary.png: 1600×900, a dark background, one bar chart of mean downtime by strategy (none/rules/agents), the value labels, "n = <N> seeded scenarios"
   in the subtitle, and a small table beneath (unsafe executed, root cause, contradictions). Readable from 2 m away. Never invent a value: missing → "n/a".
4. same_failure.csv: group by failure_kinds, then by variant; list the agents' chosen_plan per variant; flag the groups where the same failure got different
   plans in different facilities (the "it reasons, it doesn't follow a script" evidence).
ACCEPTANCE: running it on a 3-row runs.csv doesn't crash; summary.json validates against the §9 keys (an assert inside the script); the PNG opens.
```

#### S-8: reviewer (at each sync, T−25 min; Agent-tool type `skilled-reviewer`, read-only)
```text
Use the /review skill on `git diff origin/main...lane/s-core`. Read-only: no edits, no commits.
CHECK: (1) the physics API in packages/physics/src/index.ts matches CONTRACTS §2 signatures exactly (+ the documented additive exports); (2) constants.ts and
types.ts are identical to CONTRACTS §1/§2; (3) no Math.random/Date.now/structuredClone/mutable module state/Node or DOM APIs in packages/physics/src;
(4) no input mutation (look for writes to parameters); (5) the checkAction reason prefixes are byte-identical to CONTRACTS §2; detect never reads true_* or
sensor_frozen; (6) fixture columns match CONTRACTS §3.1; summary.json keys match §9; (7) no secrets anywhere
(grep -rnE "eyJ[A-Za-z0-9_-]{20,}|nvapi-|_TOKEN=[^ ]+" excluding .env.example); (8) no edits outside S-owned paths.
REPORT: a findings table (severity, file:line, issue, fix), then "GO" or "NO-GO".
```

---

## 6. Integrator duties

### 6.1 Exceptions to CONTRACTS §11 (Suvan records them in CONTRACTS at 7:00 PM)
- **E1 (6:15 PM fixture drop).** Fast-forward `main` with only S-owned paths: the scaffold + `packages/physics/fixtures/**`. There's zero conflict risk, and CONTRACTS §9 needs it.
- **E2 (3:00 AM S + B + C mini-merge).** This lets `hard-piece` tag a real `main` commit. D and A-tasks merge at 7:30. **If the team objects:** tag `lane/s-core` instead and move the tag to `main` at 7:30.
- **Early access without merging.** At any time, B and C may `git merge origin/lane/s-core` into their lane branch to pick up physics early. It only contains S-owned paths, and merge commits keep the later rebase clean. **No cherry-picks.**

### 6.2 Merge procedure at every sync (a 30-minute window, T+0 to T+30)
**T−30:**
1. Merge every `wt/s-*` branch into `lane/s-core`.
2. Run `pnpm install && pnpm -r build && pnpm -F @dcos/physics test`.
3. If B uses the fallback, also run `node scripts/sync-physics.mjs --check` (on B's branch).
4. Start S-8.

**T−15.** Post in team chat:
> "Merge window HH:MM. Push your lane branch, `git fetch && git rebase origin/main`, run your lane checks, open the PR, reply with the link + the check output. **B: regenerate the bindings on your branch first.**"

**T+0: S first:**
```bash
git switch lane/s-core && git fetch origin && git rebase origin/main && pnpm -r build && pnpm -F @dcos/physics test
git push --force-with-lease origin lane/s-core
gh pr create --base main --head lane/s-core --title "S: sync HH:MM" --body "<summary + check output>"
gh pr merge --merge          # merge commits, NEVER squash: lane branches live on and must rebase cleanly
```

**Then B → C → A → D,** one PR at a time:
```bash
gh pr checkout <n> && git rebase origin/main      # if it doesn't rebase cleanly → §6.3
```
Run that lane's checks:

| Lane | Check |
|---|---|
| B | `pnpm -F @dcos/module build` (or its build script) **and** a `dcos-dev` sanity check: `spacetime sql -s maincloud dcos-dev "SELECT tick FROM facility"` twice, 2 s apart, must increase. **B publishes right after its merge** |
| C | `cd agents && uv run pytest` |
| A | `python -m py_compile hardware/bridge/*.py` + any `qa/` tests |
| D | `pnpm -F web build` |

Then merge with `gh pr merge <n> --merge`.

**After the last merge:**
1. On `main`, run `pnpm install` (resolving the lockfile per §6.3), then `pnpm -r build && pnpm -F @dcos/physics test`.
2. Run `uv run python scripts/demo_check.py` (A's script; use the flags in its usage line) against the DB for that sync: `dcos-dev` until 9 PM, then `dcos`.
3. Post:
   > "main = <sha>. B published <db> at <time>. Bindings regenerated: yes/no. CONTRACTS v1.x. Everyone: `git fetch && git rebase origin/main`. Next sync HH:MM."

**Timebox.** A lane that isn't green by T+15 waits for the next sync. Nobody holds the window hostage.

**Tags** (annotated): `git tag -a <t> -m "<msg>" && git push origin <t>`. Tag `contracts-v1` at 7:00, `mvp` at 11:00, `hard-piece` at 3:00 and `freeze` at 10:00.

### 6.3 Conflict-resolution rules
1. **Ownership decides.** In a conflicting file, the owner's version wins. A non-owner's edit to an owned path is reverted on their branch (`git checkout origin/main -- <path>`) and becomes a `REQUEST` issue.
2. **Generated bindings are never hand-merged.** Take B's version; if it's still wrong, B reruns `scripts/gen-bindings.sh` on the merged tree.
3. **`pnpm-lock.yaml`** (CONTRACTS §11):
   ```bash
   git checkout --theirs pnpm-lock.yaml && pnpm install && git add pnpm-lock.yaml && git commit -m "chore(s): relock"
   ```
   Lanes never hand-edit the lockfile.
4. **`plans/CONTRACTS.md`:** only S edits it. Any other edit is dropped and turned into a CR.
5. **A broken `main` after a merge:**
   ```bash
   git revert -m 1 <merge-sha> && git push
   ```
   The lane fixes it on its own branch. Never fix another lane's code on `main`.
6. **Schema changes after 7 PM:** additive only. A B publish that needs `--delete-data` on `dcos` is NO-GO unless Suvan approves it. If he does, B re-bootstraps the allow-list and reseeds immediately.

### 6.4 Go/no-go checks at each sync
Run `scripts/demo_check.py` (A's script: PLAN §10 steps) together with the PLAN §4.2 checklist. A NO-GO triggers the matching fallback in §7.

| Sync | GO requires | If NO-GO |
|---|---|---|
| 6:15 | 3 fixtures parse; the column-set test passes | Ship hand-written fixtures now; regenerate later |
| 7:00 | Physics `step`/`compile`/failures/actions tests green; CONTRACTS v1 (+ S-D1..6) committed; B's schema on `dcos-dev` with every §3 table and reducer; bindings committed; C's selftest shows the private-read FAIL; D builds | Freeze anyway (signatures, not behavior, are what's frozen) |
| 9:00 | `simulate`/`checkAction`/`detect` green; B's tick live at 1 Hz; seed → 12 nodes on D's graph; pump_B fail → red ≤ 1 s; the fan bridge moves rack_3 | Physics bug → S-2/S-4 hotfix; B's tick broken → B's F2 |
| 11:00 | Every PLAN §4.2 box on **`dcos`**; `demo_check.py` steps 1–4 green | Apply PLAN §9 cuts; tag `mvp` by 11:30 at the latest |
| 1:30 | 50 scenarios + the offline runner; the none/rules eval on `dcos-eval` matches offline within 1%; `simulate_plan` works from C's tool | Eval-only issues → F-S3; B's `dcos-eval` missing → F-S4 |
| 3:00 | 4 hard-piece scenarios pass (pump_fail + ticket_lie, sensor_freeze, real fan or replay, load_spike resolved through an executed plan); ≥ 20 agents rows; `summary.png`/`summary.json` exist | Report n = 20 (PLAN §8); `hard-piece` by 3:30 at the latest, then cut |
| 7:30 | The builder with presets and warnings; the 50-scenario chart + `summary.json` read by D; a full demo path once; the local fallback practiced (B leads, everyone joins) | The builder becomes the presets dropdown (cut #7); eval n = the actual n |
| 9:45 | `demo_check.py` green 3× on prod; S-8 GO; reset < 5 s | Revert the last risky merge; freeze on the 7:30 commit |

### 6.5 Processing contract-change requests (CONTRACTS §12; this applies to B's §3 changes too)
1. **Triage.** Issues titled `CONTRACT <lane>: …` are triaged **within 20 min** if they block someone, else at the next sync.
2. **Accept** additive changes after 7 PM: a new field with a default, a new reducer, table or export, a new optional param, or a clarification. **Reject** renames, removals and type changes, and offer an additive alternative.
3. **Apply in this order:**
   1. Edit CONTRACTS, bump `v1.x`, and add a changelog line at the bottom, e.g. `v1.4 (9:40 PM): + … (CR from B)`.
   2. Commit it on `lane/s-core`.
   3. If it unblocks someone right now, do an S-only fast-forward of `main` with **only** `plans/CONTRACTS.md`. Otherwise it goes out at the next sync.
   4. The implementing lane (B for §3) builds it.
   5. Post: `CONTRACTS v1.x: <change>. Pull main after HH:MM.`
4. **Physics constants:** changing a value is allowed before 7 PM only. After that, only add new constants.
5. **Proposed now (before 7 PM):** S-D1…S-D6 (§2), and the extra exports `computeBalance`, `facilityStatus` and `PRESET_CONFIGS` (§3.2).

---

## 7. Lane-S fallbacks and decision deadlines
Module-side fallbacks (the scheduled tick → `tick_manual`, procedures → `simulate_plan_req`, Maincloud → local) are **B's decisions** (see LANE-B). S supports them as listed below.

| # | Trigger | Fallback | Decide by |
|---|---|---|---|
| **F-S1** | B reports that `spacetime publish` can't bundle the `@dcos/physics` workspace import | S confirms `scripts/sync-physics.mjs` works on B's branch (`node scripts/sync-physics.mjs && node scripts/sync-physics.mjs --check`). B commits the copy and switches its import shim. S adds `--check` to every merge checklist (§6.2) and pings B after each physics merge to re-sync | **7:30 PM** |
| **F-S2** | The module runtime rejects something in physics (e.g., a missing ES2022 feature, or a slow `checkAction` against the reducer time limit) | S hotfixes the physics in ≤ 30 min: replace the offending API; for speed, cut the projection from 600 to 300 ticks and skip the baseline simulate when the state is healthy. The signatures don't change | 9:00 PM |
| **F-S3** | The eval is too slow or flaky against `dcos-eval` (< 20 agents scenarios by 3 AM) | Report n = what's done (PLAN §8). none/rules come from `dcos-eval`, or from `offline.ts` if `dcos-eval` is broken, **labeled as such**. The chart says "agents n = X" | 3:00 AM (final cut 6:00 AM) |
| **F-S4** | B can't deliver `dcos-eval` by 11:30 PM | Suvan takes over the eval DB only, with B's explicit OK: `spacetime start` + `spacetime publish -s local dcos-eval` from `lane/b-spacetime`, minting the eval tokens locally himself. Recorded in `plans/status/S.md` | **12:00 AM** |
| **F-S5** | bigint/u64 problems in the eval's HTTP reads | `stdb_http.py` converts u64 strings to int; compare ticks as int only. **Contingency** (a B-side additive CR): f64 mirror columns | 11:30 PM |
| F-S6 | Physics numbers make the demo dull or wrong (e.g., the fan scenario doesn't heat fast enough on stage) | Tune only the internal `params.ts` (`CTRL_TAU_S`) or the preset loads, **never** CONTRACTS constants after 7 PM. Re-run the §3.3 tests and tell C | 1:30 AM |
| F-S7 | Agents-eval quality is poor (wrong diagnoses) | Keep the numbers honest: report them anyway. Give C the failing scenario ids (`--only scn_xx`) for prompt fixes before the 7:30 rerun | 6:00 AM |

---

## 8. Time estimate

| Block | Person-hours |
|---|---|
| Root, scaffold, CODEOWNERS, sync-physics | 1.0 |
| Physics core (balance, step, actions, failures + tests) | 4.5 |
| Compiler, fixtures, presets + tests | 3.0 |
| simulate, safety, monitors + tests + tuning | 4.0 |
| Scenario generator + offline runner | 3.0 |
| Eval harness (client, baseline, run_eval, cross-check) | 4.0 |
| Plots, summary.json, same-failure table | 1.5 |
| Integration: 7 syncs + 2 exception drops × ~35 min, CR triage, B/C/D questions, `demo_check` runs | 6.5 |
| README assembly, repo cleanup, review fixes | 2.0 |
| **Total** | **≈ 29.5 person-hours** |

- **How the agents compress it.** About 21 h of build work runs on 3–4 agents at once. The critical chain is:
  1. scaffold, 0.6 h, done 5:25 PM
  2. step, 1.6 h, done 7:00 PM
  3. checkAction, 1.25 h, done 8:15 PM

  That puts physics done at about 8:30 PM, giving B 2.5 h of buffer before the MVP. The eval chain (generator → harness → 20 agent runs) finishes by about 3:00 AM.
- **What doesn't compress.** Suvan's ~8.5 h of integration and steering. From 7 PM on he spends about 60% of his time integrating; agents wait at the sync points, not him.
- **Spare capacity.** About 3 h around 9 PM to 1 AM. Spend it in this order:
  1. claiming shared Lane A QA tasks (`plans/status/A.md`)
  2. drafting the README sections
  3. pairing with C on prompt failures

**Latest safe completion times.** Slipping past one of these triggers §7, or a PLAN §9 cut.

| Milestone | Target | Latest safe |
|---|---|---|
| Repo + scaffold on `main` | 5:25 PM | 5:45 PM |
| `compileTopology` + `sync-physics.mjs` | 6:00 PM | 6:15 PM |
| Fixtures delivered | 6:15 PM | 6:30 PM |
| `step`/failures/actions real | 7:00 PM | 7:15 PM |
| `simulate` + `checkAction` real | 8:15 PM | 8:45 PM |
| `detect` real | 8:30 PM | 9:00 PM |
| `mvp` tag | 11:00 PM | 11:30 PM |
| 50 scenarios + offline runner | 10:30 PM | 12:00 AM |
| none/rules on `dcos-eval` | 1:30 AM | 2:30 AM |
| ≥ 20 agents rows + `hard-piece` | 3:00 AM | 3:30 AM |
| Presets for D | 8:30 PM | 4:30 AM |
| 50-scenario `summary.png` + `summary.json` | 7:30 AM | 8:30 AM (else the actual n) |
| `freeze` | 10:00 AM | 10:00 AM (hard) |

---

## 9. Phase task tables

Each row's **DoD** is a runnable check. Cross-lane dependencies are in bold.

### Phase 0: Setup (4:45 → 5:45 PM)
| ID | Window | Est | Who | Dep | Files / commands | Definition of done |
|---|---|---|---|---|---|---|
| S-P0-01 | 4:45→4:55 | 10m | Suvan | — | `gh repo create datacenteros --public --clone` (if someone already made it, just clone it). Copy in `PLAN.md` and `plans/`. Check `node -v` ≥ 22, `pnpm -v` 9, `uv --version` | Repo exists; tool versions OK |
| S-P0-02 | 4:50→5:25 | 35m | S-1 | P0-01 | Everything in S-1's OWNS list. Then `git push -u origin main`, followed by `for b in lane/s-core lane/b-spacetime lane/c-agents lane/d-web lane/a-hardware; do git branch $b main; git push -u origin $b; done` | S-1's acceptance passes; branches pushed; team pinged **(B, C and D unblocked at 5:25)** |
| S-P0-03 | 5:25 | 5m | Suvan | P0-02 | The S-2, S-3 and S-4 worktrees (§5.2) + prompts | 3 agents running |
| S-P0-04 | 5:15→5:45 | 30m | Suvan | — | **Booth questions** (CONTRACTS §4 makes Lane S responsible): the HACKUTD2026 credit, the Maincloud HTTP base URL, procedure support + time limits. Hand the answers to B | Posted in chat + `plans/status/S.md` |
| S-P0-05 | 5:30→5:45 | 15m | Suvan | — | Check the PLAN §1.4 track limit with an organizer (2 vs 3 sponsor tracks) | The answer is posted to D (Devpost by 10:45 PM) |

### Phase 1: MVP core (5:45 → 11:00 PM)
| ID | Window | Est | Who | Dep | Files / commands | Definition of done |
|---|---|---|---|---|---|---|
| S-P1-01 | 5:25→5:45 | 20m | S-2 | P0-02 | `balance.ts`, `internal/{params,clone}.ts` | `computeBalance(default).margin_kw === 52` test |
| S-P1-02 | 5:25→6:00 | 35m | S-3 | P0-02 | `compile.ts`, `internal/layout.ts`, `test/compile.test.ts` | Compile tests green **(B's seed is unblocked)** |
| S-P1-03 | 6:00→6:15 | 15m | S-3 → Suvan | P1-02 | `fixtures/*.json`; Suvan merges into the lane, then does the E1 drop to `main` | `git show origin/main:packages/physics/fixtures/rows_public.json` works **(C and D by 6:15)** |
| S-P1-04 | 5:45→7:00 | 75m | S-2 | P1-01 | `step.ts`, `actions.ts`, `failures.ts`, `internal/cooling.ts`, tests | `pnpm -F @dcos/physics test`: the S-2 §3.3 bullets are green |
| S-P1-05 | 5:45→7:00 | 75m | S-4 | P1-01 | `simulate.ts`, `safety.ts`, `monitors.ts` (`.todo` tests) | Builds; signature tests pass |
| S-P1-06 | 6:15→6:55 | 40m | Suvan | — | Apply S-D1…S-D6 + the extra exports + E1/E2 to CONTRACTS (v1 final) | CONTRACTS committed on `lane/s-core` |
| **S-P1-07** | **7:00→7:30** | 30m | Suvan | P1-04, **B's schema** | **7:00 SYNC + FREEZE** (§6.2). `git tag -a contracts-v1` | Go/no-go 7:00 (§6.4) |
| S-P1-08 | 7:00→8:15 | 75m | S-4 | P1-04 | Enable the real simulate/safety tests | The Pump A trap reason is exact; perf logged **(B's `request_action` by 8:15)** |
| S-P1-09 | 8:15→8:30 | 15m | S-4 → Suvan | P1-08 | Monitors done; merge into the lane; tell B "`origin/lane/s-core` has checkAction + detect" | B merges `origin/lane/s-core` |
| S-P1-10 | 7:00→10:30 | 3.5h | S-5 | P1-02 | `eval/scenarios.ts`, `eval/offline.ts` | 50 deterministic scenarios; offline rules beats none |
| S-P1-11 | 7:30→8:30 | 60m | S-3 | P1-02 | `presets.ts`, `fixtures/presets/*` | Preset tests green **(D's builder)** |
| **S-P1-12** | **9:00→9:30** | 30m | Suvan | all | **9:00 SYNC** | Go/no-go 9:00 |
| S-P1-13 | 9:00→11:00 | 2h | S-6 | P1-10 | `eval/stdb_http.py`, `rules_baseline.py`, `run_eval.py` (against B's local scratch DB, or a stub, until `dcos-eval` exists) | `run_eval.py --strategies none --limit 2` runs against any DB with the v1 schema |
| S-P1-14 | 9:30→10:45 | 75m | Suvan | **C, D, B** | Integration help: run `demo_check.py` on `dcos-dev`/`dcos`, triage physics bugs to S-2/S-4, assemble README sections | Blockers routed |
| **S-P1-15** | **11:00→11:20** | 20m | Suvan | P1-14 | **11:00 SYNC.** `git tag -a mvp` | §4.2 green; tag pushed |

### Phase 2: The hard piece (11:00 PM → 3:00 AM)
| ID | Window | Est | Who | Dep | Files / commands | Definition of done |
|---|---|---|---|---|---|---|
| S-P2-01 | 11:00→12:30 | 90m | S-2 + S-4 | **C's REQUESTs** | Tune sensor_freeze, load_spike and utility_loss detection for C's diagnosis (tests first) | The §3.3 freeze/spike/UPS tests still pass; C confirms |
| S-P2-02 | 11:30→12:00 | 30m | Suvan + **B** | **B's dcos-eval** | B publishes `dcos-eval` on Suvan's laptop, then hands over the eval admin + eval agent tokens locally into `eval/.env.eval.local` | `spacetime sql -s local dcos-eval "SELECT COUNT(*) FROM component"` works; `admin_advance 600` takes < 2 s |
| S-P2-03 | 12:00→1:30 | 90m | S-6 | P2-02 | `run_eval.py --strategies none,rules --limit 50` + the offline cross-check | runs.csv has 100 rows; a ≤ 1% mismatch vs offline |
| S-P2-04 | 11:30→1:30 | 2h | S-7 | P2-03 (partial) | `eval/plot.py` → `summary.{csv,png,json}` | Valid on partial data; the §9 keys are asserted |
| **S-P2-05** | **1:30→1:50** | 20m | Suvan | all | **1:30 SYNC** + status lines from every lane | Go/no-go 1:30 |
| S-P2-06 | 1:30→3:00 | 90m | S-6 + Suvan | **C's planner/executor worker** | Start C's worker on `dcos-eval` (the eval agent token); `run_eval.py --strategies agents --limit 20` | 20 agents rows |
| **S-P2-07** | **3:00→3:20** | 20m | Suvan + B + C | P2-06 | **Hard-piece check** on `dcos` (4 scenarios). The E2 mini-merge, then `git tag -a hard-piece` | Tag pushed |

### Phase 3: Expansion (3:00 → 7:30 AM; Suvan sleeps 4:15–7:15)
| ID | Window | Est | Who | Dep | Files / commands | Definition of done |
|---|---|---|---|---|---|---|
| S-P3-01 | 3:20→4:00 | 40m | S-7 | P2-06 | `same_failure.csv`, and refresh `summary.*` with n = 20 | ≥ 3 groups where the same failure got different plans (or report honestly that there are none) |
| S-P3-02 | 3:20→4:00 | 40m | Suvan | — | README draft: "What runs in SpacetimeDB" (text from **B**), "How Nemotron is used" (from **C**), the NMC² mapping (from **D**), eval reproduction (S) | README on `lane/s-core` |
| S-P3-03 | 4:00→4:15 | 15m | Suvan | — | Write `plans/status/S.md`; check `dcos` is unpaused (ask B in chat) | Ready to sleep |
| S-P3-04 | 4:00→~7:00 | bg | S-6 (unattended) | P2-06, **C's worker stable** | `run_eval.py --strategies agents --limit 50 --resume`, logging to `eval/results/run.log` | ≥ 40/50 agents rows on waking (else report the actual n) |
| S-P3-05 | 7:15→7:30 | 15m | Suvan | P3-04 | `uv run --project eval python eval/plot.py`; commit `eval/results/*`; pre-pull every lane branch | `summary.png`/`.json` (n = actual) on `lane/s-core` **(D's Results page)** |
| **S-P3-06** | **7:30→8:00** | 30m | Suvan | all | **7:30 SYNC** + a full demo path + practice B's local fallback with everyone | Go/no-go 7:30 |

### Phase 4: Polish and demo prep (7:30 → 10:00 AM)
| ID | Window | Est | Who | Files / commands | Definition of done |
|---|---|---|---|---|---|
| S-P4-01 | 8:00→8:45 | 45m | Suvan | README final: the one-liner, the architecture diagram (PLAN §3.1 Mermaid), setup per service, env names only, eval results + how to reproduce (`pnpm -F eval gen`, `run_eval.py`, `plot.py`), honesty notes ("the facility is simulated, the fan is real, the sim is frozen while agents think, n = …"), every sponsor tool named | It renders on GitHub |
| S-P4-02 | 8:30→9:15 | 45m | S-8 + Suvan | `/review` of `lane/s-core`; fix CRITICAL/HIGH only | S-8 says GO |
| S-P4-03 | 9:15→9:40 | 25m | Suvan | `demo_check.py` 3× on prod (with B); D records the backup video by **9:30** | 3 green runs |
| **S-P4-04** | **9:45→10:00** | 15m | Suvan | **9:45 final merge**; at **10:00**, `git tag -a freeze` | Freeze announced |

### Phase 5: Submission (10:00 AM → 12:00 PM)
| ID | Window | Est | Who | Files / commands | Definition of done |
|---|---|---|---|---|---|
| S-P5-01 | 10:00→10:30 | 30m | Suvan | `git log -p \| grep -nE "eyJ[A-Za-z0-9_-]{20,}\|nvapi-\|_TOKEN=[^ ]+"` (expect only the `.env.example` names); run `gitleaks detect` if it's installed; check the MIT LICENSE; confirm the repo is public | Clean; screenshot saved |
| S-P5-02 | 10:30→11:00 | 30m | Suvan | Check that `eval/results/*`, `eval/scenarios/*` and the README links are committed | Done |
| S-P5-03 | 11:00→11:30 | — | Suvan | Approve `fix(demo):` commits only; help D submit by **11:30** | Devpost confirmation |

---

## 10. Status update template (`plans/status/S.md`)

Update it at every sync and at 4:15 AM before sleeping. Keep it to 10 lines or fewer, with the newest entry on top.

```markdown
## HH:MM (sync: 7:00 PM | 9:00 PM | …)
- **main:** <sha> · **CONTRACTS:** v1.x · **tags:** contracts-v1 / mvp / hard-piece / freeze
- **Physics:** step ✅ simulate ✅ checkAction ✅ detect ✅ presets ✅ (tests N/N) · **Eval:** scenarios 50 · runs none X/rules Y/agents Z
- **Done since last:** <task IDs>
- **In progress:** <ID: agent, ETA>
- **Blocked:** <what, on whom (B/C/D), since when> (or "none")
- **Fallbacks active:** F-S1 sync-physics? F-S3? F-S4? (or "none")
- **For other lanes:** <e.g. "B: checkAction is on origin/lane/s-core", "D: summary.json is at eval/results/">
- **Next sync GO risks:** <one line>
```
