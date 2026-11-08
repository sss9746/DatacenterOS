# P2-1: Scaffold module, publish `dcos-dev`, generate bindings
**Due:** 9:00 PM · **Gate:** 0 · **Status:** ☐
**Owns:** `apps/db/**`, `packages/db-client/src/generated/**`

## Goal
A SpacetimeDB 2.x TypeScript module that publishes to Maincloud, imports `@dcos/physics`, and produces client bindings.

## Steps
1. `spacetime init --lang typescript` into a temp dir, then move the scaffold into `apps/db` (this folder already holds `checkpoints/`). Package name `db`.
2. Minimal schema: a `run` table (`run_id` PK + the Tier 1 columns from CONTRACTS §B, so P2-3 is additive) and a `ping` reducer.
3. **Physics import proof:** `import { buildPreset } from '@dcos/physics'` and call it from a reducer. If `buildPreset` isn't exported yet, import something that is (`makeRng`, `step`) to prove the bundling path; swap in `buildPreset` when P1 lands it.
4. `spacetime publish -s maincloud dcos-dev` (from `apps/db`).
5. `spacetime generate --lang typescript --out-dir packages/db-client/src/generated --project-path apps/db` (check the flag names with `--help`).
6. Record the physics import decision. If it doesn't bundle by **9:15 PM**: ask the integrator to run `pnpm sync:physics` (copies source to `apps/db/src/physics/`, committed, never hand-edited).

## Done when
- [ ] Publish succeeds
- [ ] `spacetime sql -s maincloud dcos-dev "SELECT * FROM run"` works
- [ ] `ping` callable: `spacetime call -s maincloud dcos-dev ping`
- [ ] Bindings exist in `packages/db-client/src/generated/` and type-check
- [ ] Physics import decision (direct import vs `sync:physics`) written in `plans/status/P2.md`

## Risks
- SpacetimeDB modules don't run in Node: no `fs`, `process`, `Date.now()`. Physics must be pure (P1's rule says it is).
- Workspace `.ts` source imports may need a bundler config; this is booth question 3.

## Architect notes (Codex)

## Implementation report (Claude)
