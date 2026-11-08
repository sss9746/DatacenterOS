# P2-K3: Republish `dcos-dev` and a controlled reset
**Due:** M2 05:00 · **Gate:** 2, 3 · **Status:** ☐ · **Depends on:** R1, K1, K2 merged to `int/r-sprint`; full suite green · **Owns:** `packages/db-client/src/reset.ts` (new), `apps/db/scripts/reset-run.ts` (new), guards in `gate2.ts` and the smoke scripts

Spec: `KAUSHIK.md` K3, SCOPE §5-6, CONTRACTS §0.13 #8, TASKS R5.

## Goal
R1's physics and K1/K2 go live on the dev database, and Suvan's R5 harness gets a reset that can't hit prod or race a live agent.

## What the code does today (checked at `777b2bf`)
- `create_run` doesn't touch `role_grant` (`run.ts:62-94`), so the agent keeps its role through a reset. K3 still proves it with one query.
- `publish:dev` has no data-clearing flag. Never add one: a cleared database re-runs `init`, which grants admin to the owner only and loses every other role.
- `nextFencingToken` is the max of existing rows, so it restarts after a reset. A surviving old agent could hold a valid-looking token. That's why the agent must be gone first.
- `world_state` JSON survives a publish, so R1 physics would inherit a run written by old code. Reset after publishing.
- `gate2.ts` and both smoke scripts accept `dcos` as an argument and reset the run.

## Steps
**Prepare (any time before M2, on the K-branch)**
1. `controlledReset(client, { db, runId, seed })` in `db-client`:
   - throws if `db === 'dcos'` unless `allowProd: true`
   - waits up to 20 s for every open workflow's lease to expire (default lease is 15 s), and fails with a clear "an agent is still heartbeating" message otherwise
   - calls `createRun`, waits for `tick_index > 0`, then asserts 64 GPUs, 3 jobs, 0 actions, 0 workflows
2. `reset-run.ts <db> [--confirm-prod]`: a thin CLI wrapper.
3. `gate2.ts`, `ledger-smoke.mjs`, `workflow-smoke.mjs`: refuse `dcos` outright. A check never resets prod.
4. Tell Suvan the import path. The harness still owns stopping its agent child and awaiting exit before calling this.

**Republish (M2, holding the `dcos-dev` lock)**
5. Post "taking dev" in team chat.
6. Use a clean checkout of `origin/int/r-sprint` and record the commit. Node 22. `pnpm install --frozen-lockfile`, then `pnpm --filter db publish:dev`.
7. Bindings only need regenerating if the schema changed. K1 and K2 don't change it.
8. Run `reset-run.ts dcos-dev`, then `pnpm --filter db gate2 dcos-dev`, `smoke:ledger`, `smoke:workflow` and the K2 round-trip.
9. Finish with a clean reset. Confirm the role: `spacetime sql -s maincloud dcos-dev "SELECT * FROM role_grant"` lists `0xc200188f…40ca` as `agent`.
10. Post "releasing dev" and ping Suvan.

## Done when
- [ ] `controlledReset` refuses prod and fails while a lease is live (tests)
- [ ] `dcos-dev` runs a recorded `int/r-sprint` commit
- [ ] Gate 2, both smokes and the K2 round-trip pass there (closes K1 and K2)
- [ ] Agent identity still has `agent` after the reset
- [ ] Module version, DB, time and commit recorded in `plans/status/P2.md`

## Architect notes (Codex)

## Implementation report (Claude)
