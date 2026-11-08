# P2-K4: Prod switch
**Due:** M4 08:30, with Suvan · **Gate:** 3, 4 · **Status:** ☐ · **Depends on:** Suvan's approval of `int/r-sprint` → `main` · **Owns:** prod `dcos`, `plans/status/P2.md`

Spec: `KAUSHIK.md` K4, team README rules 2 and 6, SCOPE §5.

## Goal
Prod runs the approved `main`, the agent can act on it, and each rehearsal starts clean.

**Every step changes the live demo database. Kaushik gives an explicit go before each publish and reset.** Nobody resets prod before M4.

## Steps
1. Confirm the approved `main` commit with Suvan. Use a clean checkout. Node 22, `pnpm install --frozen-lockfile`.
2. Publish, with **no data-clearing flag**:
   `pnpm --filter db build:physics`, then from `apps/db`: `spacetime publish -s maincloud dcos --yes=remote`
3. Grant the agent role (preferred over passing prod tokens around):
   `spacetime call -s maincloud dcos grant_role '{"__identity__":"0xc200188f5b9a75fbc8d3bfc5b5f3d04f601c7261506fa0e9bf017f130ec740ca"}' '"agent"'`
   Confirm with `SELECT * FROM role_grant`. If a token must move instead, hand it over out of band only.
4. **Measured results (see Open item):** the scoreboard build reads `VITE_STDB_DB=dcos`, so the S6 rows must exist on prod. Publish from the saved batch artifact and read back.
5. Before **each** rehearsal: stop the agent and wait for it to exit, close old clients, then `reset-run.ts dcos --confirm-prod`, then start a fresh agent. `KAUSHIK.md` omits the stop step; SCOPE §5 requires it.

## Open item with Suvan
- Nobody is assigned to publish the S6 rows to prod. S6 publishes at M3, before prod has the provenance-aware module. **Default: Suvan's batch tool runs against `dcos` right after step 3.**
- Check that those rows don't use `run_id: run-demo-1`. `create_run` deletes evaluation rows with the reset run's ID (`run.ts:88`), so a rehearsal reset would wipe the scoreboard.

## Done when
- [ ] `dcos` runs the recorded approved commit; roles intact
- [ ] Agent identity has `agent` on `dcos`
- [ ] Measured rows on `dcos` match the artifact and survive a reset
- [ ] Reset produces a clean run with the agent stopped
- [ ] Published commit and time recorded in `plans/status/P2.md`; no token in git or chat

## Architect notes (Codex)

## Implementation report (Claude)
