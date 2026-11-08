# Implementation evidence audit — 2026-11-08

## Audit boundary

Read-only source/checkpoint audit against fetched **`origin/main` `95e1abd`**, plus local **`lane/p2-db` `b2678c4`**. Main has agent/web/evaluation packages that are absent from the P2 checkout. Absence on this lane is not evidence that the team has not implemented them. No live database was reset, queried or republished during this planning audit. No new full test-suite run is claimed.

Evidence classes: **source** = implementation inspected; **reported test/live** = dated checkpoint report; **remaining** = proof or implementation not found. The recorded 697-test suite (15 contracts, 24 client, 353 physics, 9 evaluation, 290 agent, 6 web) is historical evidence in `plans/status/P2.md`, not a fresh run of this audit.

## R-sprint integration on `int/r-sprint` (2026-11-08, base `origin/main` `777b2bf`)

Merged no-ff, in order: `r/r0-provenance` (R0 step 3, S1), `r/r1-completion` (R1, S2), `r/r6-eval-adapter` (R6 adapter + counters, S4), `r/r3-verify-handoff` (R3, S3). No conflicts. Kaushik's R2 (`start_action` blocking any nonempty violations) was **not yet** on `origin/lane/p2-db` (its head `cf56397` is an ancestor of main); `start_action` still rechecks only `decision === 'deny'`.

| Gate at the integrated commit | Measured result |
|---|---|
| `pnpm --filter @dcos/physics build` | clean |
| `pnpm -r test` | 766 passed, 0 failed: contracts 23, db-client 24, physics 370, evaluation 19, agent 324, web 6 |
| `tsc --noEmit` in contracts, physics, db-client, agent, db, evaluation, web | clean in all seven |
| `python packages/contracts/schema/validate_contracts.py` | all 7 fixtures valid (incl. `evaluation_result_provenance`) |
| `pnpm --filter @dcos/web build` | built (one >500 kB chunk warning, pre-existing) |
| `apps/agent/scripts/crash-test.ts` | 5/5 kill points PASS (in-memory fakes; not live crash evidence) |
| `apps/agent/scripts/demo-local.ts` | DEMO OK (6/6 checks; deterministic, no NIM key read) |
| `evaluate --cases fixed12 --no-llm` | 36/36 validated rows, every row with provenance, 12 matched groups; artifact `apps/evaluation/results/deterministic-fixed12-2026-11-08/` (rows, traces, manifest, summary) at revision `c4b10b3` (the merge commit). **Deterministic-only:** Nemotron rows have `model_enabled: false`; this is a rehearsal, not a Nemotron performance claim. Gate 4 stays partial until a live or cached-replay NIM matrix exists |
| `apps/agent/eval-results/deterministic-2026-11-08.json` | regenerated with the merged physics: identical except `generated_at`, so it was not replaced (zero baseline drift from R1) |

Documented limits carried from the task reports: R1 leaves a thermal-shutdown latch derived on the exact checkpoint due tick able to complete that checkpoint (fatal XID/node-crash faults are covered), and completion freshness is scoped to destination GPUs. R3's `closeNoAction` still saves a no-action handoff as `recovered`/verified; `checkPowerCap` treats a missing `power_limit_w` as unverified instead of the 500 W default. The live NIM path of the evaluation adapter has no test. `apps/db` consumes `@dcos/physics` from its built `dist` (there is no `apps/db/src/physics` copy), so the physics build is the sync step; republishing `dcos-dev` from this branch remains Kaushik's step.

Integration follow-ups done here: `@dcos/physics` now exports `runScenarioDetailed`/`ScenarioRunDetails`; `summarizeResults` (shared by the web scoreboard) refuses mixed batch/revision/horizon or legacy-plus-provenance sets, reports per-policy mode labels from provenance and unfinished-job totals (null when any row lacks provenance); the scoreboard shows them; `publish_evaluation_result` fills `policy_version`/`physics_profile_version` from supplied provenance (R0 step 4; legacy rows unchanged). Live publish → read-back of a provenance row (R0 step 5) is not proven here: no database was touched.

## Implemented foundation

| Area | Inspected implementation | Evidence / remaining boundary |
|---|---|---|
| P1 physics | Fixed preset, GPU/job/checkpoint model, safety, plan estimates, policies, 20 scenarios, generated baseline results | `packages/physics/src/gpu/`; tests and fixtures. Numeric model is illustrative |
| P2 DB | Scheduled tick, roles/private world, projection, ledger, resource/workflow leases, fencing, incidents/plans/events | `apps/db/src/`; P2-7/8 report Gate 2 on dev/prod/local |
| P2 client | Mock/live client, subscriptions, admin actions, `onActionDetails`, evaluation publishing | `packages/db-client/src/`; P4 has not consumed every newer API |
| P3 agent | Actual NIM integration, triage, planner, coordinator, replan, resume, verifier, events, pure evaluation policy | `origin/main:apps/agent/src/`; P2-8 reports real pump recovery on dev/prod |
| P4 dashboard | Heat map, cooling/jobs, incidents/feed, ledger, fault panel, mock/live adapter, empty-until-measured scoreboard | `origin/main:apps/web/`; historical browser proof is mock; live gate unconfirmed |
| Evaluation | P1 detailed runner/baselines; P3 side-by-side script; P4 adapter/reporting/CLI boundary | No checked-in production adapter for P4 and no complete provenance-preserving matrix proof |
| Hardware | Reserved resources and UI no-data/stale states | No live ingestion reducer; optional |

## Concrete remaining gaps

| Finding | Evidence in audited source | Required task |
|---|---|---|
| Start recheck only blocks `deny`, permitting newly stale evidence returned as `needs_approval` | `apps/db/src/actions.ts`, `start_action` | R2: align violation handling with request-time checks |
| Restart completion checks status/fatal GPU loss, but lacks the phase-specific thermal/power/storage/freshness checks the architecture promises | `packages/physics/src/gpu/actions.ts`, `completeCommand`; DB `settleActions` trusts the result | R1: completion semantics and shared simulation regressions |
| Several actions are marked verified from ledger success alone; migrate verification omits relevant data freshness | `apps/agent/src/verify.ts`, `checkOther`, `checkMigrate` | R3: operation-specific read-back and honest handoff |
| Five-boundary agent crash script uses FakeDb/FakePhysics; P2 SIGKILL only proves caller-independent action completion | `apps/agent/scripts/crash-test.ts`; `apps/db/scripts/gate2.ts` | R5: actual orchestrator kill/restart plus destination fault |
| Ledger UI lacks newer typed operation/history/safety projection; activity is selected globally rather than per workflow | `apps/web/src/data/dashboard.ts`; feed renderer | R4: consume `onActionDetails`, show per-workflow activity, prove live UI |
| Evaluation CLI requires an external adapter; P1 default run IDs differ by policy while P4 requires one comparison ID | `apps/evaluation/src/main.ts`, `runner.ts`; `packages/physics/src/gpu/run.ts` | R6: checked-in adapter and correct identity |
| “nemotron” results may use zero NIM calls or fall back after a request budget | `apps/agent/scripts/eval-side-by-side.ts`, `src/policy.ts` | R0/R6: per-case provenance, mode labels and measured matrix |
| Wire result lacks provenance and unfinished jobs; runner already computes unfinished IDs correctly | `packages/contracts/schema/contracts.schema.json`; `runScenarioDetailed().details` | R0/R6: additive provenance path, no duplicate measurement implementation |

Additional limits: normal link-down has no modeled workload effect; sensor freezing is implemented for GPUs despite broader accepted target kinds; preset power figures are GPU-only and lack facility budget values; scheduled checkpoint interval is descriptive rather than automatic. Keep these limitations visible in scope and controls.

## Product gates, with evidence boundaries

| Gate | Current evidence | What still closes it |
|---|---|---|
| 0 — skeleton | Packages, working NIM reported, mock UI and tests reported | Recheck chosen integrated commit/build before rehearsal |
| 1 — autonomous world | Heat/Xid/tick verified in P2 reports | P4 records live browser updates from actual DB |
| 2 — durable manual actions | P2-7/8 report retries/fencing/checkpoint-after-SIGKILL on dev/prod/local | Fix R1/R2 gaps; show actual manual BLOCKED result and lifecycle in live UI |
| 3 — overlap + real agent restart | Pump-only real NIM recovery reported; fake-backed crash tests and live caller-kill test exist | R3/R5 complete real combined recovery with two incidents and verified handoff |
| 4 — measured comparison | Baseline fixtures and evaluator scaffolds exist | R0/R6: model provenance, matched matrix, published/read-back results and scoreboard |
| 5 — hardware | Placeholders only | Optional ingestion/collector proof after gates 1–4 |

Do not describe Gate 3 as complete merely because a pump-only recovery worked. Do not invalidate the useful existing evidence either: P2 durability and real NIM integration have already been demonstrated separately.

## Planning reconciliation

- P4's older status/handoff says live client, physics exports, clocks and loop rows are missing. Those dependencies are now available on main; the remaining tasks are consumption and verification.
- Main already contains P3 and P4; start from the integrator's current main, not by recreating packages on the P2 lane.
- P2-0…8 reports are retained as dated implementation history. P2-4/8 still require live dashboard confirmation; P2-9 remains optional.
- This planning revision changes documentation only. Proposed fixes and additive provenance are **not implemented** by the plan itself.

Next work is tracked by owner, dependency and acceptance in [IMPLEMENTATION-TASKS.md](IMPLEMENTATION-TASKS.md).
