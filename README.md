# DataCenterOS

> **Build any data center. Break anything, including the real fan on our table. Watch AI keep it running.**

HackUTD 2026 "Zero Day". A deterministic data-center physics engine, a live SpacetimeDB digital twin, a team of AI
agents that diagnose and fix failures behind a safety engine, and a real vibrating fan wired into the simulation.

> **WIP.** This README is a skeleton. Lane S (Suvan) owns it and pastes in the sections the other lanes provide.
> Plans live in [`plans/`](plans/README.md); [`plans/CONTRACTS.md`](plans/CONTRACTS.md) is the single source of truth.

## Repo layout & owners

| Path | Lane | Owner | What lives there |
|---|---|---|---|
| `packages/physics/` | S | Suvan | `@dcos/physics`: the pure, deterministic engine (compiler, step, actions, failures, simulate, checkAction, detect) + fixtures |
| `eval/` | S | Suvan | The 50-scenario evaluation (none / rules / agents) and its results |
| `scripts/sync-physics.mjs` | S | Suvan | Copies the physics source into the SpacetimeDB module (bundling fallback) |
| `plans/CONTRACTS.md`, root files | S | Suvan | Contracts, workspace, `.env.example`, `.gitignore`, `CODEOWNERS`, this README |
| `spacetime/module/`, `scripts/gen-bindings.sh`, `apps/web/src/module_bindings/` | B | Teammate B | The SpacetimeDB module, publishing, identities, generated bindings |
| `agents/` | C | Teammate C | The agents service (diagnose, plan, execute, handoff) on NVIDIA NIM |
| `apps/web/` (except `module_bindings/`), `docs/pitch/`, `docs/devpost.md` | D | Teammate D | The dashboard, facility builder and pitch |
| `hardware/`, `scripts/demo_check.py`, `qa/` | A | Whole team (claim in `plans/status/A.md`) | The real fan (ESP32 + IMU), fan ML bridge, QA |
| `plans/status/<lane>.md` | each | that lane | Status updates |

Only the owning lane edits a path (enforced by `CODEOWNERS`). Need a change elsewhere? Open an issue titled `REQUEST <lane>: …`.

## How to run (WIP)

Requirements: Node 22+, pnpm 10.

```bash
pnpm install
pnpm -F @dcos/physics build     # builds packages/physics/dist (ES2022 ESM + .d.ts)
pnpm -F @dcos/physics test      # vitest
node scripts/sync-physics.mjs --check   # is spacetime/module/src/physics up to date?
```

Copy `.env.example` to `.env.local` and fill in the values. Never commit tokens.

## SpacetimeDB module (Lane B)

_TODO: Lane B provides this section._

## Agents service (Lane C)

_TODO: Lane C provides this section._

## Dashboard & builder (Lane D)

_TODO: Lane D provides this section._

## Real fan hardware (Lane A)

_TODO: Lane A provides this section._

## Evaluation (Lane S)

_TODO: results from `eval/results/summary.json`._

## License

[MIT](LICENSE)
