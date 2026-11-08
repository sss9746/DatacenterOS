# P2-8: Prod database + identities + offline fallback
**Due:** 4:30 AM · **Gate:** 3 · **Status:** ☐ · **Owns:** `apps/db/scripts/bootstrap.ts`

## Goal
P3 and P4 run against the real `dcos` database with their own tokens, and we can run the demo offline if Maincloud is down.

## Steps
1. Publish `dcos` from a **gate-passing commit** only.
2. `bootstrap.ts`: mint identities with `POST /v1/identity` for **admin**, **agent**, **gateway**; `grant_role` each; `create_run('run-demo-1', 42, 'gpu_demo_8')`. Prints tokens to stdout only, **never writes them to a tracked file**.
3. Post tokens in team chat (`STDB_ADMIN_TOKEN`, `STDB_AGENT_TOKEN`, `STDB_GATEWAY_TOKEN`). They go into each person's `.env.local`.
4. Offline rehearsal on the demo laptop: `spacetime start` + `spacetime publish -s local dcos` + bootstrap against local.
5. `/cso` security pass over role checks and private tables before tokens go out.

## Done when
- [ ] P3's agent and P4's dashboard work against `dcos` with real tokens
- [ ] Offline local run works end to end
- [ ] `git grep` finds no token in the repo

## Architect notes (Codex)

## Implementation report (Claude)
