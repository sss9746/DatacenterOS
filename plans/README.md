# DataCenterOS team plans: start here (v3)

Four software lanes plus one shared hardware lane. **Each lane owns its own folders, so merges don't collide.**

**Integrator / orchestrator:** Suvan's Claude session. It owns `plans/`, `packages/contracts/`, root config and `scripts/`, does **all merges to `main`**, runs the gate checks and writes no lane code. Suvan himself builds **P3**.

| Lane | Person | Plan file | Owns | Branch |
|---|---|---|---|---|
| **P1: Simulation + safety + baselines** | ___ | [`LANE-P1-sim.md`](LANE-P1-sim.md) | `packages/physics/` | `lane/p1-sim` |
| **P2: SpacetimeDB + durability** | ___ | [`LANE-P2-db.md`](LANE-P2-db.md) | `apps/db/`, `packages/db-client/`, tokens, publishing | `lane/p2-db` |
| **P3: Nemotron + orchestration** | **Suvan** | [`LANE-P3-agent.md`](LANE-P3-agent.md) | `apps/agent/` | `lane/p3-agent` |
| **P4: Frontend + evaluation + pitch** | ___ | [`LANE-P4-web.md`](LANE-P4-web.md) | `apps/web/`, `apps/evaluation/`, `docs/` | `lane/p4-web` |
| **HW: Pico fan + real GPU (shared, optional)** | everyone | [`LANE-HW-shared.md`](LANE-HW-shared.md) | `hardware/` | `lane/hw` |

Write your name in the Person column of [`../PLAN.md`](../PLAN.md) and in your status file.

## Read these, in order (about 20 minutes)
1. [`../PLAN.md`](../PLAN.md): pitch, demo, gates, cut order (2 pages)
2. [`CONTRACTS.md`](CONTRACTS.md) **§0**: paths, IDs, function names, reason codes, roles, env vars. Then skim the kit sections A–E.
3. [`ARCHITECTURE.md`](ARCHITECTURE.md): §0 (decisions), §1 (diagram), and the sections for your lane:
   - P1: §2, §5
   - P2: §3, §6, §7
   - P3: §4, §5, §6
   - P4: §9, §11
4. **Your lane file.**

Background only: [`RESEARCH.md`](RESEARCH.md) (incident stats) and [`NICHE-DECISION.md`](NICHE-DECISION.md) (why GPU reliability). Older plans live only in git history.

## First 15 minutes (everyone)
```bash
git clone https://github.com/sss9746/DatacenterOS && cd DatacenterOS
git checkout -b lane/<p1-sim|p2-db|p3-agent|p4-web|hw>
corepack enable && pnpm install          # Node 22+
pnpm -r test                              # physics 95 + contracts 15 must pass
pip install jsonschema && pnpm contracts:validate
cp .env.example .env.local                # never commit .env.local; P2 sends tokens in team chat
```
Then fill in `plans/status/<P1|P2|P3|P4|HW>.md` and push your branch.

> ⚠️ **Never force-push to `main`.** Kaushik's original kit (commit `3dd17d0`) now lives in `plans/ARCHITECTURE.md`, `plans/CONTRACTS.md` and `packages/contracts/`; its IMPLEMENTATION_TASKS became the lane files.

**Running TypeScript:** `@dcos/contracts` and `@dcos/physics` point at `.ts` source. Run Node apps with **`tsx`** (`pnpm add -D tsx`, then `tsx src/main.ts`). Vite and vitest handle it natively.

## Rules (humans and Claude agents)
1. **Only edit paths your lane owns** (CONTRACTS §0.1). Need something from another lane? Open a GitHub issue titled `REQUEST <lane>: …` and say so in team chat.
2. **Contracts:** only the orchestrator edits `plans/CONTRACTS.md` and `packages/contracts/`. To request a change, open an issue titled `CONTRACT <lane>: …`. After Gate 0, changes are **additive only**.
   - Wire types come from `@dcos/contracts`.
   - DB types come from `@dcos/db-client`.
   - **Never hand-write a duplicate type.**
3. **Build against fixtures and mocks first,** so nobody waits on anybody:
   - P1 ships `packages/physics/fixtures/gpu/*.json` by **8:45 PM**.
   - P2 ships a mock db-client (same API, backed by those fixtures) by **9:00 PM**.
4. **Small commits:** `feat(p2): …`, `fix(p3): …`. Never commit secrets, `node_modules`, `.env.local`, or recordings over 5 MB.
5. **Only the orchestrator merges to `main`,** at the sync points: **9:00 PM · 11:30 PM · 1:30 AM · 4:30 AM · 7:30 AM · 9:45 AM.**
   - Before each sync: `git fetch && git rebase origin/main`, run your lane's checks, and open a PR into `main`.
   - Merge order: P1 → P2 → P3 → P4 → HW.
   - After each merge, the orchestrator smoke-tests the gate.
6. **Update `plans/status/<lane>.md` at every sync:** done / doing / blocked / needs.
7. **Feature freeze is 10:00 AM Sunday.** After that, only `fix(demo):` commits approved by P1.

## Gate checklists (the orchestrator runs these after each merge)
**Gate 0, 9:00 PM: skeleton**
- [ ] `pnpm -r test` and `pnpm contracts:validate` pass
- [ ] `apps/db` publishes to `dcos-dev`, imports `@dcos/physics` (or the `sync:physics` fallback is decided), and generates bindings into `packages/db-client`
- [ ] The agent's NIM smoke test returns a valid tool call for `get_job_state`
- [ ] `apps/web` renders the 8×8 heat map from P1's mock fixture

**Gate 1, 11:30 PM: world with no AI**
- [ ] `create_run('run-demo-1', 42, 'gpu_demo_8')` seeds 64 GPUs and 3 jobs. Ticks advance `sim_time_ms`.
- [ ] `inject_fault` pump-a degradation at **610,000 ms** (run start + 10 s; CONTRACTS §0.12 #2): racks r2–r4 heat up, and GPUs over 85 °C throttle.
- [ ] XID 79 on `gpu-r3-n1-0`: `job-a` fails back to `durable_work_units`, and the signal event appears.
- [ ] The browser shows all of this live from SpacetimeDB.

**Gate 2, 1:30 AM: durable manual actions**
- [ ] Manual checkpoint: requested → claimed → running → succeeded across ticks.
- [ ] Retrying the same `command_key` 10× gives exactly one checkpoint.
- [ ] A move onto `rack-r6` is denied with `DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT`. A stale epoch is denied with `STALE_DECISION_EPOCH`.
- [ ] Killing the caller mid-checkpoint doesn't cancel it; a stale fencing token is rejected.

**Gate 3, 4:30 AM: agent + overlap + crash** → tag `tier1`
- [ ] Pump fault → the agent opens one incident tied to evidence IDs, scores keep/cap/move with `simulatePlan`, and executes.
- [ ] XID 79 on the destination: a second incident opens, the plan is superseded, and the agent replans with no double allocation.
- [ ] Kill the agent during the checkpoint, then restart: it reconciles by `command_key`, with no duplicate.
- [ ] The F-NV1 feed shows tool calls and summaries live.

**Gate 4, 8:30 AM: proof**
- [ ] At least 10 scenarios × {reactive, threshold, nemotron} with identical seeds, with `evaluation_result` rows written from real runs.
- [ ] The scoreboard renders them, including losses and needless moves.
- [ ] The 3-minute run-through works twice in a row.

## Driving Claude Code in your lane
Paste this into Claude Code from your repo checkout:

    Read PLAN.md, plans/README.md, plans/CONTRACTS.md (§0 first) and plans/LANE-<X>.md.
    Do task <TASK-ID> exactly as written. Only edit files my lane owns. Do not change contracts
    (if one is needed, stop and write it in plans/status/<X>.md as "CONTRACT request").
    Run the task's "Done when" checks, commit "feat(<lane>): <task-id> <summary>", and report:
    files changed, how verified, open questions.

**Parallel sub-agents:**
- Run each in its own worktree: `git worktree add ../dcos-<lane>-<n> -b wt/<lane>-<n>-<topic>`.
- Every task in a lane file lists the files it owns, and tasks marked **‖** can run in parallel.
- Merge worktrees back into your lane branch yourself.

## Timeline (Sat → Sun)
| Time | Milestone |
|---|---|
| 7:45–9:00 PM | Gate 0; P1 fixtures at 8:45 |
| 9:00 PM | **Sync 1**, contracts frozen (additive after this) |
| 10:45 PM | **Devpost registered** (P4); track rules confirmed with organizers |
| 11:30 PM | **Sync 2, Gate 1** |
| 1:30 AM | **Sync 3, Gate 2**; P2 + P4 sleep 1:30–4:30 |
| 4:30 AM | **Sync 4, Gate 3**, tag `tier1`; P1 + P3 sleep 4:30–7:30 |
| 7:30 AM | **Sync 5**, everyone back; Gate 4 push; optional Gate 5 |
| 8:30 AM | Gate 4 passed; stop starting new features at 9:00 |
| 9:30 AM | Backup demo video recorded |
| 9:45 AM | **Sync 6** (final) |
| 10:00 AM | **Feature freeze** |
| 11:30 AM | **Submitted** (deadline 12:00) |
| 1:00–4:00 PM | Judging |

**If behind at 2:30 AM,** apply the cut order in `PLAN.md`. Never cut the overlap, crash recovery, the blocked action or the real baseline numbers.
