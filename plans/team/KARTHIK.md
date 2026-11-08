> **SUPERSEDED (03:45 Sun):** follow [RUNBOOK.md](RUNBOOK.md) instead. This file is the older per-lane split.

# Karthik: live dashboard, scoreboard, demo and submission

You own `apps/web/**`, `docs/**` and `demo/**`, and work on `lane/p4-web`. Merge into `int/r-sprint` (cut from `main` at `80b1d6e`), not into `main`. Specs: [TASKS](../IMPLEMENTATION-TASKS.md) R4, R6 (scoreboard) and R7, and [SCOPE](../IMPLEMENTATION-SCOPE.md) §3, §5 and §6. The dashboard already exists; **extend it, don't rebuild it**.

## C1: R4, connect the UI to the live system (start now; build in mock mode until `dcos-dev` is republished at M2)

1. **Action details:** use `onActionDetails` alongside `onActions`. Show the operation, job, target, dependencies, real safety evidence, start/due times and lifecycle history. **Never parse command-key strings to guess the operation.**
2. **Progress per workflow:** each concurrent incident gets its own stage track (triage → diagnosis → compare → safety → execute → verify, plus waiting, replanning, resumed and escalated). Elapsed checkpoint or restart time is **not** shown as verified success. No made-up percentages. Keep the NEMOTRON / CODE actor badges and freshness labels.
3. **Two fault controls only** (SCOPE §3): degrade pump (target A/B; loss 0.3/0.6/0.8, default A/0.6; delay 0/10/30 sim-s) and XID 79 (GPU selector; delay 0/10/30). Delay 0 means current sim clock + one step. Hide link controls and topology editing.
4. **Manual safety probe on hot r6** (presenter-only admin mode): a manual move onto r6 through the normal admin action API, using a fresh snapshot epoch, a unique test key and a separate workflow, and only when no conflicting action is running. It must show the real **BLOCKED** reason. No unrestricted write endpoint.
5. **Candidates + handoff:** show the selected plan's real candidate projections, assumptions and snapshot epoch, plus the persisted handoff (evidence, affected jobs, actions, verification time, unresolved pump/GPU state, next human step). If a field isn't exposed, ask Kaushik for a typed read helper; never make one up.
6. **Labels:** simulated / mock / live DB / Nemotron / code-fallback. A failed live connection must never quietly fall back to mock data. Reconnecting rebuilds the screen from the DB, and a reset clears the previous run's UI.

**Done when:**
- Screenshots or a recording plus console assertions show live pump heat, the XID rollback, the checkpoint lifecycle, a BLOCKED reason, two separate incidents and the resumed handoff, on the same commit and DB as Suvan's R5 run.
- The public Vercel build is read-only and contains no admin token.
- The screen works at 320 px and with keyboard focus, if that matters on the presenter device.

## C2: R6 scoreboard (after Suvan hands over results at M3)

- Read the measured rows (`apps/evaluation/results/<batch>/` and the published `evaluation_result`).
- Labels come from provenance: model-assisted, cached, mixed fallback, deterministic only. Legacy rows show provenance unavailable. Refuse to compare rows from different batches, revisions or horizons.
- Show per-scenario results, **including ties and losses**. Label delay as a "finite-horizon work deficit". Never convert to dollars or GPU-hours. Unknown values are not zero.

## C3: R7, rehearsal and submission (M4 08:30 → 11:30)

1. Two rehearsals from a clean reset, following SCOPE §6 steps 1–7: pump → BLOCKED probe → XID on the real destination → kill and restart the agent → handoff → measured results. **Time them.** If they run past 3 minutes, use a labeled recording of the real rehearsal.
2. **Backup video** after the final verified commit (`demo/`).
3. Devpost (`docs/devpost.md`):
   - one-liner, live link, video
   - every sponsor tool: Nemotron via NIM, SpacetimeDB, NMC² GPU track
   - honest limits: simulated cluster, illustrative GPU profile, deterministic-vs-Nemotron disclosure
4. Pitch (`docs/pitch/`): operator outcome, what Nemotron decides and what code computes, results with losses, and "infrastructure still needs a human" from the handoff.
5. Confirm with organizers: track rules and registration. Submit early.

## Redeploy

Vercel deploys from the CLI (`npx vercel deploy --prod --yes`) out of the worktree that has the `.vercel` link. Ask Suvan. For the live demo set `VITE_DATA_MODE=live` and `VITE_STDB_DB=dcos`, and **never `VITE_ADMIN_TOKEN`**.

Report status in `plans/status/P4.md`.
