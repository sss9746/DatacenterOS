# DataCenterOS

GPU training reliability rehearsal for HackUTD's NMC² “Mission: Keep the World Running” challenge, targeting NVIDIA and SpacetimeDB integrations.

A fixed simulated 64-GPU cluster exposes cooling and GPU failures. Nemotron assists incident assessment and recovery choice; deterministic simulation/safety evaluates options; SpacetimeDB stores live state, durable actions and workflow ownership. The dashboard presents job progress, evidence, blocked actions and operator handoff.

**Current scope has no topology editor.** Numeric physics is illustrative, and no real hardware repair/control is claimed. Actual model use and benchmark results must be disclosed.

## Implementation and plans

The audited `origin/main` commit `95e1abd` contains physics, DB/client, agent, dashboard and evaluation packages. Some lane checkouts contain only their dependencies. P2 reports real Nemotron pump recovery and durable-action checks; the combined live crash/overlap and complete benchmark gates still need evidence.

- [Master plan](PLAN.md)
- [Implementation status and evidence](plans/IMPLEMENTATION-STATUS.md)
- [Exact components, faults and features](plans/IMPLEMENTATION-SCOPE.md)
- [Remaining tasks R0–R7](plans/IMPLEMENTATION-TASKS.md)
- [Primary-source research](plans/RESEARCH.md)
- [Team/gates](plans/README.md) and [shared contracts](plans/CONTRACTS.md)

## Workspace

| Path | Responsibility |
|---|---|
| `packages/contracts/` | JSON Schema, generated types, payload validation |
| `packages/physics/` | Pure simulation, actions, safety, plan estimates, scenarios and baselines; old facility API under `/v0` |
| `apps/db/`, `packages/db-client/` | SpacetimeDB module, bindings, live/mock API, ledger and workflow durability |
| `apps/agent/` | NIM client, triage/planner/coordinator/replan/resume/verification and policy adapter |
| `apps/web/`, `apps/evaluation/` | Dashboard and benchmark orchestration/reporting |
| `hardware/` | Optional future sensor/real-GPU observation integration |
| `plans/` | Scope, evidence, research, contracts and lane tasks |

## Local checks

Requires Node22+, pnpm10 and Python with jsonschema for the validator. Follow package scripts for each app; build physics before DB/Node consumers.

```sh
pnpm install
pnpm --filter @dcos/physics build
pnpm -r test
pnpm contracts:validate
```

Copy `.env.example` to `.env.local` for local configuration. Keep credentials out of commits and public frontend bundles. Live gate scripts can reset their target run; use an explicitly designated dev/local database and the task-specific rehearsal procedure.

## License

[MIT](LICENSE)
