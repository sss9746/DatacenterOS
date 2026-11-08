# Remaining implementation tasks — fixed-cluster scope

Current specification: [IMPLEMENTATION-SCOPE.md](IMPLEMENTATION-SCOPE.md). Starting evidence: [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md). These tasks supersede the original lane kickoff schedules. They do not authorize claiming a gate passed before evidence is recorded.

## Order and ownership

| ID | Priority / owner | Depends on | Deliverable |
|---|---|---|---|
| R0 | First / integrator + P2/P3/P4 | — | Current main integration, additive provenance definition, baseline evidence |
| R1 | Required / P1 | R0 code baseline | Phase-aware delayed completion safety |
| R2 | Required / P2 | R0 code baseline | Fail closed on start-time violations |
| R3 | Required / P3 | R0 code baseline | Observed verification and persistent operator handoff |
| R4 | Required / P4 | R0; P2 existing `onActionDetails` | Live dashboard, limited fault controls, action detail and per-workflow progress |
| R5 | Required / P3, P2; P4 witnesses | R1, R2, R3; R4 for browser proof | Actual orchestrator crash + overlap rehearsal |
| R6 | Required / P4 with P3/P1/P2 | R0 provenance; R1/R2 semantics | Checked-in evaluation adapter, measured matrix, provenance and scoreboard |
| R7 | Required / integrator + P4 | R4, R5, R6 | Two rehearsals, video, submission and honest claims |
| O1 | Optional / HW + P2 | Gates 1–4 complete | Telemetry ingestion and real observation tiles |

R1/R2/R3/R4 can proceed in parallel in their existing lane paths after synchronizing code. R6 adapter work can proceed in parallel, but freeze final results only after physics/safety revisions are settled. Do not spawn five new infrastructure services or rebuild completed packages.

## R0 — establish one integrated baseline and freeze evidence metadata

**Owns:** root integration, `packages/contracts/`, plans; P2 owns DB/client changes. At audit, current main is `95e1abd`; confirm the next main commit before implementation. P2-only checkout lacks agent/web/evaluation directories; use the integrator's complete main base.

1. Record commit, lockfile, Node/pnpm versions and module version in the implementation report. Preserve existing model configuration that has actually worked; model availability is not inferred from a product name.
2. Run existing workspace checks at the integrated commit: build physics before source consumers; full test suite; contract validator; DB/client/agent/evaluation typechecks and web production build using each package's declared script. Record actual counts rather than copying 697 from history.
3. Implement the **optional `EvaluationResult.provenance`** object specified in CONTRACTS §0.14. Keep `schema_version: "1.1.0"`, existing required fields, policy enum and APIs; add the optional field, regenerate types, validate old/new fixtures. This is an additive coordinated extension, not an already-supported payload.
4. P2 preserves the object in existing `metrics_json` and live/mock read-back. Fill existing DB `policy_version` and `physics_profile_version` from supplied provenance when available; legacy rows keep explicit unknown provenance. No new DB table or column is required.
5. Update validators/consumers before emitting new rows: old strict validators reject unknown fields. Prove publish → subscribe/export round-trip for one measured row. No credentials in artifacts.

**Done:** old payloads still validate, metadata survives the entire pipeline, wrong metadata rejects, and consumers display unknown rather than invented values for legacy rows. Add schema/round-trip tests because this is a cross-lane interface change.

## R1 — phase-aware completion checks

**Owns:** `packages/physics/src/gpu/{actions,safety,step}.ts` and meaningful tests; coordinate outcomes with P2. Reuse the pure engine in live and offline execution.

Current allocation commits at migration start; completion ends the simulated restart. Implement the precise restart failure behavior in scope §4. Recheck affected destination ownership, compatible/healthy GPUs, relevant GPU freshness, projected thermal/power headroom, and checkpoint-store accessibility before marking running. The phase-aware check must exclude own reservations/allocations and avoid rejecting merely because some unrelated incident changed the global epoch.

Ensure checks use this tick's fault effects and derived conditions, not pre-fault cached headroom. When a completion fails, keep durable work, leave no orphaned restarting job or partial allocation, preserve failed hardware state, and emit the existing precise reason where applicable. Do not roll the job back to an old placement that was already released.

**Done tests:**
- Source GPU lost on the checkpoint due tick → checkpoint fails, durable work unchanged.
- Destination-only loss during source checkpoint → checkpoint can finish, old destination unusable.
- Destination becomes thermally unsafe / storage unavailable / relevant evidence stale before restart completion → no successful restart; failure and allocation cleanup agree in world, ledger and projections.
- Unrelated fault → valid running checkpoint still completes.
- Two competing moves never allocate one GPU to two jobs.
- Re-run GPU actions/safety/simulation/scenario tests and regenerate affected fixture/baseline artifacts from code. Document any metric changes.

## R2 — align start-time safety with request-time handling

**Owns:** `apps/db/src/actions.ts`, client mock behavior if needed, DB integration script coverage. Preserve idempotency and authorization.

`start_action` currently blocks only `decision === 'deny'`. Make nonempty violations block execution, including a new `EVIDENCE_STALE` between accepted request and start. A violation-free approval requirement continues to follow CONTRACTS §0.11 #17; no hard constraint is bypassed for demo resilience. Record failure/reason/evidence and release a claim's reservations; do not enqueue rejected commands.

**Done:** a fresh accepted migration is claimed, then a GPU stale-observation fault ages beyond 10 sim-s before start; start fails with recorded `EVIDENCE_STALE`, no new allocation or command effect. Cover stale versions, valid own-lease exclusion, and normal successful start. Re-run Gate 2 against named dev/local target after R1 integration. Do not reset prod merely to run a check.

## R3 — verify effects and preserve the handoff

**Owns:** `apps/agent/src/{verify,coordinator,resume,replan,events}.ts` as needed; tests. The agent already exists; extend it.

- Migration: two fresh observed samples over the configured 10 sim-s window; exact destination; advancing work or a completed job; healthy eligible GPUs; valid predictive headroom using phase-aware semantics. If time does not advance, verification is inconclusive, not green.
- Power cap: read targeted limits and modeled effects, confirm job progress when expected. Pause: observed job state and preserved durability. Keep: observed ongoing/completed work. Escalate: acknowledged handoff, not a recovered job. Checkpoint: matching complete accessible row and protected work; idempotent re-verification must not require a second durability increase.
- Persist verification facts and unresolved infrastructure conditions in existing workflow state / action verification; emit concise events within current size limits. Do not rely solely on raw telemetry older than the bounded retention window (roughly 7.5 seconds at 266 rows/s and a 2,000-row cap).
- Fallback/outage: bounded tool iterations and timeouts; actor `code`; explicit approval-policy behavior. Never present a deterministic fallback as an actual Nemotron conclusion.

**Done:** tests reject stale/paused-clock false positives, ledger-only success for an ineffective action, and unsupported hardware-repair claims. Handoff survives a fresh agent connection and includes evidence, affected work, completed/blocked actions, verification time, remaining risk and next operator step.

## R4 — connect the existing UI to the implemented system

**Owns:** `apps/web/` and frontend tests. P4's older handoff blockers about missing live client, clocks and loop rows are resolved upstream.

1. Consume `onActionDetails` alongside `onActions`. Show operation/job/target, dependencies, actual safety evidence, start/due timing and lifecycle history. Never infer operations from command-key strings.
2. Show per-workflow progress for concurrent incidents. Drive activity from events and persisted state; elapsed checkpoint/restart time is distinct from verified success. Preserve actor, source and freshness labels.
3. Expose the two core fault controls in scope §3. Preserve read-only cluster inspection. Hide unsupported link controls and topology editing. Advanced Xid48 is optional even though the mock now supports it.
4. Add a local presenter manual checkpoint / hot-r6 probe through existing admin-authorized action APIs and the same safety path. Read fresh snapshot/epoch, use unique test keys and separate workflow, and only probe when conflicting actions are absent. Do not add an unrestricted write endpoint.
5. Surface actual selected candidate projections/assumptions and persisted handoff; if the existing public plan/event projection omits a needed field, add a typed read helper through P2 over existing tables. Never synthesize scores or successful stages.
6. Verify live pump heat, Xid rollback, checkpoint lifecycle, BLOCKED reasons, overlap and resumed handoff. Reconnect must rebuild from DB. Mock/scripted mode remains clearly labeled and never silently replaces a failed live connection.

**Done:** browser recording/screenshots plus console assertions on the same commit/DB as R5; no fabricated telemetry/headroom; readonly public build excludes admin token; reset clears prior-run UI; readable operator text and keyboard access. Complete known 320px wrapping/focus issues if they affect the presentation device; broad redesign is not a dependency.

## R5 — prove real crash recovery and independent overlap

**Owns:** P3 new `apps/agent/scripts/live-recovery-test.ts` (planned file), P2 helper/check support within its paths. No real hardware mutation. Keep existing fake-backed crash tests.

Harness responsibilities: explicit dev/local database argument; controlled reset with the agent stopped; seed 42; actual agent child process using current NIM config; wait on subscribed states rather than fixed sleeps; bounded wall-time waits with actionable failure artifacts; redacted logs. The harness can inspect public plan/command data for test triggering, but the agent receives no private schedule/truth.

**Mandatory cases:**

| Case | Trigger | Assertion |
|---|---|---|
| L1 | Pump degradation, actual checkpoint running; SIGKILL real agent; restart fresh process | DB clock advances without agent; checkpoint finishes once; workflow reclaimed; same accepted command keys reconciled; later move/verification succeeds |
| L2 | Actual planned destination Xid79 while source checkpoint runs | Separate incident; valid source checkpoint retained; pending obsolete move cancelled/superseded; new safe destination, no duplicate allocation |
| L3 | Combine L1 and L2 | Fresh process sees both incidents and existing work; recovers or explicitly escalates; record final evidence, not just a process exit code |
| L4 | Old worker resumes after takeover | Stale fencing token cannot mutate workflow/start/cancel protected work; new owner proceeds |
| L5 | Source Xid79 or store loss on checkpoint due tick | No new durable checkpoint; dependent move does not consume failed write |
| L6 | Model timeout/invalid tool response | Hard safety remains; bounded fallback is clearly attributed; no arbitrary execution |

L1/L2/L3 require actual DB + actual orchestrator; L3 is the presentation centerpiece. Use real NIM for the recorded main rehearsal and disclose fallback counts. L4/L5/L6 can use deterministic test controls with the real ledger and targeted unit tests; label evidence accordingly. Running an absent-request retry uses the same intended key, while changed replan semantics use a new key.

**Done:** machine-readable assertions plus short human report with commit, DB, seed, model, sim/wall timestamps, command keys, allocation uniqueness, checkpoint count and verification results. Include a browser witness from R4. The old fixed `sc17` and fake crash script do not substitute for this evidence.

## R6 — measured evaluation and provenance

**Owns:** P4 `apps/evaluation/src/team-adapter.ts` (planned file), runner/report/UI; P3 policy instrumentation; P1 runner details; P2 round-trip from R0.

- Implement `EvaluationAdapter` using P1 `loadScenarios`, `runScenarioDetailed`, real `reactivePolicy`/`thresholdPolicy` and a fresh P3 `createNemotronPolicy` per case. Delegate computation, never duplicate the simulator. Expose a reproducible CLI command using the checked-in adapter.
- Pass the same comparison run ID for all three policies within a scenario/seed/batch. Preserve per-case provenance before instance disposal; usage counters are not reset by policy `reset()`.
- Execute the fixed 12-case matrix in scope §7, or all 20. Use live NIM or traceable cached model responses for the model-assisted experiment; preserve and label all fallback decisions. The existing side-by-side script's no-LLM default is a deterministic rehearsal only.
- Read unfinished/failed IDs and command traces from the detailed runner. Record real wall decision time separately from zero-latency simulated results. Snapshot restrictions and private-truth separation apply equally to every policy.
- Save validated result rows, traces and manifest; publish only from that measured artifact. Export/read-back must match it. Because the DB upserts `(scenario, policy, seed)`, keep complete batch files locally and refuse to compare mismatched batch/revision/horizon metadata after partial publication.
- Show ties/losses and per-scenario distributions. Label the delay measure as finite-horizon work deficit, not measured wall completion time. Do not convert work units to dollars or real GPU-hours.

**Done:** at least 36 matched, validated rows; every result carries provenance; no missing value becomes zero; scoreboard matches raw artifacts; deterministic-only and mixed-fallback rows visibly distinguished. If model budget prevents a complete assisted matrix, record Gate 4 as partial and present available baseline/deterministic evidence honestly.

## R7 — rehearsal and submission

**Owns:** integrator plus P4 `docs/`, `demo/`. Preserve the event's existing submission deadlines; feature priority follows evidence gates rather than the obsolete kickoff timetable.

- Run the presentation twice from a clean controlled reset, including the manual blocked probe, independent failure, actual crash/resume and operator handoff.
- Measure duration. Use a clearly labeled recording if the complete live sequence does not fit three minutes. Record a backup after the final verified commit.
- Confirm organizer track rules, registration, deployment URL, video and submission status; none is inferred from a package existing.
- Pitch the operator outcome and explicit model boundary. Show sourced motivation, actual NIM/code attribution, honest benchmark outcomes, and infrastructure still requiring human service.
- Update lane status and gate evidence with artifact paths and commit. A passing local unit suite is not a deployment or live demonstration certificate.

## Optional work and stop rule

O1 is P2-9 plus HW collector/gateway validation after required software gates. Fan mapping stays explicit and off by default; real GPU readings never become simulated allocations. Other optional work: additional verified fault buttons and longer benchmark coverage. If required proof is incomplete, stop optional work and finish R1–R7; never fake its output to meet the pitch.
