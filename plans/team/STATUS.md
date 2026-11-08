# Sprint status: done and to do (updated 03:40 Sun, Nov 8)

Integration branch **`int/r-sprint` @ `7f038bf`**. `main` is still `0b82369` (plans only). `dcos-dev` runs module `4202392`, which is identical to `int/r-sprint` for `apps/db`, physics, contracts and db-client.

## ✅ Done

| Item | Who | Evidence |
|---|---|---|
| Asta's plan reviewed; 3-way split in `plans/team/` | Orchestrator | `main` `777b2bf`, `0b82369` |
| **R0** optional `EvaluationResult.provenance` (CONTRACTS §0.14) | Sonnet agent | `r/r0-provenance` `221fd39`; validator passes on 7 fixtures |
| **R1** phase-aware completion checks (checkpoint and restart) | Fable agent | `r/r1-completion`; 370 physics tests; no baseline drift |
| **R2** start-time check fails closed (`EVIDENCE_STALE` etc.) | Kaushik K1 | `lane/p2-r-sprint` `e22712c` |
| **R3** operation-specific verification read-back plus persisted operator handoff (`state.verification`) | Fable agent | `r/r3-verify-handoff` |
| R3b `state.candidates[]` (chosen and rejected), `state.resumed`, `state.resume_count`; never invents metrics for unsimulated options | Sonnet agents | `r/r3b-candidates-resumed` `b700c16`, `r/web-candidates` `6d04d3e` |
| **R6** checked-in eval adapter, per-case model-use counters, provenance, traces, manifest | Sonnet agent | `r/r6-eval-adapter`; 36-row **deterministic-only** fixed12 batch committed |
| K2 provenance DB round trip; K3 republish of `dcos-dev`, `controlledReset`, read helpers | Kaushik | `7f53ae1`; `dcos-dev` @ `4202392` |
| **R4** live dashboard: action details, per-workflow stages, 2 fault controls, r6 BLOCKED probe, candidates, handoff, source labels; editable model values removed | Karthik | `lane/p4-web` `96a9558` |
| **R6 / C2** scoreboard: provenance labels, refuses mixed batches, wins/ties/losses | Karthik | `lane/p4-web` |
| **R5** live recovery harness L1–L6 (refuses to reset prod) | Fable agent | `r/r5-live-harness` `da3cd2b`, 45 unit tests |
| `/review` pass; 2 HIGH fixed (a no-response run labeled "model-assisted"; a no-action handoff saying "recovered") | Workflow | `int/r-sprint` `7bfee16`, `15d2f77` |
| **All checks on `7f038bf`:** 922 tests (contracts 23, db-client 45, physics 370, eval 20, agent 382, web 82); tsc clean ×7; web build; crash-test 5/5; DEMO OK | Orchestrator | this file |
| Admin token for `dcos-dev` in Suvan's `.env.local` | Suvan | verified, not printed |
| Track G plan + `dcos-real-gpu` agent | Orchestrator | `plans/team/REAL-GPU.md` |

## ⏳ To do (in order)

| # | Step | Who | When | Done when |
|---|---|---|---|---|
| 1 | **R5 live runs** on `dcos-dev` from `int/r-sprint`: L1 (speed 2), L2 and L3 (speed 1, timeout 600), L4–L6. Post "taking dev" / "releasing dev" | **Suvan** runs, orchestrator fixes failures | now → ~05:00 | `apps/agent/live-results/*/report.md` all pass |
| 2 | Browser witness of the R5 run, on the same commit and DB | **Karthik** (pull `int/r-sprint` first) | during step 1 | recording plus console log |
| 3 | **Real Nemotron fixed12 eval** (`pnpm --filter @dcos/evaluation run evaluate --cases fixed12 --out apps/evaluation/results/nemotron-fixed12`). **Not concurrently with step 1** | Suvan runs, orchestrator checks | after step 1 | 36 rows, `live_model_responses > 0`, fallbacks disclosed |
| 4 | Publish the batch to `dcos-dev`; read-back must match the files; hand it to the scoreboard. Run IDs `cmp-<batch>-<scenario>-<seed>`, never `run-demo-1` | Orchestrator + Karthik | ~07:00 (M3) | the scoreboard shows the real batch, losses included |
| 5 | Final short `/review` on `main..int/r-sprint`; fix CRITICAL/HIGH only | Orchestrator | ~07:30 | no CRITICAL/HIGH open |
| 6 | **Approve `int/r-sprint` → `main`** | **Suvan** | ~08:30 (M4) | merged |
| 7 | **Prod switch:** publish `dcos`, grant the agent role (`0xc200188f…40ca`), reset run-demo-1, prod tokens to Suvan privately | **Kaushik** (K4) | M4 | agent runs on `dcos` |
| 8 | Republish the saved batch to `dcos`; Vercel `VITE_DATA_MODE=live`, `VITE_STDB_DB=dcos` (**never** an admin token); redeploy | Orchestrator | M4 | https://datacenteros.vercel.app live on prod |
| 9 | Rehearsal #1, timed: pump → r6 BLOCKED → XID on destination → kill/restart the agent → handoff → scoreboard | Suvan + Karthik | 08:30–09:15 | under 3 min, or labeled recording |
| 10 | Rehearsal #2 plus the **backup screen recording** | Suvan + Karthik | ~09:30 | video saved in `demo/` |
| — | **10:00 feature freeze**: only fixes for things that break the demo | all | 10:00 | |
| 11 | Devpost: one-liner, live link, video, sponsor tools (Nemotron/NIM, SpacetimeDB, NMC²), honest limits; **submit by 11:00** | Karthik + Suvan | 10:00–11:00 | submitted |
| opt | Track G: real Brev GPU tile (G0–G5) | Suvan (`claude --agent dcos-real-gpu`) + Kaushik G3/G4 | if time | tile updates live under load |

## Pitch claims and what each still needs

| Claim | Status |
|---|---|
| "Agent crashed mid-recovery; a fresh process finished with no duplicates" | **Needs step 1 (L1/L3)** |
| "Kept two failures separate" | **Needs step 1 (L2/L3)** + step 2 |
| "Unsafe move blocked" | Built (r6 probe); show it live in step 9 |
| "X% less lost work than threshold, with Nemotron" | **Needs step 3.** The current 24% is the **deterministic planner only** and must be labeled that way |
| "Real NVIDIA GPU, live" | Only if track G passes G5 |

## Known limits (disclosed, not fixing before freeze)

- Simulated cluster, illustrative `demo_gpu` profile; job speed is the sum of GPU rates, not the slowest rank.
- R1: a thermal-shutdown latch on the exact checkpoint-due tick can still complete that checkpoint; completion freshness covers destination GPUs only.
- `predicted_work_deficit_units` is always null (physics has no such metric).
- The eval adapter imports agent code by relative path; the live NIM path of the adapter has no test.
- One wall-clock physics test (`runs a 600 s plan fast enough`) can fail under heavy machine load.
