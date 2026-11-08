# P4 evaluation harness

This package orchestrates evaluations and reports measured outputs. It does **not** implement physics, generate benchmark scores, or claim Gate 4 is complete.

## Implemented

`src/runner.ts` accepts an `EvaluationAdapter`, requires at least ten unique scenario/seed cases, runs all three policies on independent copies, validates each `EvaluationResult`, and verifies scenario/seed/policy/run identity. Policy wrappers receive only an allowlisted, cloned `ObservedSnapshot`; private world fields and future fault schedules are excluded.

`src/report.ts` is shared with the web dashboard. It excludes unmatched seeds/runs, malformed rows, and conflicting duplicates; calculates totals, mean, median, p95 and ranges; and lists cases where Nemotron loses on reported metrics. Missing metrics are never imputed as zero.

`src/main.ts` writes per-run JSON atomically and a batch summary with physics/policy provenance and optional policy cache/fallback statistics. `--publish` explicitly sends real result rows through the admin client's `publishEvaluationResult`. Nothing is published by default.

## Integration still required

P1 has not shipped `loadScenarios`, GPU `runScenario`, `reactivePolicy`, or `thresholdPolicy` on the current base. P3's policy exists on its own branch but has not been integrated here. The exact P1 runner call signature is not frozen in the shared contracts. Supply a small adapter after P1 confirms it; do not guess or copy a simulator into this package.

The adapter default-exports the `EvaluationAdapter` type from `src/runner.ts`: `loadScenarios`, `runScenario`, the three policy functions, explicit physics/policy versions, and optional `getPolicyStats`. Its `runScenario` delegates to P1 and returns the canonical `EvaluationResult`, with the same `run_id` across a comparison's policies. It must not pass scenario truth to policy functions.

```sh
corepack pnpm --filter @dcos/evaluation evaluate --adapter /absolute/path/to/team-adapter.ts
# Explicit admin publication, only once live integration is available:
corepack pnpm --filter @dcos/evaluation evaluate --adapter /absolute/path/to/team-adapter.ts --publish
corepack pnpm --filter @dcos/evaluation test
```

Without an adapter the command exits with an actionable error and produces no results. Test numbers exist only inside tests. No evaluated results are committed.

The current wire schema has no unfinished-job count, version fields, or cache/fallback provenance. The local summary preserves available provenance, but P2/P1 must agree on an additive public representation before the scoreboard can certify Gate 4. See [handoff](../../docs/p4-handoff.md).
