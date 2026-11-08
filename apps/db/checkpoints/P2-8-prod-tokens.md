# P2-8: Prod database + identities + offline fallback
**Due:** 4:30 AM · **Gate:** 3 · **Status:** ◐ · **Owns:** `apps/db/scripts/bootstrap.ts`

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
**Status: ◐. Prod `dcos` is live (2026-11-08 00:23 CST); remaining: P3 / P4 smoke against `dcos` with their tokens.**

- **Prod `dcos`** published to Maincloud from `ca5d8d4` (Kaushik's OK) → `pnpm bootstrap dcos --create-run`: admin / agent / gateway granted + verified, tokens in `~/.dcos-tokens/dcos.env` → `pnpm gate2 dcos`: **GATE 2 ALL PASS on prod**. Role check with the minted tokens: agent reads the snapshot; agent `createRun` and gateway `pauseRun` → `UNAUTHORIZED`; admin `createRun` ok. Left a fresh run-demo-1 (ticking, epoch 0, no actions).

- **Tokens** (deviation from step 3, agreed earlier): `bootstrap.ts` never prints tokens and never posts them to chat. It writes `~/.dcos-tokens/<db>.env` (mode 600) and prints identities only. Kaushik hands each person their own token. Non-Maincloud servers write `<db>.<server>.env`, so local rehearsal tokens never shadow prod ones.
- **dcos-dev**: admin / agent / gateway minted and verified. P3's own identity `0xc200188f…40ca` also granted `agent` (on P3's request; checked in `role_grant`).
- **Offline rehearsal** (step 4) passed: `spacetime start` on 127.0.0.1:3000 → `spacetime publish -s local dcos` → `STDB_HTTP=http://127.0.0.1:3000 STDB_URI=ws://127.0.0.1:3000 STDB_SERVER=local pnpm bootstrap dcos --create-run` (3 grants verified) → `STDB_URI=ws://127.0.0.1:3000 pnpm gate2 dcos`: **GATE 2 ALL PASS offline**.
- **Live integration on dcos-dev with P3's agent** (origin/main `22a8c06` + this db-client, real Nemotron `nvidia/nemotron-3.5-lightning-30b-a3b`, agent token): pump-a fault → incident in 5 s → Nemotron diagnose + plan → job-a checkpoint succeeded → migrate r2+r3 → r1+r5 succeeded → verify 2/2 → incident `monitoring`, about 95 s wall at speed 2. No P3 shims, no blocked steps, 0 Nemotron failures.
- **/cso** (step 5), static run `1794117418889-8c5c6d3525bb2b1a` over `apps/db` + `packages/db-client`: **no supported findings in the assessed scope**. Partial: application/role/token checks done; dependencies, CI and scanners not run.
  - Every write reducer starts with `requireRole` (agent: ledger / workflow / incidents; admin: run / faults / evaluation / grant_role). `advance_tick` is scheduler-only. `ping` is unauthenticated but writes nothing.
  - `world_state`, `fault_injection_truth`, `tick_schedule`, `role_grant` are private. Public rows come from `toObserved(world)` only.
  - Fencing tokens are public by design (concurrency guards, not credentials; every reducer taking one also needs the agent role).
  - No JWT / `STDB_*_TOKEN=` value in any captured file. The redactor's hits were TODO text and key/value lookalikes.
  - Hardening notes (not findings): `nextFencingToken` restarts after a `create_run` wipe; anonymous `ping` costs a little energy per call.
- **Remaining**: hand out the prod tokens; P3 / P4 smoke against `dcos` (then tick "P3's agent and P4's dashboard work against `dcos`").
