# P2-K0: Branch, baseline and a private local target
**Due:** before K1 · **Gate:** none · **Status:** ☐ · **Owns:** `apps/db/scripts/{ledger,workflow}-smoke.mjs` (server arg only), `plans/status/P2.md`

## Goal
Start from the integrated code, record real test counts, and have a local database so K1 can be tested without touching the shared `dcos-dev`.

## Why this exists
- `lane/p2-db` is at `cf56397`, 66 commits behind `main`, so it has no agent, web or evaluation code. Sprint work starts from `origin/int/r-sprint`.
- `plans/team/KAUSHIK.md` names `lane/p2-db`. This sprint uses a new branch instead (Kaushik's request). It still merges into `int/r-sprint`.
- `connectCli()` defaults to `maincloud` and the smoke scripts never pass a server, so they can't reach a local DB today.
- Shell default is Node 20.19.6. The repo needs Node 22.

## Steps
1. Kaushik creates the branch (command in the hand-off message).
2. `source ~/.nvm/nvm.sh && nvm use 22`, then `pnpm install --frozen-lockfile` and `pnpm --filter @dcos/physics build`.
3. Record the baseline at the branch commit: `pnpm -r test`, plus `typecheck` for `db` and `@dcos/db-client`. Write actual counts. Do not copy the historical 697.
4. Pass the server through both smoke scripts: `connectCli(DB, process.env.STDB_SERVER ?? 'maincloud')`.
5. Bring up the local target with a name that **does not exist on Maincloud**:
   - `spacetime start`
   - from `apps/db`: `spacetime publish -s local dcos-r-local`
   - `STDB_HTTP=http://127.0.0.1:3000 STDB_URI=ws://127.0.0.1:3000 STDB_SERVER=local pnpm bootstrap dcos-r-local --create-run`

Do not name the local DB `dcos` as the P2-8 rehearsal did. `gate2.ts` picks its server from `STDB_URI`, so a forgotten env var would reset prod.

## Done when
- [x] Branch is at `origin/int/r-sprint` and the commit is recorded
- [x] Baseline test and typecheck counts recorded below
- [x] `STDB_SERVER=local pnpm --filter db smoke:ledger dcos-r-local` passes
- [x] `STDB_URI=ws://127.0.0.1:3000 pnpm --filter db gate2 dcos-r-local` passes

## Architect notes (Codex)

## Implementation report (Claude)
**Status: ☑ (2026-11-08).** Branch `lane/p2-r-sprint` at `9897e0b` (base `777b2bf`). Node 22.23.4, pnpm 10.29.3, SpacetimeDB CLI 2.14.1, lockfile sha256 `e15088ba9015…`.

| Package | Tests |
|---|---|
| contracts | 15 |
| db-client | 24 |
| physics | 353 |
| evaluation | 9 |
| agent | 304 |
| web | 6 |
| **Total** | **711** |

`db` and `@dcos/db-client` typecheck clean. Only change: both smoke scripts now read `STDB_SERVER`, default `maincloud`. Local target `dcos-r-local` published and bootstrapped; tokens in `~/.dcos-tokens/dcos-r-local.local.env`. `smoke:ledger` and Gate 2 pass on it before any K1 change. `smoke:workflow` was not run in K0.
