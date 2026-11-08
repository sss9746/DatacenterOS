# P4 evaluation harness

This package orchestrates evaluations and reports measured outputs. It does **not** implement physics, generate benchmark scores, or claim Gate 4 is complete.

## Implemented

`src/runner.ts` accepts an `EvaluationAdapter`, requires at least ten unique scenario/seed cases, runs all three policies on independent copies, validates each `EvaluationResult`, and verifies scenario/seed/policy/run identity. Policy wrappers receive only an allowlisted, cloned `ObservedSnapshot`; private world fields and future fault schedules are excluded.

`src/report.ts` is shared with the web dashboard. It excludes unmatched seeds/runs, malformed rows, and conflicting duplicates; calculates totals, mean, median, p95 and ranges; and lists cases where Nemotron loses on reported metrics. Missing metrics are never imputed as zero.

`src/main.ts` writes per-run JSON atomically and a batch summary with physics/policy provenance and optional policy cache/fallback statistics. `--publish` explicitly sends real result rows through the admin client's `publishEvaluationResult`. Nothing is published by default.

## Checked-in team adapter (R6)

`src/team-adapter.ts` binds P1 (`loadScenarios`, `runScenarioDetailed`, real `reactivePolicy`/`thresholdPolicy`) and a fresh P3 `createNemotronPolicy` per case to `EvaluationAdapter`. It delegates all computation. One comparison `run_id` (`<batch_id>-<scenario_id>-s<seed>`) is shared by the three policies. Every row carries CONTRACTS 0.14 provenance: usage counters captured before the Nemotron instance is dropped (`reset()` does not clear them), `unfinished_job_ids`/`failed_job_ids` read from `runScenarioDetailed().details` (an absent list is an error, never zero), `code_revision` (git HEAD, read by the CLI), `horizon_sim_s`, `latency_model`, and `trace_sha256` of the saved canonical trace. `runMatrix` and `provenanceConflicts` refuse mixed batch/revision/horizon.

```sh
# 12 preselected cases (sc01 sc03 sc04 sc05 sc07 sc08 sc09 sc10 sc11 sc13 sc14 sc17), deterministic-only Nemotron path
pnpm --filter @dcos/evaluation run evaluate --cases fixed12 --no-llm --out results/<dir>
# live NIM (needs NIM_API_KEY/NIM_MODEL), cached responses disclosed per row
pnpm --filter @dcos/evaluation run evaluate --cases fixed12 --out results/<dir> [--max-live-calls 60]
```

Output: `rows/*.json` (validated `EvaluationResult` with provenance), `traces/*.trace.json`, `manifest.json` (batch id, code revision, profile/policy/prompt versions, horizons, case list, per-row mode label) and `summary.json`. `--no-llm` rows have `model_enabled: false` and honest fallback counts; they cannot support a Nemotron performance claim. `job_completion_delay_s` is a finite-horizon work deficit, not wall completion time; wall decision time is recorded separately in provenance. The adapter imports physics/agent sources by relative path (no new workspace dependency).

## Custom adapters

`--adapter /path/to/adapter.ts` still loads any default-exported `EvaluationAdapter`; `--publish` sends rows through the admin client only on explicit request.
