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
- [x] Publish succeeds
- [x] `spacetime sql -s maincloud dcos-dev "SELECT * FROM run"` works
- [x] `ping` callable: `spacetime call -s maincloud dcos-dev ping`
- [x] Bindings exist in `packages/db-client/src/generated/` and type-check
- [x] Physics import decision (direct import vs `sync:physics`) written in `plans/status/P2.md`

## Risks
- SpacetimeDB modules don't run in Node: no `fs`, `process`, `Date.now()`. Physics must be pure (P1's rule says it is).
- Workspace `.ts` source imports may need a bundler config; this is booth question 3.

## Architect notes (Codex)
Review of the uncommitted scaffold (codex exec, read-only):
- [P2] `generate` script omitted `build:physics`; fails on a clean checkout. **Fixed.**
- [P3] Physics import decision was blank in `plans/status/P2.md`. **Fixed.**

## Implementation report (Claude)
**Files**
- `apps/db/{package.json,spacetime.json,tsconfig.json,src/index.ts}`: module root is `apps/db` (`module-path "."`), so `sync:physics` would still land in `apps/db/src/physics/` if ever needed.
- `packages/db-client/{package.json,tsconfig.json,src/index.ts}` + `src/generated/**`: minimal package so the bindings type-check; P2-2 builds the wrapper on it.
- `pnpm-lock.yaml`: changed because two workspace packages were added (root file, integrator-owned; unavoidable).

**Decisions**
- `@dcos/physics` imported directly from `dist/`; scripts `build`, `publish:dev`, `generate` all run `pnpm build:physics` first.
- `run` columns are snake_case and integer counters are `u32` (JS `number`, matches `@dcos/contracts`; u32 ms ≈ 49 sim-days). Generated client fields are camelCase (`simTimeMs`, `.name("sim_time_ms")`), so the P2-2 wrapper maps to contract snake_case.
- `run` already has every §B column plus `speed`, so P2-3 is additive.
- `publish:dev` uses `--yes=remote`. Bare `--yes` also auto-confirms **delete-data**; never use it.

**Verified**
- `pnpm --filter db publish:dev` → database `dcos-dev` created (identity `c20012db…18bb`).
- `spacetime call -s maincloud dcos-dev ping` → log `pong: physics rng sample 0.6011…` (physics runs in-module).
- `SELECT * FROM run` returns the empty table with all columns.
- `tsc --noEmit` passes for `db` and `@dcos/db-client`; `pnpm -r test` still green (15 + 92).

**Open questions**
- `@dcos/contracts` `validatePayload` uses ajv, which compiles validators with `new Function`. That may be blocked inside the SpacetimeDB runtime; test it at the start of P2-3, and fall back to precompiled (standalone) validators if needed.
