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
- [ ] Branch is at `origin/int/r-sprint` and the commit is recorded
- [ ] Baseline test and typecheck counts recorded below
- [ ] `STDB_SERVER=local pnpm --filter db smoke:ledger dcos-r-local` passes
- [ ] `STDB_URI=ws://127.0.0.1:3000 pnpm --filter db gate2 dcos-r-local` passes

## Architect notes (Codex)

## Implementation report (Claude)
