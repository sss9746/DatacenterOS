# LANE B: SpacetimeDB engineer (`spacetime/module/**`)

> **Read first:** `plans/README.md`, `plans/CONTRACTS.md` (§2 physics API, §3 database, §4 HTTP, §11 git), then this file.
> **CONTRACTS.md wins** over this file and over PLAN.md. If this file disagrees with CONTRACTS, follow CONTRACTS and tell Suvan.
> Written Sat Nov 7, ~4:50 PM; updated for the CONTRACTS revision (`request_key`, `open_incident`, `bump_metric`, `clear_all_failures`, fan columns, `simulate_plan` returns an object, `wt/` branches). Submission is Sun 12:00 PM. **Feature freeze is Sun 10:00 AM.**
> **Team:** 4 people: S (Suvan), B (you), C, D. Lane A (hardware, fan ML, QA) is **shared by everyone**: claim A tasks in `plans/status/A.md` first.

---

## 1. Your role in one paragraph

You build the backend. SpacetimeDB **is** the backend: there is no other server. Your TypeScript module holds the facility state, runs the 1-second physics tick (a scheduled reducer), injects failures, runs the safety engine inside `request_action`, hides the ground truth in private tables, and exposes `simulate_plan` (a procedure) for counterfactual planning. You also own **publishing** (`dcos-dev`, `dcos`, local `dcos-eval`) and **all identities and tokens**. Lane C's Python agents, the shared Lane A fan bridge and Lane D's dashboard all talk **only** to your module. If your module is down, the whole demo is down, so your top priorities are **correct, deployed and boring**.

### 1.1 What you own (only you edit these)
| Path | What |
|---|---|
| `spacetime/module/**` | The whole SpacetimeDB 2.x TypeScript module: `src/`, `package.json`, `tsconfig.json`, `scripts/` (smoke test, bootstrap, ticker fallback) |
| `scripts/gen-bindings.sh` | Regenerates `apps/web/src/module_bindings/` (the **output** folder is also written only by you, through this script) |
| `plans/status/B.md` | Your status file |

### 1.2 Never touch
- `packages/physics/**`, `eval/**`, `scripts/sync-physics.mjs`, `plans/CONTRACTS.md`, all root files (`package.json`, `pnpm-workspace.yaml`, `.env.example`, `.gitignore`, `README.md`, `CODEOWNERS`): **Lane S (Suvan)**.
- `agents/**`: Lane C. `apps/web/**` except `module_bindings/`: Lane D. `hardware/**`, `scripts/demo_check.py`, `qa/**`: Lane A (shared; you may claim an A task in `plans/status/A.md` when you have slack, but never from inside a B sub-agent).
- Need a change there? Open a GitHub issue `REQUEST <lane>: …`. Need a contract change? Issue `CONTRACT B: …` (see §9).

### 1.3 Who depends on you, and by when
| Consumer | Needs | Deadline |
|---|---|---|
| D (frontend) | Schema published on `dcos-dev` + bindings committed to `main` | **7:00 PM sync** |
| D | **Answer: does Maincloud's HTTP SQL endpoint allow browser (CORS) calls?** (CONTRACTS §11) | **7:00 PM** |
| C (agents) | Agent identity allow-listed on `dcos-dev`; `log_agent_step`, `open_incident`, `bump_metric` + read tables working | 7:30 PM |
| Lane A (shared, fan bridge) | `report_fan_reading` + bridge token | 9:00 PM |
| C, D, whoever runs the bridge | **Prod `dcos` published + all tokens handed out in team chat** | **9:00 PM** |
| C | `request_action` (6 args, with `request_key`) returning `blocked` with `BLOCKED:` reason | 10:00 PM |
| C | `simulate_plan` returning the Outcome object < 500 ms | 11:00 PM (dev), 11:30 PM (prod) |
| S (eval) | `admin_advance`, `reset_to_seed`, local `dcos-eval` + **eval admin and eval agent tokens** allow-listed there | 1:00 AM |
| D (builder page) | `build_facility` working with S's real `compileTopology` | **4:15 AM** (before you sleep) |

### 1.4 What you depend on (from Lane S)
| From S | When | What you do until then |
|---|---|---|
| `@dcos/physics` package with the frozen §2 signatures | Scaffold ~6:00 PM; real `step` ~8:00 PM; `checkAction`/`simulate` ~9:30 PM; `compileTopology` ~3:00 AM | Code against **`src/phys.ts`**, a single re-export file that points at a **local stub** (`src/physics-stub.ts`) with the exact §2 signatures. When S's package lands you change **one import line**. |
| Fixtures `packages/physics/fixtures/facility_default.json` | 6:15 PM | The stub's `compileTopology` returns that fixture (copy it into the stub as a literal if the package isn't installable yet) |
| `scripts/sync-physics.mjs` (bundling fallback) | Only if bundling fails (decision 7:30 PM) | Ask S in chat the moment `spacetime publish` errors on the physics import |
| pnpm workspace including `spacetime/*` (root `pnpm-workspace.yaml`) | Phase 0 | If it's missing, ask S; don't edit root files |

### 1.5 Sync schedule (merges to `main` are done by Suvan, order **S → B → C → A → D**)
| Time | You must have, in a PR from `lane/b-spacetime` (rebased on `origin/main`) |
|---|---|
| **7:00 PM** | **Schema freeze v1:** every §3.1/§3.2 table, `requireRole`, `allowlist_add`, `seed_demo_facility` (stub physics OK), bindings regenerated. Published to `dcos-dev`. **This is your hardest deadline: D and C code against it.** |
| **9:00 PM** | Tick + failures + fan + agent reducers live. **Prod `dcos` published, 4 tokens handed out.** |
| **11:00 PM** | MVP: `request_action`/`execute_action` correct on real physics. `simulate_plan` on dev. `git tag mvp` (S does it) |
| **1:30 AM** | `simulate_plan` on prod, `admin_advance`, `reset_to_seed`, `dcos-eval` local, `smoke.sh` green |
| **7:30 AM** | `build_facility` with real compiler (done before sleep), local-fallback rehearsal |
| **9:45 AM** | Last module publish. Additive only. Smoke green on prod |
| **10:00 AM** | **Freeze.** Only `fix(demo):` commits approved by Suvan |

### 1.6 Sleep slot: **4:30–7:30 AM (same as C and S)**
Why the same slot as C and not a split:
- C is your heaviest consumer. From 1:30 to 4:30 AM C builds execute/verify, Challenge mode and the handoff writer, which hammer `request_action`, `execute_action`, `simulate_plan` and `update_incident`. If you slept 1:30–4:30, C would be stuck on any module bug for 3 hours. Awake together, asleep together: neither of you is blocked by the other.
- From 4:30 to 7:30 only D is awake (D slept 1:30–4:30). D's builder page needs only `build_facility` (you finish it before 4:15 AM against S's real `compileTopology`), and the shared fan bridge needs only `report_fan_reading` (done at 9 PM).
- **On-call rule for 4:30–7:30:** D gets a 5-line "if the module misbehaves" card in `plans/status/B.md` (presenter "Reset demo", `set_run_config(false,1)` via the presenter panel, read `spacetime logs`). Your phone stays on loud for "prod is down" only.
- **If `build_facility` isn't green by 4:15 AM:** stay up until it is, then sleep until 7:30 at the latest. Never skip the 7:30 sync.

---

## 2. Setup runbook (Phase 0, do this first, ~45 min)

### 2.1 Install (Windows, PowerShell)
1. **Node 22+:** `node -v` must print `v22.x` or higher. If not: `winget install OpenJS.NodeJS.LTS`, then reopen the terminal.
2. **pnpm:** `corepack enable; corepack prepare pnpm@9 --activate`; check with `pnpm -v`.
3. **SpacetimeDB CLI:** follow the Windows install command on **https://spacetimedb.com/install** (it's a one-line PowerShell installer: `iwr https://windows.spacetimedb.com -useb | iex` at the time of writing; **use whatever the page says**). Reopen the terminal, then `spacetime --version` must print **2.x**.
4. **Git Bash** (comes with Git for Windows) for running `.sh` scripts: `bash scripts/gen-bindings.sh`.
5. `curl --version` works in Git Bash. `jq` is optional (scripts don't need it).

### 2.2 Accounts, credit, base URL
1. `spacetime login` (opens a browser, GitHub sign-in). Then `spacetime login show` prints your identity.
2. **Walk to the Spacetime booth now** and ask, in this order:
   - "Where do we redeem the **HACKUTD2026** credit?" Done when the credit shows in your account.
   - "What's the **Maincloud HTTP base URL** for `/v1/database/.../call` and `/sql`?" (believed `https://maincloud.spacetimedb.com`). Post the answer in team chat; S writes it into CONTRACTS §4.
   - "Does the HTTP `/sql` endpoint send **CORS** headers so a browser can call it?" Then **test it yourself** (B-P1-05b): you owe D a yes/no by **7:00 PM** (CONTRACTS §11).
   - "Is there a **reducer time limit** on Maincloud, and are **procedures** enabled for TypeScript modules in 2.x?" Write both answers in `plans/status/B.md`.
   - "Does the HTTP `call` endpoint return a procedure's return value as the body?" (CONTRACTS §4 assumes yes.)
3. **Check the official TypeScript module docs at https://spacetimedb.com/docs** (TypeScript module reference, scheduled tables, procedures, HTTP API) **for exact syntax. Don't guess.** The code sketches in this file are marked SKETCH; the docs win.

### 2.3 Scaffold and first publish
```bash
git fetch && git checkout -b lane/b-spacetime origin/main
cd spacetime
spacetime dev --template basic-ts     # if it asks for a project name/path, use "module"
# (if `spacetime dev` wants to run interactively, Ctrl+C after it scaffolds, or use `spacetime init --lang typescript module`)
cd module && pnpm install
spacetime publish -s maincloud dcos-dev      # from spacetime/module
spacetime sql -s maincloud dcos-dev "SELECT * FROM facility"
spacetime logs -s maincloud dcos-dev          # your best debugging tool all night
```
Done when the `sql` command returns without error (empty is fine).

### 2.4 The rules of a SpacetimeDB module (read twice; most bugs are one of these)
1. **Determinism.** Inside reducers and procedures use only `ctx.timestamp` for wall-clock time and `ctx.random()` **or** a `makeRng(seed)` seeded from table state for randomness. **Never** `Math.random()`, `Date.now()`, `new Date()`, `setTimeout`, `fetch`, `fs`. **No mutable module-level globals** (`let cache = …` at the top of a file): state lives in tables only. Constants are fine.
2. **A throw rolls back the whole reducer.** Every write in that call is undone. Use this: validate first, `throw new Error('INVALID: …')`, and you never leave half-written state. Error strings must start with `FORBIDDEN:`, `NOT_FOUND:` or `INVALID:` (CONTRACTS §3.3).
3. **Tables are private by default.** Add `public: true` only to the 11 tables in CONTRACTS §3.1. The 5 tables in §3.2 must **not** have it.
4. **The database owner can read private tables.** Your CLI login (the publisher) is the owner. So the agents **must** use a separate identity minted with `POST /v1/identity`. Never hand your CLI token to anyone.
5. **Anyone can call any reducer**, including anonymous clients and the scheduled `tick`. Every reducer except lifecycle ones starts with `requireRole(ctx, [...])`. `tick` checks the caller is the module itself.
6. **u64 is `bigint` in TypeScript.** `tick: 5n`, not `5`. Convert at the boundary: `Number(row.tick)` when reading into physics, `BigInt(s.tick)` when writing. **`JSON.stringify` throws on a bigint**, which rolls back the reducer: always use the `toJson()` helper (§4.1) that converts bigints.
7. **Schema changes after 7:00 PM must be additive:** new tables, new reducers, new columns **with defaults** only. Renaming or removing anything forces `spacetime publish --delete-data`, which wipes every row, including the allow-list. If that ever happens on dev: republish, run `bootstrap.sh`, call `seed_demo_facility`. **Never on prod after 9:45 AM.**
8. **Keep reducers short.** Bound every loop (`admin_advance` caps at 600 steps per call, history writes are pruned in the same tick).
9. **Regenerate bindings after every schema change** (`bash scripts/gen-bindings.sh`) and commit them in the same PR.

### 2.5 Databases and identities
| DB | Where | Purpose | Publish command (from `spacetime/module`) |
|---|---|---|---|
| `dcos-dev` | Maincloud | Your dev loop, C's and D's development | `spacetime publish -s maincloud dcos-dev` |
| `dcos` | Maincloud | Prod and the live demo | `spacetime publish -s maincloud dcos` |
| `dcos-eval` | Laptop (`spacetime start`) | S's 50-scenario eval | `spacetime publish -s local dcos-eval` |

| Role | Who uses it | How it's created | Env var |
|---|---|---|---|
| admin | You, S's `demo_check`, eval | The publisher (owner) is auto-added as admin in `init`. Also mint one **non-owner** admin token for scripts | `STDB_ADMIN_TOKEN` |
| presenter | D's demo laptop | `curl -X POST $STDB_HOST/v1/identity` | `VITE_STDB_PRESENTER_TOKEN` |
| agent | C's agents (**NON-owner**) | same | `STDB_AGENT_TOKEN` |
| bridge | A's fan bridge | same | `STDB_BRIDGE_TOKEN` |

- Each `POST /v1/identity` returns `{"identity":"<hex>","token":"<jwt>"}`. Add the hex with `allowlist_add`. **Identities are per server:** Maincloud tokens don't work on your local `spacetime start`. Mint a second set for local:
  - **`dcos-eval` (CONTRACTS §10):** a separate **eval admin** token and **eval agent** token, both allow-listed on `dcos-eval`, handed to S (eval runner) and C (agent worker pointed at eval). They are different strings from the prod tokens; label them `EVAL_` in chat so nobody mixes them up (the env var names stay `STDB_ADMIN_TOKEN` / `STDB_AGENT_TOKEN` in the eval `.env`).
  - **Offline fallback `dcos` on the laptop** (F3): presenter, agent, bridge tokens for the local server.
- **Tokens go in team chat (DM each owner) and in each person's `.env.local`. Never in git, never in `plans/status/B.md`.** Keep your own copy outside the repo (e.g. `~/dcos-tokens.txt`).
- The identity **hexes** (not tokens) can go in an untracked `spacetime/module/scripts/.identities.env` read by `bootstrap.sh`. Ask S to add `spacetime/module/scripts/.identities.env` to `.gitignore` (REQUEST S).

---

## 3. Module layout (who writes what; no two sub-agents share a file)

```
spacetime/module/
├── package.json             # B-1   deps: spacetimedb, @dcos/physics (workspace:*)
├── tsconfig.json            # B-1
├── src/
│   ├── index.ts             # B-1   entry: re-exports every reducer file (lines for B-2/B-3 files start commented out)
│   ├── tables.ts            # B-1   all 16 tables + the schema object
│   ├── auth.ts              # B-1   requireRole(), roleOf(), assertModuleCaller()
│   ├── state.ts             # B-1   loadState(), saveTruth(), writeTelemetry(), bumpMetric(), setMetric(), toJson(), ensureTickScheduled(), clearRunData()
│   ├── phys.ts              # B-1   ONE line: export * from '@dcos/physics'  (or './physics-stub')
│   ├── physics-stub.ts      # B-1   frozen §2 signatures, trivial bodies; deleted once S's package works
│   ├── reducers/
│   │   ├── lifecycle.ts     # B-1   init (owner → admin, run_config, schedule), clientConnected/Disconnected (subscribers metric)
│   │   ├── allowlist.ts     # B-1   allowlist_add
│   │   ├── seed.ts          # B-1   seed_demo_facility, build_facility
│   │   ├── tick.ts          # B-2   scheduled tick (+ shared runSteps() used by admin_advance)
│   │   ├── failures.ts      # B-2   inject_failure, clear_failure, clear_all_failures
│   │   ├── fan.ts           # B-2   report_fan_reading
│   │   ├── actions.ts       # B-2   request_action (6 args, request_key), execute_action
│   │   ├── agent.ts         # B-2   update_incident, log_agent_step, write_shift_note, open_incident, bump_metric
│   │   ├── config.ts        # B-3   set_run_config
│   │   └── admin.ts         # B-3   admin_advance, reset_to_seed (+ tick_manual fallback, commented out)
│   └── procedures/
│       └── simulate_plan.ts # B-3
└── scripts/
    ├── bootstrap.sh         # B-1   allowlist_add for presenter/agent/bridge/admin hexes
    ├── smoke.sh             # B-3   curl test for every reducer + SQL + security
    └── ticker.py            # B-3   fallback: calls tick_manual every 1 s (only if the scheduler fails)
scripts/gen-bindings.sh      # B-1   (repo root scripts/, owned by B)
```

### 3.1 Shared helper signatures (B-1 writes them; B-2 and B-3 import them and code against these exact signatures from minute one)
```ts
// src/auth.ts
export type Role = 'admin' | 'presenter' | 'agent' | 'bridge';
export function roleOf(ctx: ReducerCtx): Role | null;
export function requireRole(ctx: ReducerCtx, roles: Role[]): Role;   // throws `FORBIDDEN: <roles.join('|')> required`
export function assertModuleCaller(ctx: ReducerCtx): void;            // for tick: sender must be the module itself

// src/state.ts
export function loadState(ctx: ReducerCtx | TxCtx): FacilityState;   // facility + ground_truth.state_json + edge + failure rows
export function saveTruth(ctx: ReducerCtx, s: FacilityState): void;   // ground_truth, component.status (observed), facility tick/time/status
export function writeTelemetry(ctx: ReducerCtx, s: FacilityState, history: boolean): number; // latest (+ history & prune); returns rows written
export function writeFacility(ctx: ReducerCtx, s: FacilityState, warnings: string[]): void;  // full wipe + write (seed/build/reset)
export function clearRunData(ctx: ReducerCtx): void;                  // incidents, actions, agent_steps, failures, tickets, shift_notes, history
export function ensureTickScheduled(ctx: ReducerCtx): void;           // exactly one tick_schedule row
export function bumpMetric(ctx: ReducerCtx, key: string, delta: number): void;
export function setMetric(ctx: ReducerCtx, key: string, value: number): void;
export function toJson(v: unknown): string;                           // JSON.stringify with bigint → number
export function rngFor(s: FacilityState, salt: number): Rng;          // makeRng(seed*1_000_003 + tick*7919 + salt)
```
Randomness decision: **use `rngFor()` (a `makeRng` seeded from facility seed + tick) everywhere**: tick, `request_action`, `simulate_plan`, `admin_advance`. It's pure and deterministic, so the eval on `dcos-eval` is reproducible from the seed and matches S's Node runner. `ctx.random()` is allowed but not needed. `Math.random()` is never allowed.

### 3.2 Table sketch (SKETCH: verify `table`/`t`/`schema` syntax for 2.x in the docs)
```ts
import { schema, table, t } from 'spacetimedb/server';
export const facility = table({ name: 'facility', public: true }, {
  id: t.u32().primaryKey(), name: t.string(), template: t.string(), seed: t.u64(),
  tick: t.u64(), sim_time_s: t.f64(), status: t.string(),
});
export const telemetry_history = table({ name: 'telemetry_history', public: true }, {
  id: t.u64().primaryKey().autoInc(), component_id: t.string().index('btree'),
  tick: t.u64().index('btree'), temp_c: t.f64(), power_kw: t.f64(), cooling_kw: t.f64(),
  fan_anomaly: t.f64(),                       // CONTRACTS: default 0 (write 0 for non-fan components)
});
export const action = table({ name: 'action', public: true }, {
  id: t.u32().primaryKey().autoInc(), request_key: t.string().index('btree'), requested_by: t.string(),
  kind: t.string(), target_id: t.string(), params_json: t.string(), status: t.string(),
  safety_reason: t.string(), predicted_json: t.string(), incident_id: t.u32(), tick: t.u64(),
});
// telemetry_latest also has fan_fault_class: t.string() (default '') and fan_rms: t.f64() (default 0).
// If the 2.x builder supports column defaults (check the docs), declare them; otherwise always write them explicitly.
export const ground_truth = table({ name: 'ground_truth' /* NO public */ }, {
  component_id: t.string().primaryKey(), true_status: t.string(), true_temp_c: t.f64(),
  sensor_frozen: t.bool(), state_json: t.string(),
});
export const tick_schedule = table({ name: 'tick_schedule', scheduled: 'tick' }, {
  scheduled_id: t.u64().primaryKey().autoInc(), scheduled_at: t.scheduleAt(),
});
// … all others exactly per CONTRACTS §3.1/§3.2 …
export const spacetimedb = schema(facility, component, edge, telemetry_latest, telemetry_history, ticket,
  shift_note, incident, action, agent_step, metric, ground_truth, failure, allowlist, tick_schedule, run_config);
```
Indexes worth adding (invisible to the contract): `telemetry_history.component_id`, `telemetry_history.tick`, `incident.status`, `action.request_key` (C reads actions back by it), `action.incident_id`, `agent_step.incident_id`, `edge.from_id`, `edge.to_id`.

---

## 4. Behavior details (what "correct" means for each reducer)

### 4.1 Cross-cutting
- **Bigint boundary:** physics uses `number` for `tick`; tables use `bigint`. Convert only in `state.ts`.
- **`toJson`:** `JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? Number(x) : x)`. Use it for every `*_json` column.
- **Truncation:** `summary` ≤ 280 chars; `payload_json` ≤ 4096 bytes (cut and, if cut, append nothing; don't try to keep it valid JSON). D tolerates invalid truncated JSON (tell D).
- **Fan columns:** `writeTelemetry` always writes `fan_fault_class` (`''` for non-fan components), `fan_rms` (0) in `telemetry_latest`, and `fan_anomaly` (0 for non-fan components) in every `telemetry_history` row, taken from `ComponentState.fan_fault_class` / `fan_rms` / `fan_anomaly`.
- **`facility.status`:** `critical` if any rack's observed status is `shutdown` or margin < 0; `degraded` if any rack ≥ 35 °C or degraded; else `normal`.

### 4.2 Reducer behavior table
| Reducer | Role check | Key details / traps |
|---|---|---|
| `init` (lifecycle) | — | Insert `ctx.sender` into `allowlist` as `admin` (bootstraps the owner). Insert `run_config {id:1, paused:false, speed:1}`. Seed metrics (all 7 keys = 0). **Don't** seed the facility here (keep publish fast); call `seed_demo_facility` after publish. |
| `clientConnected` / `clientDisconnected` | — | `bumpMetric('subscribers', ±1)`, never below 0. (HTTP calls may connect+disconnect; net zero is fine.) |
| `seed_demo_facility()` | admin, presenter | `clearRunData` → `compileTopology(defaultDemoConfig())` → `writeFacility` → ticket #40 `{pump_A, "Quarterly bearing check", completed, notes "Bearing checked, OK"}` (contract says "true": it's a real ticket) → shift note author `human`, body `"Night shift: Pump B work done, all good"`, verified false → `ensureTickScheduled` → `run_config.paused=false`. |
| `build_facility(config_json)` | admin, presenter | `JSON.parse` in try/catch → `INVALID: config_json`. Basic validation (counts 1..16, capacities > 0) → `INVALID: …`. Same as seed, but no ticket #40 / human note; each compiler warning becomes a `shift_note` author `system`, verified true. |
| `tick` (scheduled) | `assertModuleCaller` | If `run_config.paused` → return. Else repeat `speed` (clamp 1..10) times: `step(s, 1, rngFor(s,0))`. After the loop: `saveTruth`, `writeTelemetry(history=true)` (insert history for **each** step's tick if speed > 1 is too heavy: insert only the final step), prune history: delete rows with `tick <= now − 120` via the tick index → `detect(s, recentHistory, openSymptoms)` → insert `incident` (status `new`, `opened_tick`, `component_ids` CSV) only for symptoms with no open incident (open = status not in `resolved`,`failed`) → metrics: `events_per_s` = rows written this call, `downtime_rack_s` += racks degraded/shutdown × steps. |
| `inject_failure(kind, target_id, params_json)` | admin, presenter | `kind` ∉ `FAILURE_KINDS` → `INVALID: kind`. Unknown `target_id` → `NOT_FOUND: component <id>`. Insert `failure` (auto id, `start_tick` = current tick, active true) → `applyFailure` → `saveTruth` + `writeTelemetry(false)` so the UI changes **within the same second**. `ticket_lie`: **upsert** ticket id 41 `{target_id, "Repair: <target>", completed, "Replaced impeller, pump back online", created_tick}`; physical state unchanged. (Upsert: a second `ticket_lie` must not throw a duplicate-PK error.) |
| `clear_failure(failure_id)` | admin, presenter | `NOT_FOUND: failure <id>` → `active=false`. Physics reads `active` on the next step. |
| `clear_all_failures()` | admin, presenter | Every `failure` row → `active=false` (the UI uses this because failure ids are private). Then rewrite truth + telemetry so the change shows immediately. No-op (no throw) if there are none. |
| `report_fan_reading(rack_id, anomaly, fault_class, rms)` | bridge, admin | Clamp anomaly to [0,1]. `NOT_FOUND` if the rack doesn't exist. `setFanReading(s, rack_id, anomaly, s.tick, fault_class, rms)` → `saveTruth` + update that rack's `telemetry_latest` fan fields: `fan_anomaly`, `fan_health`, `fan_online`, **`fan_fault_class`** (verbatim, keeps a `replay:` prefix), **`fan_rms`**. Don't validate `fault_class` against `FAULT_CLASSES` (the `replay:` prefix would fail). Called at 2 Hz: keep it tiny. |
| `request_action(kind, target_id, params_json, requested_by, incident_id, request_key)` | presenter, agent | **6 args.** Validate kind ∈ `ACTION_KINDS`, target exists, `params_json` parses, `request_key` non-empty (≤ 64 chars) → `INVALID: …`. If a row with that `request_key` already exists, do nothing (idempotent retry; C's HTTP client retries with backoff). Insert `action` (status `pending`, `request_key`) → `checkAction(loadState(ctx) /* TRUE state */, a, rngFor(s,1), SAFETY_HORIZON_TICKS)` → update status `approved`/`blocked`, `safety_reason` = `res.reason` **verbatim** (keeps the `OK:` / `BLOCKED:` prefix C parses), `predicted_json = toJson(res.predicted)`. Blocked → `bumpMetric('unsafe_blocked', 1)`. Never throw on a blocked action: it's a normal result. Caller reads back with `SELECT * FROM action WHERE request_key = '<key>'`. |
| `execute_action(action_id)` | presenter, agent | `NOT_FOUND: action <id>`; status ≠ `approved` → `INVALID: not approved`. `applyAction` → `saveTruth` + `writeTelemetry(false)` → `status=executed`, `tick` = now. |
| `open_incident(symptom, component_ids, severity)` | agent | Allow `SYMPTOMS` **plus** the single exception `operator_question` (CONTRACTS §5); else `INVALID: symptom`. severity ∈ `SEVERITIES`. Insert `status=new`, `opened_tick` = now, `hypothesis=''`, `chosen_plan_json=''`, `resolved_tick=0`. The tick's dedupe must ignore `operator_question` incidents (they never block a real symptom). |
| `bump_metric(key, delta)` | agent, bridge | `key` ∈ `METRIC_KEYS` else `INVALID: key`; `metric[key] += delta`, insert if missing. **The module no longer auto-bumps `agent_calls`/`agent_tokens`**: C owns those counts through this reducer, so nothing is double counted. |
| `update_incident(incident_id, status, hypothesis, chosen_plan_json)` | agent | Validate status ∈ `INCIDENT_STATUSES`. `resolved` → `resolved_tick` = now. |
| `log_agent_step(...)` | agent | Truncate per §4.1. `tick` = now. |
| `write_shift_note(body, verified)` | agent | author `agent`, tick = now. Body ≤ 2000 chars. |
| `set_run_config(paused, speed)` | admin, presenter | speed 1..10 else `INVALID: speed`. |
| `admin_advance(ticks)` | admin | `ticks` 1..600 else `INVALID: ticks 1..600 per call` (eval loops). Runs the same `runSteps()` as tick (export it from `tick.ts`), even if paused. Writes history only for the last ≤120 steps. |
| `reset_to_seed(config_json)` **(additive, CONTRACT request #1)** | admin | `clearRunData` + full facility rewrite from config (or `defaultDemoConfig()` if `""`), tick 0, metrics reset, **`paused=true`** so the eval drives time with `admin_advance`. |
| `allowlist_add(identity_hex, role)` | admin | role ∈ `ROLES`; parse hex (`Identity.fromString(hex)`, verify name in docs) → `INVALID: identity_hex`; upsert. |
| `simulate_plan(actions_json, ticks)` **procedure** | agent, presenter | Parse `actions_json` as a JSON **array of §2 Action objects** whose `params` is an **object**: `[{"kind":"shed_load","target_id":"rack_7","params":{"kw":6}}]` (the PLAN §3.5 `params_json`-string example is obsolete: reject it with `INVALID: params must be an object`). Validate each kind/target. ticks 1..600. Inside a read transaction (`ctx.withTx(...)`, verify in docs) `loadState`, then run `simulate(s, actions, ticks, rngFor(s,2))`. **Return the Outcome object** (declare a product return type with exactly the 5 numeric fields `min_cooling_margin_kw, peak_temp_c, racks_degraded, racks_shutdown, downtime_rack_s`; copy them field by field so no hidden field can leak). The HTTP body must be that JSON object (check it with curl; if 2.x can only return a string, see F4). Writes nothing. |

---

## 5. Parallel build: 3 Claude Code sub-agents

### 5.1 Worktrees (run from the repo root, in Git Bash)
> **Branch naming (CONTRACTS §11):** sub-agent branches are `wt/b-<n>-<topic>`, never `lane/b-spacetime/...` (git can't hold a ref as both a file and a folder).
```bash
git checkout lane/b-spacetime && git pull --ff-only || true
git worktree add ../dcos-b1 -b wt/b-1-schema   lane/b-spacetime
git worktree add ../dcos-b2 -b wt/b-2-sim-loop lane/b-spacetime
git worktree add ../dcos-b3 -b wt/b-3-plan-ops lane/b-spacetime
# open one Claude Code session per folder: ../dcos-b1, ../dcos-b2, ../dcos-b3
# merging back (you, at each checkpoint):
git checkout lane/b-spacetime && git merge --no-ff wt/b-1-schema   # then wt/b-2-sim-loop, then wt/b-3-plan-ops
# when a sub-agent is finished for good: git worktree remove ../dcos-b<n> && git branch -d wt/b-<n>-<topic>
# after merging, uncomment the matching export lines in src/index.ts, publish to dcos-dev, run smoke.sh
```
**Publishing rule while sub-agents run:** only **you** (the human) publish to `dcos-dev`, from the merged `lane/b-spacetime` tree. Sub-agents verify with `npx tsc --noEmit` and `spacetime build` (if available; check `spacetime --help`) and may publish **only** to their own scratch DB: `dcos-b1-<yourname>`, `dcos-b2-<yourname>`, `dcos-b3-<yourname>`. Never to `dcos-dev` or `dcos`.

**Launch timing:** B-1 at **5:30 PM** (right after Phase 0). B-2 and B-3 at **5:45 PM**: they code against the §3.1 signatures and create their own files, and before B-1 merges they compile against a throwaway local copy of B-1's interface (`src/_shims.d.ts` in their own worktree, **not committed**).

### 5.2 Prompt for B-1 (tables + security + seed/build + bindings)
```
You are sub-agent B-1 in Lane B (SpacetimeDB) of DataCenterOS. Work in this worktree only.
Read plans/CONTRACTS.md (§1, §2, §3 fully) and plans/LANE-B-spacetime.md (§2.4, §3, §4) first.
Check https://spacetimedb.com/docs (TypeScript module reference) for exact 2.x syntax. Do not guess APIs;
if the docs and the SKETCH in LANE-B §3.2 differ, the docs win.

GOAL: the frozen v1 schema and security layer, so Lane D and C can build against it at the 7:00 PM sync.
OWNS (create/edit ONLY these): spacetime/module/package.json, spacetime/module/tsconfig.json,
  spacetime/module/src/{index,tables,auth,state,phys,physics-stub}.ts,
  spacetime/module/src/reducers/{lifecycle,allowlist,seed}.ts, spacetime/module/scripts/bootstrap.sh,
  scripts/gen-bindings.sh, apps/web/src/module_bindings/** (generated output only).
MUST NOT: edit any other file, change CONTRACTS.md, rename any table/column from CONTRACTS §3, publish to
  dcos-dev or dcos (use only scratch DB dcos-b1-<name>), commit secrets, or commit to anything but this branch.
TASKS:
 1. tables.ts: all 11 public tables (§3.1, public: true) and 5 private tables (§3.2, NOT public),
    column names and types EXACTLY as CONTRACTS §3, including action.request_key, telemetry_latest.fan_fault_class
    + fan_rms, telemetry_history.fan_anomaly. Add the btree indexes listed in LANE-B §3.2.
 2. auth.ts: roleOf, requireRole (throws "FORBIDDEN: admin|presenter required" style), assertModuleCaller
    (scheduled tick: sender must equal the module identity; find the right ctx field in the docs).
 3. state.ts: every function in LANE-B §3.1 with those exact signatures. toJson converts bigint→number.
    rngFor uses makeRng from ./phys. loadState rebuilds FacilityState from ground_truth.state_json + facility
    + edge + failure rows (u64 → Number). writeTelemetry prunes telemetry_history to the last 120 ticks.
 4. phys.ts = `export * from './physics-stub'` for now. physics-stub.ts implements the CONTRACTS §2 signatures:
    compileTopology returns packages/physics/fixtures/facility_default.json content (inline it if the package
    isn't installable), step increments tick/sim_time_s, checkAction returns BLOCKED when the action is
    shutdown_component on a pump and no other pump is online, simulate returns a zero Outcome, detect returns [].
 5. lifecycle.ts: init (owner → allowlist admin, run_config {1,false,1}, 7 metric rows = 0),
    clientConnected/clientDisconnected → subscribers metric (never < 0).
 6. allowlist.ts: allowlist_add(identity_hex, role). seed.ts: seed_demo_facility and build_facility per LANE-B §4.2.
 7. index.ts: re-export your reducer files; add COMMENTED-OUT export lines for reducers/{tick,failures,fan,
    actions,agent,config,admin}.ts and procedures/simulate_plan.ts (the human uncomments them at merge).
 8. scripts/gen-bindings.sh: `set -euo pipefail`; cd to repo root; run
    `spacetime generate --lang typescript --out-dir apps/web/src/module_bindings --project-path spacetime/module`
    (check the flag name with `spacetime generate --help`: it may be --module-path or --project-path).
 9. scripts/bootstrap.sh: reads PRESENTER_HEX, AGENT_HEX, BRIDGE_HEX, ADMIN_HEX from
    spacetime/module/scripts/.identities.env (untracked) and calls allowlist_add for each via `spacetime call`.
DONE WHEN: `npx tsc --noEmit` passes in spacetime/module; publish to dcos-b1-<name> succeeds;
  `spacetime call -s maincloud dcos-b1-<name> seed_demo_facility` then
  `spacetime sql -s maincloud dcos-b1-<name> "SELECT id FROM component"` returns 12 rows;
  ticket 40 and the human shift note exist; `bash scripts/gen-bindings.sh` writes bindings.
COMMIT: small commits "feat(b): B1 <summary>" on this branch only.
REPORT: files changed, exact verify commands + output, open questions, any contract change needed (as a
  request, not an edit), any package needed. Hackathon mode: no unit tests; working beats elegant.
```

### 5.3 Prompt for B-2 (tick + failures + fan + actions/safety + agent reducers)
```
You are sub-agent B-2 in Lane B (SpacetimeDB) of DataCenterOS. Work in this worktree only.
Read plans/CONTRACTS.md (§1, §2, §3 fully) and plans/LANE-B-spacetime.md (§2.4, §3, §4) first.
Check https://spacetimedb.com/docs (TypeScript modules: reducers, scheduled tables) for exact 2.x syntax.

GOAL: the live simulation loop and every gameplay reducer: the Pump A trap must work end to end.
OWNS (create/edit ONLY these): spacetime/module/src/reducers/{tick,failures,fan,actions,agent}.ts.
  You may create spacetime/module/src/_shims.d.ts locally to compile before B-1 merges, but DO NOT commit it.
MUST NOT: edit tables.ts, auth.ts, state.ts, phys.ts, index.ts or any other file; change CONTRACTS.md;
  publish to dcos-dev/dcos; commit secrets. If you need a helper that doesn't exist, write it as a private
  function inside your own file and say so in the report.
CODE AGAINST: the helper signatures in LANE-B §3.1 (import from '../auth', '../state', '../phys', '../tables').
  Use the physics functions ONLY through '../phys' (never import '@dcos/physics' directly).
TASKS (behavior exactly per LANE-B §4.2):
 1. tick.ts: export `runSteps(ctx, n, writeHistoryLast)` and the scheduled reducer `tick` (assertModuleCaller;
    paused → return; speed clamp 1..10; step → saveTruth → writeTelemetry → prune → detect → incidents for
    symptoms without an open incident → metrics events_per_s, downtime_rack_s). Use rngFor(s, 0).
 2. failures.ts: inject_failure (validate kind/target; insert failure; applyFailure; immediate telemetry write;
    ticket_lie UPSERTS ticket #41 exactly as CONTRACTS §3.3), clear_failure, clear_all_failures.
 3. fan.ts: report_fan_reading (bridge, admin): clamp, setFanReading(s, rack, anomaly, tick, fault_class, rms),
    saveTruth, update rack telemetry_latest incl. fan_fault_class (verbatim, may start with "replay:") and fan_rms.
 4. actions.ts: request_action with SIX args (… incident_id, request_key): store request_key, idempotent on a
    repeated key; checkAction on loadState = TRUE state, horizon SAFETY_HORIZON_TICKS; safety_reason = reason
    verbatim; blocked → bump unsafe_blocked; never throw on blocked. execute_action (throw exactly
    "INVALID: not approved" unless approved).
 5. agent.ts: update_incident, log_agent_step (truncate summary 280 chars, payload 4096 bytes; NO metric bumps),
    write_shift_note (author "agent"), open_incident (SYMPTOMS + "operator_question"; status new),
    bump_metric (agent|bridge; key must be in METRIC_KEYS; insert row if missing).
 6. In tick's incident dedupe, ignore incidents whose symptom is "operator_question".
 Every reducer begins with requireRole per CONTRACTS §3.3. Errors start with FORBIDDEN:/NOT_FOUND:/INVALID:.
 No Math.random, Date.now, module-level mutable state; never JSON.stringify a bigint (use toJson).
DONE WHEN: `npx tsc --noEmit` passes; after B-1's merge the human can publish and verify:
  facility.tick increases ~1 per second; telemetry_history ≤ 120 rows per component after 3 min;
  inject_failure pump_fail pump_B → component pump_B status 'offline' within 1 s;
  inject_failure ticket_lie pump_B → ticket 41 'completed'; request_action ["shutdown_component","pump_A","{}",
  "operator",0,"<uuid>"] (pump_B failed) → `SELECT * FROM action WHERE request_key='<uuid>'` shows 'blocked'
  and safety_reason starting with 'BLOCKED:'; clear_all_failures → no active failures, pump_B recovers;
  report_fan_reading rack_3 0.9 "replay:imbalance" 0.14 → telemetry_latest rack_3 fan_fault_class
  'replay:imbalance', fan_rms 0.14.
COMMIT: "feat(b): B2 <summary>" on this branch only.
REPORT: files changed, verify commands, open questions, contract requests (not edits). Hackathon mode.
```

### 5.4 Prompt for B-3 (procedure + run_config + admin + eval DB + smoke test)
```
You are sub-agent B-3 in Lane B (SpacetimeDB) of DataCenterOS. Work in this worktree only.
Read plans/CONTRACTS.md (§2, §3, §4 fully) and plans/LANE-B-spacetime.md (§2.4, §2.5, §3, §4, §7) first.
Check https://spacetimedb.com/docs for exact 2.x syntax of PROCEDURES in TypeScript modules (how a procedure
reads tables, e.g. ctx.withTx, and how it declares a string return type) and for the HTTP API.

GOAL: counterfactual planning (simulate_plan), time control for the demo and eval, and an automated smoke test.
OWNS (create/edit ONLY these): spacetime/module/src/procedures/simulate_plan.ts,
  spacetime/module/src/reducers/{config,admin}.ts, spacetime/module/scripts/{smoke.sh,ticker.py}.
  You may create an uncommitted spacetime/module/src/_shims.d.ts to compile before B-1 merges.
MUST NOT: edit any other file (tick.ts belongs to B-2: import its exported runSteps, don't copy it);
  change CONTRACTS.md; publish to dcos-dev/dcos; commit tokens.
TASKS (behavior per LANE-B §4.2):
 1. simulate_plan(actions_json: string, ticks: u32) → Outcome OBJECT: role agent|presenter; actions_json is a
    JSON array of CONTRACTS §2 Action objects whose params is an OBJECT (reject strings with INVALID:);
    ticks 1..600; read TRUE state via loadState inside a read tx; simulate(s, actions, ticks, rngFor(s, 2));
    return an object with EXACTLY the 5 Outcome fields (declared product return type; copy field by field).
    No writes. Verify with curl that the HTTP body is a JSON object, not a quoted string; if 2.x can only
    return a string, report it immediately (LANE-B §7 F4).
 2. config.ts: set_run_config(paused, speed) admin|presenter, speed 1..10.
 3. admin.ts: admin_advance(ticks) admin, 1..600 per call, calls runSteps from './tick' (works while paused);
    reset_to_seed(config_json) admin: clearRunData, writeFacility from config (or defaultDemoConfig() when ""),
    tick 0, metrics reset, paused=true. Also write tick_manual() (admin|bridge, calls runSteps(ctx,1,true))
    but leave it COMMENTED OUT with a note "fallback, enable only if the scheduler fails (LANE-B §7)".
 4. Local eval DB: document in your report the exact commands: `spacetime start` (separate terminal),
    `spacetime publish -s local dcos-eval`, mint the EVAL ADMIN and EVAL AGENT tokens via
    `curl -X POST http://localhost:3000/v1/identity`, allow-list both on dcos-eval (admin, agent).
 5. scripts/smoke.sh (bash, curl only, jq optional): env STDB_HOST, STDB_DB, STDB_ADMIN_TOKEN,
    STDB_AGENT_TOKEN, STDB_BRIDGE_TOKEN, VITE_STDB_PRESENTER_TOKEN. Helpers call <token> <reducer> '<json array>'
    and sql <token> '<query>'. Checks, each printing PASS/FAIL, exit 1 on any FAIL:
    seed → 12 components; tick advances over 3 s; history rows for rack_1 ≤ 120; anonymous inject_failure
    → non-200; inject pump_fail pump_B → pump_B offline; ticket_lie → ticket 41; request_action
    ["shutdown_component","pump_A","{}","operator",0,"$KEY"] as agent with a fresh KEY (uuidgen, or
    "smoke-$(date +%s)-$RANDOM") → `SELECT * FROM action WHERE request_key='$KEY'` is 'blocked' with 'BLOCKED:';
    execute_action on that id → non-200 containing 'INVALID: not approved'; open_incident
    ["operator_question","pump_A","low"] as agent → 200; log_agent_step/update_incident/write_shift_note as
    agent → 200; bump_metric ["agent_calls",1] as agent → metric increases; report_fan_reading
    ["rack_3",0.9,"replay:imbalance",0.14] as bridge → 200 and fan_fault_class matches; clear_all_failures as
    presenter → 200; agent SQL on ground_truth, failure, allowlist → non-200 or zero rows; simulate_plan
    ['[{"kind":"shed_load","target_id":"rack_8","params":{"kw":6}}]',300] as agent → body is a JSON OBJECT
    with min_cooling_margin_kw and total time < 0.5 s (curl -w '%{time_total}'); CORS probe: curl -i -X OPTIONS
    $STDB_HOST/v1/database/$STDB_DB/sql -H 'Origin: http://localhost:5173' -H 'Access-Control-Request-Method: POST'
    → print the Access-Control-Allow-Origin header (INFO, not PASS/FAIL); set_run_config true 1 → tick stops;
    set_run_config false 1; finally seed_demo_facility again to leave a clean demo state.
 6. scripts/ticker.py (stdlib only: urllib): loop every 1.0 s, POST call/tick_manual with STDB_ADMIN_TOKEN,
    print errors, never crash.
DONE WHEN: `npx tsc --noEmit` passes; on your scratch DB (after merging B-1/B-2 locally into your worktree
  for testing only) simulate_plan returns Outcome JSON in < 500 ms and smoke.sh prints all PASS.
COMMIT: "feat(b): B3 <summary>" on this branch only. REPORT: files, commands + output, open questions,
  contract requests. Hackathon mode: no unit tests.
```

---

## 6. Task table by phase

Commands assume Git Bash in the repo root, `M=spacetime/module`, `export STDB_HOST=https://maincloud.spacetimedb.com` (confirm at the booth). CLI `spacetime call` arguments are JSON values (strings need quotes); confirm with `spacetime call --help`.

### Phase 0: Setup (4:50–5:45 PM)
| ID | Window | Est | Depends | Task | Files | Definition of done + test |
|---|---|---|---|---|---|---|
| B-P0-01 | 4:50–5:10 | 20m | — | Install Node 22, pnpm, SpacetimeDB CLI 2.x; `spacetime login` | — | `spacetime --version` = 2.x; `spacetime login show` prints identity |
| B-P0-02 | 5:00–5:15 | 15m | — | Booth: HACKUTD2026 credit, HTTP base URL, reducer time limit, procedures in TS 2.x | `plans/status/B.md` | Answers posted in team chat + status file |
| B-P0-03 | 5:10–5:35 | 25m | P0-01 | Branch `lane/b-spacetime`; scaffold `basic-ts` into `spacetime/module`; add `facility` table + `ping`; publish | `$M/**` | `spacetime sql -s maincloud dcos-dev "SELECT * FROM facility"` succeeds |
| B-P0-04 | 5:35–5:45 | 10m | P0-03 | `scripts/gen-bindings.sh`; run it | `scripts/gen-bindings.sh`, bindings | `apps/web/src/module_bindings/index.ts` exists; PR-ready |
| B-P0-05 | 5:40–5:50 | 10m | P0-03 | Mint 4 identities (`curl -X POST $STDB_HOST/v1/identity` ×4), store tokens outside git, DM C the agent token for its selftest | `~/dcos-tokens.txt` | C can call `ping` with the agent token |

### Phase 1a: Schema freeze (5:30–7:00 PM): **your hardest deadline**
| ID | Window | Est | Depends | Task | Files | DoD + test |
|---|---|---|---|---|---|---|
| B-P1-01 | 5:30–6:30 | 60m | P0-03 | **B-1** runs: tables, auth, state, phys stub, lifecycle, allowlist | B-1 files | `npx tsc --noEmit` passes in `$M` |
| B-P1-02 | 5:45–7:00 | 75m | §3.1 sigs | **B-2** and **B-3** start against the signatures | B-2/B-3 files | Compiles against shims |
| B-P1-03 | 6:15–6:40 | 25m | S fixtures | Stub `compileTopology` returns `facility_default.json`; `seed_demo_facility` | `seed.ts`, `physics-stub.ts` | After seed: `spacetime sql … "SELECT id FROM component"` → **12 rows** |
| B-P1-04 | 6:40–6:55 | 15m | P1-01 | Merge B-1 → `lane/b-spacetime`; publish `dcos-dev`; `bootstrap.sh`; regenerate bindings | — | Agent token calling `/call/log_agent_step` gets `FORBIDDEN:` **before** `bootstrap.sh` and 200 **after** it. D and C have the `dcos-dev` name and the bindings |
| B-P1-05 | 6:55–7:00 | 5m | P1-04 | `git fetch && git rebase origin/main`; PR to `main` titled `B: schema v1 + bindings` | — | PR open; checklist (§12) ticked |
| B-P1-05b | 6:30–6:45 | 15m | P0-03 | **CORS check for D** (CONTRACTS §11): `curl -i -X OPTIONS $STDB_HOST/v1/database/dcos-dev/sql -H 'Origin: http://localhost:5173' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization,content-type'`, then confirm in a real browser: on any page, DevTools console `fetch('<STDB_HOST>/v1/database/dcos-dev/sql',{method:'POST',body:'SELECT * FROM facility'}).then(r=>r.text()).then(console.log)` | `plans/status/B.md` | Post **"CORS: yes/no"** in team chat **by 7:00 PM**. No → C adds `GET /proxy/sql?q=` (C's job, not yours) |

### Phase 1b: Live loop + prod (7:00–9:00 PM)
| ID | Window | Est | Depends | Task | Files | DoD + test |
|---|---|---|---|---|---|---|
| B-P1-06 | 7:00–7:30 | 30m | S package | **Bundling test:** switch `phys.ts` to `@dcos/physics` (`"@dcos/physics": "workspace:*"` in `$M/package.json`), `pnpm install`, publish | `phys.ts`, `package.json` | Publish succeeds. **Fails → §7 F1 by 7:30 PM** |
| B-P1-07 | 7:00–8:00 | 60m | B-2 | Merge B-2 (tick, failures, fan, agent); uncomment exports; publish dev | — | `SELECT tick FROM facility` twice 3 s apart → increases by ≥ 2. **Not ticking by 8:30 → §7 F2** |
| B-P1-08 | 8:00–8:30 | 30m | P1-07 | Failure + fan checks | — | `spacetime call -s maincloud dcos-dev inject_failure '"pump_fail"' '"pump_B"' '"{}"'` → `SELECT status FROM component WHERE id='pump_B'` = `offline`; `ticket_lie` → `SELECT * FROM ticket WHERE id=41` = completed; `clear_all_failures` → pump_B back online within a few ticks; bridge `report_fan_reading ["rack_3",0.9,"imbalance",0.14]` → `SELECT fan_anomaly, fan_fault_class, fan_rms FROM telemetry_latest WHERE component_id='rack_3'` |
| B-P1-09 | 8:30–8:50 | 20m | P1-08 | **Prod:** `spacetime publish -s maincloud dcos`; `bootstrap.sh` against `dcos`; `seed_demo_facility` | — | `STDB_DB=dcos bash $M/scripts/smoke.sh` (or the manual checks) green for what exists |
| B-P1-10 | 8:50–9:00 | 10m | P1-09 | **Hand out tokens** in team chat DMs: presenter → D, agent → C, bridge → whoever has claimed the fan-bridge task in `plans/status/A.md` (it runs on the demo laptop), admin → S; post `STDB_HOST` + DB names publicly | — | Each person confirms one successful call. History bounded: after 3 min `SELECT id FROM telemetry_history WHERE component_id='rack_1'` ≤ 120 rows |

### Phase 1c: Safety engine + MVP (9:00–11:00 PM)
| ID | Window | Est | Depends | Task | Files | DoD + test |
|---|---|---|---|---|---|---|
| B-P1-11 | 9:00–10:00 | 60m | S `checkAction` | Real `checkAction` through `request_action`; `execute_action`; `open_incident` + `bump_metric` checked with C | `actions.ts`, `agent.ts` | With pump_B failed: agent `request_action ["shutdown_component","pump_A","{}","operator",0,"k-001"]` → `SELECT * FROM action WHERE request_key='k-001'` is `blocked`, `safety_reason` starts `BLOCKED:`; same call again with `k-001` → still one row; `execute_action` on it → `INVALID: not approved`. `restore_component pump_B` with key `k-002` → `approved` → execute → `executed` |
| B-P1-12 | 9:00–10:30 | 90m | B-3 | Merge B-3 (`simulate_plan`, config, admin); publish dev | — | `curl -s -w '\n%{time_total}\n' -X POST $STDB_HOST/v1/database/dcos-dev/call/simulate_plan -H "Authorization: Bearer $STDB_AGENT_TOKEN" -H 'Content-Type: application/json' -d '["[{\"kind\":\"shed_load\",\"target_id\":\"rack_8\",\"params\":{\"kw\":6}}]",300]'` → body is a JSON **object** with the 5 Outcome keys (not a quoted string), time < 0.5. **Broken at 10:30 → §7 F4** |
| B-P1-13 | 10:00–10:30 | 30m | P1-11 | **Security proof** | — | `curl -X POST $STDB_HOST/v1/database/dcos/sql -H "Authorization: Bearer $STDB_AGENT_TOKEN" -d 'SELECT * FROM ground_truth'` → non-200 (or zero rows; record which in status). Anonymous `inject_failure` → `FORBIDDEN:` |
| B-P1-14 | 10:30–11:00 | 30m | all | Republish prod (additive), `smoke.sh` on `dcos`, PR for 11:00 sync; support §4.2 MVP checklist | — | `smoke.sh` all PASS on `dcos`; `seed_demo_facility` resets the demo in < 2 s |

### Phase 2: Hard piece support (11:00 PM–4:30 AM)
| ID | Window | Est | Depends | Task | Files | DoD + test |
|---|---|---|---|---|---|---|
| B-P2-01 | 11:15–11:45 | 30m | P1-12 | `simulate_plan` on prod; time it 10× | — | p95 < 500 ms; result has exactly 5 keys; no hidden fields |
| B-P2-02 | 11:45–12:45 | 60m | B-3 | `dcos-eval`: `spacetime start` (own terminal), `spacetime publish -s local dcos-eval`, mint the **eval admin** and **eval agent** tokens on the local server, allow-list both on `dcos-eval`, DM them to S (eval runner) and C (worker in eval mode). S's eval may also need the **local owner** login to read `failure` for root-cause scoring (fine locally, never on prod) | — | With the eval admin token: `reset_to_seed [""]` then `admin_advance [600]` → `SELECT tick FROM facility` = 600, paused stays true; same seed twice → identical `telemetry_latest` (determinism). With the eval agent token: `log_agent_step` → 200, SQL on `ground_truth` → fails |
| B-P2-03 | 12:45–1:30 | 45m | — | Perf + limits: tick at `speed=10` for 2 min, watch `spacetime logs` for time-limit warnings; `events_per_s` and `subscribers` look sane | — | No errors in logs; metric rows update every tick |
| B-P2-04 | 1:30 | — | — | Sync: PR, status file, write the A/D on-call card | `plans/status/B.md` | Merged by S |
| B-P2-05 | 1:30–3:00 | 90m | C's needs | Support C (execute/verify, Challenge mode): fix reducer bugs C reports, add `dispatch_tech` checks, incident dedupe tuning | B files | C's 3:00 AM hard-piece run passes the 4 scenarios |
| B-P2-06 | 3:00–4:15 | 75m | S `compileTopology` | `build_facility` with the real compiler; test `{"pump":{"count":3,"capacity_kw":30}}` config from PLAN §3.5 | `seed.ts` | 13 components (3 pumps) appear; warnings arrive as `shift_note` author `system`; D notified the builder can wire up |
| B-P2-07 | 4:15–4:30 | 15m | — | Republish prod, `smoke.sh` on `dcos`, re-seed demo, status file, sleep | — | Green; demo seeded |

### Phase 4: Polish + freeze (7:30–10:00 AM)
| ID | Window | Est | Depends | Task | Files | DoD + test |
|---|---|---|---|---|---|---|
| B-P4-01 | 7:30–8:00 | 30m | — | **Offline fallback rehearsal:** `spacetime start` on the demo laptop, `spacetime publish -s local dcos`, local tokens, `bootstrap.sh`, D's `.env.local.offline` with `VITE_STDB_URI=ws://<laptop-LAN-IP>:3000`, phones on hotspot | — | Dashboard runs fully against local; time it (target < 10 min) |
| B-P4-02 | 8:00–9:00 | 60m | — | README section draft (§8.2) to S; showcase check (§8.1); demo reset path ("Reset demo" = `seed_demo_facility` + `set_run_config(false,1)`) | issue/PR comment to S | Reset → ready in < 5 s |
| B-P4-03 | 9:00–9:40 | 40m | — | Final bug fixes from rehearsals; **additive only** | B files | `smoke.sh` green on `dcos-dev` |
| B-P4-04 | 9:40–9:45 | 5m | — | **Last prod publish**, `smoke.sh` on `dcos`, re-seed, PR for 9:45 sync | — | Green. After this, no publish to `dcos` without Suvan's OK |
| B-P5-01 | 10:00–11:00 | 30m | — | Repo hygiene for B paths: `git log -p -- spacetime scripts | grep -iE 'eyJ|token='` returns nothing | — | Clean |
| B-J-01 | 1:00–4:00 PM | — | — | Judging: you answer "Why SpacetimeDB?" and "what runs in it"; keep `spacetime logs -f -s maincloud dcos` open on a side screen | — | — |

---

## 7. Fallbacks (decide at the deadline, don't drift)

| # | Problem | Early warning | Fallback | Decide by |
|---|---|---|---|---|
| F1 | **`@dcos/physics` won't bundle** into the module | `spacetime publish` errors on the import, or runtime "module not found" | Ask S to run **`node scripts/sync-physics.mjs`** (S owns it), which copies the physics source into `spacetime/module/src/physics/` with a "GENERATED, do not edit" header. Change `phys.ts` to `export * from './physics'`. You commit the generated folder; you never edit it by hand. Re-run after every physics change S makes (S pings you) | **7:30 PM** |
| F2 | **Scheduled tick misbehaves** (not firing, irregular, or the scheduled-table syntax fights you) | `facility.tick` not advancing by 8:15 PM | (a) Try interval 2 s. (b) Enable `tick_manual()` in `admin.ts` (role admin, bridge; additive CONTRACT request #2), publish, and run `python spacetime/module/scripts/ticker.py` on the demo laptop with `STDB_ADMIN_TOKEN`. It's still a reducer, so it's still SpacetimeDB-powered; say "the ticker is a 5-line heartbeat" honestly | **8:30 PM** |
| F3 | **Maincloud down** or venue Wi-Fi unusable | Publish fails twice, or the dashboard reconnect-loops > 5 min | Local `spacetime start` on the demo laptop; `spacetime publish -s local dcos`; local tokens (pre-minted at 7:30 AM, stored in each person's `.env.local.offline`); `bootstrap.sh`; `seed_demo_facility`; everyone joins the phone hotspot; `STDB_HOST=http://<laptop-LAN-IP>:3000` | Any time (rehearsed at 7:30 AM) |
| F4 | **Procedures don't work** in TS 2.x (not enabled, can't read tables, HTTP doesn't return the value) | `simulate_plan` call fails at 10:00 PM. (Milder case: it works but can only return a **string**, so the body is a quoted JSON string. Then don't switch to `plan_result`; tell C to parse twice and S to note it in CONTRACTS §4.) | Additive CONTRACT request #3: public table `plan_result {request_id: string PK, outcome_json: string, tick: u64}` + reducer `simulate_plan_req(request_id: string, actions_json: string, ticks: u32)` (agent, presenter) that writes the Outcome there. C calls the reducer with a UUID then reads `SELECT outcome_json FROM plan_result WHERE request_id='…'`. Same physics, same hidden-truth guarantee | **10:30 PM** |
| F5 | **bigint / u64 JSON issues** | Reducer rolls back with `TypeError: Do not know how to serialize a BigInt`, or C's selftest sees u64 as strings | Module side: every `*_json` goes through `toJson`; never spread a row into `JSON.stringify`. Python side: C's `stdb.py` converts (CONTRACTS §4). No reducer takes a u64 argument, by design. Last resort (PLAN §8): add `tick_f: f64` mirror columns (additive, default 0) | **6:30 PM** (C's selftest) |
| F6 | **Reducer time limit hit** (tick at speed 10, `admin_advance 600`, `checkAction` horizon) | Errors in `spacetime logs` | Clamp speed to 5, `admin_advance` to 200 per call (S's eval loops more), write history only for the final step | When seen |
| F7 | **Accidental breaking schema change** | Publish asks for `--delete-data` | Stop. Make it additive instead. If truly necessary (dev only): `spacetime publish -s maincloud --delete-data dcos-dev`, `bootstrap.sh`, `seed_demo_facility`, regenerate bindings, tell D | Never on prod after 9:45 AM |

---

## 8. Spacetime track showcase duties

The brief: *"Spacetime must power the app's primary functionality, not just chat or player movement."* Public GitHub source is required.

### 8.1 Checklist
- [ ] `metric` rows `events_per_s` and `subscribers` update every tick; D's `StatsBar` shows them (tell D the exact keys).
- [ ] `events_per_s` = real rows written per tick call (latest + history + truth + component + incidents), not a fake number.
- [ ] `subscribers` counts live WebSocket clients via `clientConnected`/`clientDisconnected`.
- [ ] Every agent step is an `agent_step` row (C writes them through `log_agent_step`).
- [ ] The repo is public (S/D own the repo settings; you check before 10 AM): `gh repo view --json visibility`.
- [ ] `spacetime/module/` has no secrets; the code is readable (short files, the layout in §3).
- [ ] You can demo `spacetime sql -s maincloud dcos "SELECT * FROM ground_truth"` as owner (works) vs the agent token (fails) in 20 seconds if a judge asks.

### 8.2 README section draft (hand to S; S owns `README.md`)
```markdown
## What runs in SpacetimeDB

SpacetimeDB is the entire backend: there is no other server. One TypeScript module (`spacetime/module`) on
Maincloud holds the data center and runs it.

- **The physics tick is a scheduled reducer.** Every second, `tick` steps our deterministic physics package
  (`@dcos/physics`), writes the true state to a private table and the observed telemetry to public tables,
  prunes a 120-row ring buffer per component, and opens incidents when monitors see symptoms.
- **Hidden ground truth is a private table.** `ground_truth` and `failure` are readable only inside the module.
  The AI agents connect with their own non-owner identity, so they cannot see the root cause; they have to
  diagnose it from telemetry, tickets and shift notes, like a real operator.
- **The safety engine runs inside a reducer.** `request_action` simulates 120 s ahead on the true state and
  marks an action `approved` or `blocked` with the reason. `execute_action` refuses anything not approved.
- **Counterfactual planning is a procedure.** `simulate_plan` runs a candidate recovery plan on an in-memory
  copy of the true state and returns only the outcome (peak temperature, shutdowns, downtime).
- **Access control is an identity allow-list** checked in every reducer (admin, presenter, agent, bridge).
- **Every screen is a live subscription:** the facility graph, telemetry charts, incidents, the agents'
  step-by-step reasoning (`agent_step` rows) and the real fan's vibration score (written by the hardware
  bridge through `report_fan_reading`). The header shows live events/s and subscriber counts.

Tables: 11 public (`facility`, `component`, `edge`, `telemetry_latest`, `telemetry_history`, `ticket`,
`shift_note`, `incident`, `action`, `agent_step`, `metric`), 5 private (`ground_truth`, `failure`, `allowlist`,
`tick_schedule`, `run_config`). 18 reducers (including the scheduled tick) and 1 procedure. Run it: `cd spacetime/module && spacetime publish
-s maincloud <db>`, then `spacetime call -s maincloud <db> seed_demo_facility`.
```

---

## 9. Proposed CONTRACT requests (open as issues `CONTRACT B: …`; S decides; these are not edits)
Already accepted into CONTRACTS (implemented above, no issue needed): `request_key`, `open_incident`, `bump_metric`, `clear_all_failures`, the fan columns, `simulate_plan` taking object `params` and returning an object, eval tokens, and `wt/` branch names.

Still open (file these before 7:00 PM where possible):
1. **`reset_to_seed(config_json: string)`**, admin: clears run data, rebuilds from config (`""` = default), tick 0, `paused=true`. Needed by S's eval; not in §3.3 yet.
2. **`tick_manual()`**, admin, bridge: the fallback heartbeat (F2). It ships commented out and gets enabled only if the scheduler fails.
3. **Fallback `plan_result` table + `simulate_plan_req(request_id, actions_json, ticks)` reducer** (F4), needed only if procedures fail. Pre-approve it so switching costs no contract round trip at 10:30 PM.
4. **Limits:** `admin_advance` and `simulate_plan` ticks capped at 600 per call (`INVALID:` above that); `speed` 1..10; `request_key` ≤ 64 chars; `request_action` is idempotent on a repeated `request_key`.
5. **`open_incident` read-back:** "newest incident with that symptom" needs max `id`, and SpacetimeDB SQL may not support `ORDER BY` (verify). C should filter by symptom and take the max `id` client-side. A cleaner additive fix would be an `incident.request_key`, as for `action`.
6. **§0 / §8 wording:** D's row in §0 still says the bindings are "generated by S" (they're generated by B now); §8's list of reducers D calls should include `clear_all_failures`.
7. **`.gitignore`** (REQUEST S, root file): add `spacetime/module/scripts/.identities.env` and `.env.local.offline`.

---

## 10. Time estimate
| Block | Person-hours (solo) | With 3 sub-agents (wall clock for you) |
|---|---|---|
| Setup + booth + first publish | 1.0 | 1.0 |
| Tables, auth, state, seed/build, bindings | 2.5 | 1.25 |
| Tick, failures, fan, actions, agent reducers | 3.5 | 1.75 |
| Procedure, config, admin, eval DB, smoke | 2.5 | 1.25 |
| Integration, publishing, debugging with C/D/A | 3.5 | 3.5 (can't be parallelized) |
| Real compiler `build_facility`, perf, fallback rehearsal | 2.0 | 1.5 |
| README draft, hygiene, demo resets | 1.0 | 1.0 |
| **Total** | **~16 h** | **~11 h** of your awake time, done well before 10 AM with ~3 h buffer |

**Milestones (fail one by > 45 min → apply §7 and tell Suvan):** 5:45 PM hello on `dcos-dev` · **7:00 PM schema freeze + bindings** · 8:30 PM ticking · **9:00 PM prod + tokens** · 10:00 PM safety engine blocks the trap · 11:00 PM `simulate_plan` on dev · 1:30 AM eval DB + smoke green · 4:15 AM real `build_facility` · 9:45 AM final publish.

---

## 11. Status template: `plans/status/B.md`
```markdown
# Lane B status (updated <time>)
**Done:** <task IDs, one line each>
**Doing:** <task ID, ETA>
**Blocked:** <what, on whom, since when>
**Needs from others:** <S: …, C: …, D: …, A: …>
**DBs:** dcos-dev = <module git sha> · dcos = <git sha> · dcos-eval = <sha or n/a>
**Last smoke.sh:** <time, db, PASS n / FAIL n (names)>
**Booth answers:** base URL = … · reducer time limit = … · procedures in TS = yes/no · credit = redeemed?
**Contract requests open:** <#issue numbers>
**On-call card for D (4:30–7:30 AM):**
1. Dashboard frozen? Presenter panel → Resume / speed ×1 (= `set_run_config(false, 1)`)
2. Facility weird? Presenter panel → "Reset demo" (= seed_demo_facility)
3. Look at errors: `spacetime logs -s maincloud dcos`
4. Prod down? Don't republish. Switch D to dcos-dev and text B.
5. Never run publish --delete-data.
```
(No tokens in this file, ever.)

## 12. PR checklist (paste into every Lane B PR to `main`)
```markdown
- [ ] Rebased: `git fetch && git rebase origin/main`
- [ ] `cd spacetime/module && npx tsc --noEmit` passes
- [ ] Published to `dcos-dev` from this exact commit; `spacetime logs` clean
- [ ] `bash spacetime/module/scripts/smoke.sh` all PASS on dcos-dev (paste the summary line)
- [ ] Schema change? Additive only (no rename/remove), CONTRACT issue linked, `bash scripts/gen-bindings.sh` run and bindings committed in this PR
- [ ] Public/private matches CONTRACTS §3.1/§3.2 (11 public, 5 private)
- [ ] Every new reducer starts with requireRole; errors use FORBIDDEN:/NOT_FOUND:/INVALID:
- [ ] No Math.random / Date.now / module-level mutable state; no JSON.stringify on bigint
- [ ] Only Lane B paths touched (`git diff --stat origin/main` shows spacetime/module/**, scripts/gen-bindings.sh, apps/web/src/module_bindings/**, plans/status/B.md)
- [ ] No tokens or identity files committed (`git diff origin/main | grep -iE 'eyJ|token='` is empty)
- [ ] Prod `dcos` republished? If yes: time, smoke result, demo re-seeded, team told
```
