# DataCenterOS — fixed-cluster delivery plan (v4)

**Updated 2026-11-08, America/Chicago.** User-approved direction: remove the topology editor and finish an evidence-backed GPU reliability demonstration for NMC²'s **Mission: Keep the World Running**.

## Product

Help an operator protect training progress during overlapping infrastructure failures, understand why a recovery was chosen or blocked, and hand over unresolved work. A fixed simulated cluster provides a reproducible setting; Nemotron assists diagnosis/choice while deterministic code checks safety and SpacetimeDB preserves actions/workflows.

**Pitch:** “When cooling or GPU failures threaten training jobs, DataCenterOS compares recovery options, executes safe actions, and resumes recovery after its own agent crashes.” This is the target demonstration; individual completion evidence is tracked below. Better benchmark performance is a hypothesis to test, not a promised outcome.

## Read in this order

1. [Implementation status](plans/IMPLEMENTATION-STATUS.md): what exists and what is actually proved.
2. [Exact scope](plans/IMPLEMENTATION-SCOPE.md): component inventory, faults, actions, UI and evaluation.
3. [Remaining tasks](plans/IMPLEMENTATION-TASKS.md): R0–R7, owners, dependencies and acceptance.
4. [Shared contracts](plans/CONTRACTS.md) §0: frozen names; §0.13 clarified semantics; §0.14 pending additive provenance.
5. [Research](plans/RESEARCH.md): primary sources, design implications and limitations.
6. [Team/gates](plans/README.md), [architecture](plans/ARCHITECTURE.md), then your lane plan.

## What exists now

Audited source: `origin/main` **95e1abd**; local P2 checkout **b2678c4**. Main includes physics, DB/client, agent, dashboard and evaluator. Do not recreate agent/web packages because they are absent on the P2 branch.

P2 reports successful real Nemotron pump recovery on dev and prod, Gate 2 on dev/prod/local, and a 697-test integrated suite. These are recorded historical results, not fresh checks performed by this planning revision. Full live dashboard, combined overlap/actual-agent restart and provenance-complete benchmark proof remain open. [Evidence audit](plans/IMPLEMENTATION-STATUS.md)

## Scope lock

| Keep | Boundary |
|---|---|
| Eight racks, eight nodes, 64 `demo_gpu` GPUs | Fixed graph and resource IDs; read-only inspection |
| Two cooling loops/pumps | Simplified shared heat/capacity behavior |
| GPU power/headroom and cap response | No full facility power, UPS or generator model |
| One checkpoint store and three fixed jobs | Accessibility and durable work; no arbitrary workload builder |
| Pump degradation + Xid79 judge controls | Supported targets/timing/severity; no arbitrary problem interpreter |
| Estimated plan comparisons, safety and durable execution | Model assumptions visible; no physical control |
| Actual agent crash/resume, separate incidents, operator handoff | Verified state/events drive progress UI |
| Same-scenario baseline comparison | Model/cache/fallback provenance, ties and losses disclosed |

Cut from submission: topology editor, mixed GPU profiles, network/switch emulation, new power-grid behavior and production-calibration claims. Existing secondary fault fixtures/tests remain. Hardware ingestion and advanced fault buttons are optional after software proof.

## Remaining execution order

| Work | Owner | Completion evidence |
|---|---|---|
| R0: integrated baseline + additive result provenance | Integrator / P2 / P3 / P4 | Old/new contracts validate, metadata round-trips |
| R1: delayed completion safety | P1 | Same-tick and changed-destination regression tests |
| R2: start-time stale-evidence rejection | P2 | Rejected start has no world effect; Gate 2 still passes |
| R3: observed verification + durable handoff | P3 | No ledger-only false recovery; unresolved hardware recorded |
| R4: live dashboard/action details | P4 | Browser observes actual DB effects and per-workflow stages |
| R5: real process crash + destination overlap | P3/P2 with P4 | Recorded real kill/restart/reconcile/replan without duplicate work |
| R6: evaluation adapter + fixed matrix | P4/P3/P1/P2 | ≥12 cases × 3 policies, artifacts match scoreboard |
| R7: rehearsal/video/submission | Integrator/P4 | Two complete runs, measured pitch duration, final evidence |

R1–R4 can proceed in lane-isolated parallel work after the baseline sync. R6 adapter work can begin early; final scores follow final physics/safety revisions. Full task specifications are in [IMPLEMENTATION-TASKS.md](plans/IMPLEMENTATION-TASKS.md).

## Demo sequence

1. Show fixed cluster, simulation label and job-a/job-b checkpoint-age difference.
2. Degrade pump A; inspect cooling evidence and actual candidate keep/cap/move scores.
3. Show a separate manual hot-r6 safety probe rejected with real reason/evidence, without conflicting in-flight work.
4. Observe job-a checkpoint running and the actual proposed destination; inject Xid79 into that destination.
5. Kill the actual orchestrator, let DB-owned work continue, restart, reconcile existing keys and select a safe remaining placement.
6. Show two incidents, verified job progress and a handoff that leaves pump/GPU service unresolved.
7. Show measured results and model-use disclosures, including cases where the approach ties or loses.

Use state triggers rather than guessing a destination or relying on fixed sleeps. A fake-backed crash test and fixed scenario17 are useful tests, not proof of this live sequence. Measure wall duration; if longer than the three-minute pitch slot, use a labeled recording of a real run.

## Submission gates and cut order

Keep Gate 0–4 names for continuity; see [checklists](plans/README.md). Gate 3 is not yet complete merely because pump-only NIM recovery worked. Gate 4 requires the checked-in adapter, measured matrix and honest provenance.

Cut optional hardware first, then advanced fault buttons, then nonessential UI polish, then the 20-case extension down to the fixed 12-case matrix. Keep already-implemented power cap with verified postconditions. Never cut hard safety, independent overlap, real process recovery, persistent handoff or honest results. Unproved claims stay explicitly incomplete.

Existing event targets from the team plan: backup video 9:30 AM, feature freeze 10:00 AM, submit 11:30 AM on Sunday Nov 8 (recorded deadline noon), judging 1–4 PM. P4 must confirm organizer rules/deadlines; these are team-recorded targets, not newly verified external facts. Old per-task kickoff times are superseded by R0–R7 dependency order.

## Claim rules

- `demo_gpu` temperatures, power and timing are simulated assumptions, not calibrated DGX specifications.
- Tokens reject stale writers; workflow records/ledger/checkpoints preserve different kinds of progress.
- Workload recovery does not repair a pump/GPU. Handoff is part of the deliverable.
- Code versus Nemotron versus cache/fallback is visible. No raw chain-of-thought or hidden future faults.
- Reactive/threshold baselines are our simplified policies, not NVSentinel replicas. Existing NVIDIA tools already automate substantial recovery.
- Offline zero-decision-latency results do not establish real-world savings or actual crash recovery.
