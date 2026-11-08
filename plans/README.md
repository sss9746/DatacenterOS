# Team implementation guide — fixed-cluster v4

**Current scope:** [IMPLEMENTATION-SCOPE.md](IMPLEMENTATION-SCOPE.md). **Start from evidence:** [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md). **Next tasks:** [IMPLEMENTATION-TASKS.md](IMPLEMENTATION-TASKS.md). This guide supersedes the original kickoff schedule; existing lane/checkpoint reports remain historical evidence.

**Real environment extension:** [Brev GPU telemetry and workload recovery implementation plan](REAL-ENVIRONMENT-IMPLEMENTATION.md) specifies the user-requested $60-credit integration, delivery levels, code changes and acceptance evidence. It is a proposal; the existing simulated environment and its proof gates remain distinct.

**Current sprint:** [Multi-agent fault recovery plan](MULTI-AGENT-HACKATHON-PLAN.md) adds three communicating model agents and recovery of stopped simulated jobs, on branch `Prod-Multi-Agent-System`. Its §0 is the execution plan and §0.9 tracks progress. As of 07:40 CST on Nov 8, team-mode Scene A and Scene B recovery have passed live on a local database; the regression runs and any `dcos-dev` run remain open. Brev remains observation-only for this sprint.

## Owners and integration

| Lane | Plan | Paths | Branch convention |
|---|---|---|---|
| Integrator (Suvan's coordinating session) | Root plan + R0/R7 | `plans/`, `packages/contracts/`, root config, `scripts/` | Integrates to `main` |
| P1 | [Simulation](LANE-P1-sim.md) | `packages/physics/` | `lane/p1-sim` |
| P2 (Kaushik) | [DB/durability](LANE-P2-db.md) | `apps/db/`, `packages/db-client/` | `lane/p2-db` |
| P3 (Suvan) | [Agent](LANE-P3-agent.md) | `apps/agent/` | `lane/p3-agent` |
| P4 | [Dashboard/evaluation](LANE-P4-web.md) | `apps/web/`, `apps/evaluation/`, `docs/`, `demo/` | Existing `P4` branch; do not recreate it just to match an old name |
| HW | [Optional observations](LANE-HW-shared.md) | `hardware/` | `lane/hw` |

Implementation stays in lane-owned paths; cross-lane interfaces go through the integrator. This user-requested planning revision updates all planning documents; it does not alter implementation ownership. Additive contract changes require schema/types/fixtures/consumers together. Never duplicate wire types or force-push main. Only the integrator merges software work to main.

At the audit, `origin/main` 95e1abd already contains P3/P4 code. A P2-only checkout is not the full product. Refresh from current main using the team's usual integration procedure before implementing R tasks; do not rebuild missing-on-this-branch packages.

## Reading and working rules

1. Read root [PLAN.md](../PLAN.md), status audit, scope, CONTRACTS §0 and your lane's R tasks.
2. Use the installed SDK/generated bindings; physics exports built `dist` while client/contracts source consumers use TS tooling. Build physics before DB/Node consumers. Use package scripts, not obsolete guessed commands.
3. Keep pure physics free of filesystem/network/wall-clock dependencies. NIM runs outside reducers. No private fault truth in agent inputs.
4. Work in small commits and lane-isolated worktrees when parallelizing. User-authorized planning changes do not require a new approval loop.
5. Record commit, checks, target DB and artifact paths in status. Mark **source present**, **unit checked**, **live reported**, and **live verified now** distinctly.
6. Do not commit tokens, `.env.local`, model secrets, node_modules or large recordings. Public web builds are read-only; local presenter mode carries admin controls.
7. Reset-bearing live tests explicitly name a disposable dev/local target. Stop the agent before reset and start fresh sessions afterward. No test defaults to prod.

## Gate evidence as of the audit

P2 reports Gate 2 on dev/prod/local and real pump recovery; main has integrated agent/web/evaluator code. Live browser proof, actual combined agent restart and the full measured model comparison remain open. The old 697-test result is historical, not a fresh run here.

## Acceptance gates

Gate checkboxes below are intentionally open until the final integrated commit has linked evidence. Existing partial evidence is preserved in the status audit and P2 checkpoints; this is not a claim that completed foundation work must be rebuilt.

### Gate 0 — integrated baseline (R0)

- [ ] Current main builds/typechecks using declared package scripts; workspace tests and contract validator pass.
- [ ] Actual configured NIM model returns validated tool calls; current DB module imports pure physics.
- [ ] Dashboard renders fixed 64-GPU preset; no topology editor is required.
- [ ] Optional provenance schema preserves old payloads and round-trips new metadata.

### Gate 1 — autonomous world + live browser (R4)

- [ ] Seed42 run starts at sim600000; scheduled ticks advance without client-driven world mutation.
- [ ] Pump-a degradation at start+10s heats its racks; UI shows actual live observations, age and model/source labels.
- [ ] Xid79 on an allocated GPU emits a signal and rolls its job back to durable work; unrelated unused-GPU loss does not fail other jobs.
- [ ] Browser disconnect/reconnect preserves honest stale state and rebuilds from DB.

### Gate 2 — safe durable actions (R1/R2/R4)

- [ ] Checkpoint lifecycle spans ticks; durable work changes only after a valid completed write.
- [ ] Ten identical retries yield one operation/checkpoint; changed payload under the same key is rejected.
- [ ] Hot r6/stale decision checks produce actual stable reasons and no invalid allocation.
- [ ] Stale evidence emerging before start is blocked; changed destination conditions before completion fail safely.
- [ ] Stale ownership rejected; running action survives caller SIGKILL; full reservations remain coherent.
- [ ] Live ledger shows operation, targets, safety evidence and history via `onActionDetails`.

### Gate 3 — actual orchestrator overlap/crash + handoff (R3/R5)

- [ ] Real NIM pump recovery reaches observed progress with actual model/code attribution.
- [ ] Destination Xid79 is triggered from the actual plan while source checkpoint is running; separate incident and correct replan.
- [ ] Actual orchestrator process is killed/restarted; it reconciles existing keys, completes recovery once, with no duplicate placement.
- [ ] Fresh postconditions verify recovery; persisted handoff names remaining infrastructure risk/human action.
- [ ] Browser displays both incidents and per-workflow waiting/replan/resume/verify states.

### Gate 4 — measured proof (R6/R7)

- [ ] Checked-in adapter runs the fixed 12-case matrix × three policies (all20 optional) on matched initial conditions.
- [ ] Per-case provenance includes actual live/cache/fallback usage, versions, horizon and unfinished jobs.
- [ ] Artifacts/read-back/scoreboard agree; partial/mixed batches and missing metadata are not falsely certified.
- [ ] Losses/ties, finite-horizon metric definitions and zero simulated decision latency are disclosed.
- [ ] Two complete rehearsals, measured duration, backup recording, deployment/submission evidence.

### Gate 5 — optional hardware

Only after required gates: authenticated/validated ingestion, explicit source/freshness, real GPU nonallocatable, fan-to-cooling demo mapping opt-in and labeled. No software acceptance depends on hardware.

## Implementation prompt

> Read PLAN.md, plans/IMPLEMENTATION-STATUS.md, plans/IMPLEMENTATION-SCOPE.md, plans/CONTRACTS.md §0 and my lane file. Implement task Rn from plans/IMPLEMENTATION-TASKS.md in owned paths. Reuse current code. Run its acceptance checks and update the lane report with commit/artifact evidence. Do not claim live proof from a mock or publish/reset prod to run a test.
