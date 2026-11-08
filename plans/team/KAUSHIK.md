# Kaushik (P2): database, client, live infrastructure

You own `apps/db/**` and `packages/db-client/**` and work on `lane/p2-db`. Merge into `int/r-sprint` (cut from `main` at `80b1d6e`), not into `main`. Specs: [TASKS](../IMPLEMENTATION-TASKS.md) R0 (steps 4–5) and R2, and [SCOPE](../IMPLEMENTATION-SCOPE.md) §4 "Required safety repairs" and §5. You also hold the **`dcos-dev` lock** (see [README](README.md) rule 2).

## K1: R2, fail closed at start (start now; target M1 03:30)

`start_action` currently rejects only `recheck.decision === 'deny'` (`apps/db/src/actions.ts:373`). Make it reject on **any nonempty violation list**, matching the request-time rule at line 226. That includes `EVIDENCE_STALE` and stale versions that appear between accept and start.
- On rejection: record `failed` / `SAFETY_REJECTED` with the violations and evidence, release the claim's reservations, and enqueue nothing.
- A `needs_approval` with no violations still follows CONTRACTS §0.11 #17.
- Mirror the behavior in the mock client if it differs.

**Done when:**
- An accepted migration is claimed, a `sensor_stale` fault ages the GPU past 10 sim-s, and start then fails with `EVIDENCE_STALE`, with no allocation and no command effect.
- Tests cover stale versions, the job's own lease being excluded, and a normal successful start.
- Gate 2 is re-run on `dcos-dev` after R1 is merged. **Never reset prod for a check.**

## K2: R0, provenance round-trip (after Suvan's schema lands at M1)

Suvan adds optional `EvaluationResult.provenance` to `packages/contracts` (CONTRACTS §0.14). You:
1. Preserve the object inside the existing `metrics_json`, and fill the existing `policy_version` / `physics_profile_version` columns from it when present. Legacy rows read back as provenance **unavailable**. No new table or column.
2. Update the db-client validators and the mock read-back so new rows aren't rejected by `additionalProperties:false`.
3. Prove one measured row survives publish → `onEvaluation` → export, unchanged.

**Done when:** a round-trip test passes for an old row, a new row and a malformed row (the malformed one is rejected).

## K3: republish and DB support (M2 05:00 and on request)

- **Republish `dcos-dev` from `int/r-sprint` after R1 merges.** The physics runs inside the module, so R1's safety fixes have no live effect until you do.
- Give Suvan's R5 harness a safe **controlled reset** path: stop the agent, drain its client, reset, then reconnect. Confirm the agent identity `0xc200188f…40ca` keeps the `agent` role on dev after the reset.
- If Karthik needs plan candidates or the handoff and the existing public projections don't expose them (TASKS R4.5), add a **typed read helper** over the existing tables in `db-client`. No new write endpoints.

## K4: prod switch (M4 08:30, together with Suvan)

1. Publish the approved `main` to prod `dcos`.
2. Grant the agent role:
   `spacetime call -s maincloud dcos grant_role '{"__identity__":"0xc200188f5b9a75fbc8d3bfc5b5f3d04f601c7261506fa0e9bf017f130ec740ca"}' '"agent"'`
   Or hand over prod tokens **out of band**, never in git or chat logs.
3. Do a clean reset of run-demo-1 right before each rehearsal.

## Report back (in `plans/status/P2.md`)

Commit hashes, test counts, module version published to which DB and when, plus any contract change you need. Contract changes go to Suvan; don't edit `packages/contracts` yourself.
