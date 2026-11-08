> **SUPERSEDED (03:45 Sun):** follow [RUNBOOK.md](RUNBOOK.md) instead. This file is the older per-lane split.

# Suvan + Claude orchestrator: the majority share

The Claude session orchestrates. Fable sub-agents take the hard tasks and Sonnet sub-agents take the well-specified ones. Every agent works in its own worktree off `int/r-sprint`. Nothing reaches `main` without Suvan's OK. Specs: [TASKS](../IMPLEMENTATION-TASKS.md) R0/R1/R3/R5/R6 and [SCOPE](../IMPLEMENTATION-SCOPE.md) §4, §6, §7.

> R1 sits in P1's `packages/physics` because P1 is not active on the new scope. If P1 comes back, they review R1 rather than rebuild it.

## Wave 1: parallel, start now (target M1 03:30 / M2 05:00)

| # | Task | Model | Owns (only these) | Done when |
|---|---|---|---|---|
| S1 | **R0 schema:** optional strict `EvaluationResult.provenance` per CONTRACTS §0.14, regenerated types, old and new fixtures validate | Sonnet | `packages/contracts/**` | `pnpm --filter @dcos/contracts test` green; an old row validates; a row with bad provenance is rejected. **Handed to Kaushik and Karthik at M1.** |
| S2 | **R1 phase-aware completion:** checkpoint completion and restart completion revalidate after this tick's faults (destination ownership excluding own reservations, health, freshness, predictive thermal/power, storage at start and finish); clean failure release; durable work kept | **Fable** | `packages/physics/src/gpu/{actions,safety,step}.ts`, physics tests, regenerated fixtures/baselines | The 6 R1 tests in TASKS pass; all physics tests green; metric changes listed in the report |
| S3 | **R3 verify + handoff:** read-back specific to each operation (migrate: 2 fresh samples over 10 sim-s, exact destination, predictive headroom; cap/pause/keep/checkpoint/escalate per TASKS R3); unverified when the clock is paused or data is stale; handoff persisted in workflow state, surviving a fresh connection; fallback events attributed to `code` | **Fable** | `apps/agent/src/{verify,coordinator,resume,replan,events}.ts`, agent tests | Tests reject stale/paused/ledger-only/repair-claim false positives; the handoff is read back by a fresh agent; agent suite green |
| S4 | **R6 adapter + counters:** checked-in `apps/evaluation/src/team-adapter.ts` (`loadScenarios`, `runScenarioDetailed`, real baselines, a **fresh** `createNemotronPolicy` per case, one `run_id` shared by all three policies in a case); per-case counters in `policy.ts` (requests, live responses, cache hits, fallbacks, wall ms) captured before disposal; CLI writes rows + traces + manifest | Sonnet | `apps/evaluation/src/**`, `apps/agent/src/policy.ts` (counters only) | `pnpm --filter evaluation eval -- --cases 12 --no-llm` writes 36 valid rows with provenance; `unfinished_job_ids` taken from detailed results, never zero-filled |

S2 and S3 both touch agent/physics behavior. S3 codes against the R1 semantics written in SCOPE §4, not against the current code.

## Integration (orchestrator, M2 05:00)

1. Merge S1 → S2 → S4 → S3 and Kaushik's R2 into `int/r-sprint`. Fix the integration breaks (last time, the stale-epoch bug showed up only at this step).
2. Build physics first, then run everything: `pnpm -r test`, `pnpm -r exec tsc --noEmit`, the web build, crash-test 5/5, demo-local.
3. Ping Kaushik to republish `dcos-dev` from `int/r-sprint`.

## Wave 2: sequential, on `dcos-dev` (target M3 07:00)

| # | Task | Model | Owns | Done when |
|---|---|---|---|---|
| S5 | **R5 live recovery harness**, `apps/agent/scripts/live-recovery-test.ts`: an explicit `--db dcos-dev` (refuses prod), a controlled reset with the agent stopped, seed 42, a real agent **child process**, waiting on subscribed states (no fixed sleeps), bounded timeouts, redacted logs. Cases **L1** SIGKILL during checkpoint → restart reclaims; **L2** XID 79 on the **actual planned destination** during the source write; **L3** L1+L2 combined (the centerpiece). L4–L6 use deterministic controls on the real ledger | **Fable** | `apps/agent/scripts/live-recovery-test.ts`, `apps/agent/test/live/**` | Machine-readable JSON + a short report: commit, DB, seed, model, sim/wall times, command keys, unique allocations, checkpoint count, verification. Karthik's browser witness attached |
| S6 | **Real Nemotron matrix:** the fixed 12 cases (`sc01 sc03 sc04 sc05 sc07 sc08 sc09 sc10 sc11 sc13 sc14 sc17`) × 3 policies with live NIM; **not** at the same time as S5 | Sonnet | `apps/evaluation/results/<batch>/` | ≥36 validated rows, each with provenance; fallback count disclosed; published, then read back and matched. **Handed to Karthik.** |

## Wave 3 (M4 08:30)

- **S7:** one `skilled-reviewer` agent runs `/review` on `main..int/r-sprint`; fix CRITICAL and HIGH findings only.
- Suvan approves `int/r-sprint` → `main`; switch to prod `dcos` together with Kaushik; rehearsal #1 together with Karthik.

## Pitch claims Suvan can make (only once the proof exists)

| Claim | Requires |
|---|---|
| "Agent crashed mid-recovery, a fresh process finished it with no duplicate actions" | S5 L1/L3 report |
| "Kept two failures separate" | S5 L2/L3 report + the browser witness |
| "X% less lost work than threshold, with Nemotron" | S6 rows with `live_model_responses > 0`; otherwise say "deterministic planner" |
| "Unsafe move blocked" | Karthik's manual probe on hot r6 (R4.4) |
