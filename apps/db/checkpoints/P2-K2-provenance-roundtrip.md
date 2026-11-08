# P2-K2: R0, provenance round-trip
**Due:** merged before the M2 05:00 republish · **Gate:** 4 · **Status:** ☐ · **Depends on:** S1 schema, available on `origin/r/r0-provenance` · **Owns:** `apps/db/src/evaluation.ts`, `packages/db-client/src/live.ts`, `packages/db-client/test/`, `apps/db/scripts/provenance-roundtrip.ts` (new)

Spec: TASKS R0 steps 4-5, CONTRACTS §0.14. Don't edit `packages/contracts`. Requests go to Suvan.

## Goal
One measured row survives publish and read-back unchanged, old rows read as "provenance unavailable", and bad rows are refused.

## What the code does today (checked at `777b2bf`)
The work is smaller than `KAUSHIK.md` suggests, with one real bug:
- **Storing already works.** `evaluation.ts:23` spreads everything else into `metrics_json`, so `provenance` is kept automatically.
- **Live read-back already works.** `toEvaluation` spreads `metrics_json` back.
- **Validators need no code.** The module and mock both call `validatePayload`, which picks up S1's schema.
- **Columns need work.** `evaluation.ts:32-33` writes `''` and the module's own `GPU_MODEL_VERSION`.
- **Bug:** `live.ts:242` falls back to **all zeros** if `metrics_json` can't be parsed. That breaks "unknown is not zero" (SCOPE §7).
- **The module bundles the validator.** `dcos-dev` and prod reject provenance rows until each is republished, so K2 must be in `int/r-sprint` before the M2 republish or K3 has to publish twice.

## Steps
1. `git fetch origin && git merge origin/r/r0-provenance`. Without it this can't typecheck, and a handwritten type isn't allowed. If the checker requests fixes they land on that same branch, so fetch and merge again before calling K2 done. After merging, confirm `packages/contracts` really has `provenance` and re-check the "Validators need no code" claim above against the merged schema; update the client validators or mock if anything still rejects it.
2. `evaluation.ts`: `policy_version: prov?.policy_version ?? ''` and `physics_profile_version: prov?.physics_profile_version ?? ''` (Decision 2). Update the header comment and remove the unused import.
3. `live.ts`: `toEvaluation` returns `null` for unparseable or schema-invalid rows, logs a warning, and `onEvaluation` filters them out. Remove the zero defaults.
4. Mock and vitest: old row reads back with no `provenance`, new row deep-equals the input, malformed rows throw `INVALID_PAYLOAD` (missing field, extra field, negative count, bad `trace_sha256`). Add a `toEvaluation` test for corrupt `metrics_json`.
5. `provenance-roundtrip.ts`: over live `connect()`, publish, wait for `onEvaluation`, deep-compare. Also confirm both columns with `spacetime sql`.

**Test-row safety:** the table upserts on `(scenario_id, policy, seed)`, so a real scenario ID would overwrite measured results. Use `scenario_id: zz-provenance-{old,new}` and `run_id: run-demo-1`, so the next reset removes them. There's no delete reducer.

## Decision 2 (Kaushik)
When a row has no provenance, should `physics_profile_version` be `''` or stay the module's version?
**Default: `''`.** The module version says what's deployed now, not what computed the row. TASKS R0.4 asks legacy rows to stay explicitly unknown. Nothing reads this column today.

## Done when
- [x] Vitest passes for old, new and malformed rows, plus the corrupt-JSON case
- [x] Live round-trip passes on `dcos-r-local`
- [ ] Merged to `int/r-sprint` before K3's republish
- [ ] Re-run on `dcos-dev` during K3, then test rows cleared by the reset
- [x] No credentials in any output or artifact

"Export" in TASKS R0 means comparison against the saved artifact. That part belongs to S6, which reads rows back and matches them.

## Architect notes (Codex)
Read-only review. No provenance or validation bugs found. Three items, none changed:
- **Prod guard matches only the name `dcos`, not its hex identity.** Someone would have to type the identity on purpose; the guard is for accidents.
- **The script resets `run-demo-1`, deleting its rows.** By design and in the header. See the caution in K3.
- **Mock `onWorkflows` doesn't reflect incident links added by `upsertIncident`.** Mock only; the agent writes `incident_ids` through workflow state anyway.

## Implementation report (Claude)
**Status: ◐ merge-ready (2026-11-08). Open: the merge, and the `dcos-dev` re-run in K3.**
Merged `origin/r/r0-provenance` (`221fd39`). The merged schema was checked: `provenance` is strict and `validatePayload` accepts it in both the module and mock, so no validator code was needed.

- `apps/db/src/evaluation.ts`: fills both version columns from provenance; empty when absent (Decision 2: default accepted).
- `packages/db-client/src/live.ts`: `toEvaluation` drops an unreadable or invalid row with a warning instead of zero-filling.
- `apps/db/scripts/provenance-roundtrip.ts`: live proof; requires a DB argument, refuses prod, uses `zz-*` IDs and resets before and after.

**Verified:** `pnpm -r test` 740 pass; typecheck clean; the live script passes on `dcos-r-local`: new and old rows, both columns, and 4 malformed rows rejected. Not yet run on `dcos-dev`.
