# DataCenterOS

> **When a GPU data center starts failing, Nemotron agents keep the training jobs alive.** They decide per job whether to keep running, cap power, or checkpoint and move; keep separate failures separate; and survive their own crash mid-recovery.

HackUTD 2026 "Zero Day", targeting the NMC², NVIDIA and SpacetimeDB tracks.
- A deterministic GPU-cluster digital twin: 64 GPUs, cooling loops, training jobs with checkpoints, NVIDIA XID faults.
- It runs live in SpacetimeDB with a durable action ledger.
- A Nemotron (NVIDIA NIM) orchestrator works behind a hard safety engine.
- It's evaluated against rule-based baselines on identical seeded scenarios.

**Plans:** start at [`PLAN.md`](PLAN.md), then [`plans/README.md`](plans/README.md). [`plans/CONTRACTS.md`](plans/CONTRACTS.md) §0 is the single source of shared names.

## Repo layout & owners
| Path | Lane | What lives there |
|---|---|---|
| `packages/contracts/` | Orchestrator | `@dcos/contracts`: JSON Schema v1.1.0, examples, validator, generated TS types |
| `packages/physics/` | P1 | `@dcos/physics`: pure simulation, `simulatePlan`, `evaluateSafety`, baseline policies, scenarios (v0 facility API kept under `/v0`) |
| `apps/db/`, `packages/db-client/` | P2 | SpacetimeDB TypeScript module + generated bindings / typed client / mock |
| `apps/agent/` | P3 (Suvan) | Node.js orchestrator on NVIDIA NIM (Nemotron), `nemotronPolicy` |
| `apps/web/`, `apps/evaluation/`, `docs/` | P4 | Dashboard, evaluation harness, pitch, Devpost |
| `hardware/` | everyone | Pico 2 W fan + gateway; real-GPU `nvidia-smi` collector |
| `plans/` | Orchestrator | Plans, architecture, contracts, status |

Only the owning lane edits a path. Need a change elsewhere? Open an issue titled `REQUEST <lane>: …`.

## Run
Requires Node 22+, pnpm 10 and Python 3 (for the schema validator).
```bash
pnpm install
pnpm -r test                 # physics + contracts
pnpm contracts:gen           # regenerate TS types from the JSON Schema
pnpm contracts:validate      # pip install jsonschema
```
Copy `.env.example` to `.env.local`. Never commit tokens.

## Sections each lane fills in
- **SpacetimeDB module (P2):** _TODO_
- **Agent (P3):** _TODO_
- **Dashboard + evaluation (P4):** _TODO; results come only from real runs_
- **Hardware (shared):** _TODO_

## License
[MIT](LICENSE)
