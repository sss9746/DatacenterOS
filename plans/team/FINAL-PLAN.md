# Final plan: integrate everything, make it work live on the frontend (03:30 → 11:00)

**Step-by-step version: [RUNBOOK.md](RUNBOOK.md).** This replaces the per-person split. **One branch, `int/r-sprint`** (now `c1ac94d`, with G3 + the collector merged; 942 tests green). The goal is simple: **what judges see on the dashboard works live, and every claim on it is backed by a real run.**

## Rules (only these)
1. Everyone commits straight to `int/r-sprint`, in small commits. Before pushing: `git pull --rebase origin int/r-sprint`, then run the tests for what you touched, then push. **Never force-push.**
2. **`dcos-dev` is one shared stage.** Say "taking dev" / "releasing dev" in chat. Prod `dcos` is untouched until 08:30.
3. **One Nemotron key, one user at a time.**
4. **Honest labels:** simulated vs REAL, Nemotron vs code, supervised restart vs agent recovery. No number without a saved run.
5. **The 10:00 code freeze is hard.** After that, only fixes for things that break the demo.

## Phases

| Time | Goal | Suvan (+ Claude agents) | Kaushik | Karthik |
|---|---|---|---|---|
| **03:30–04:00** | **Everything integrated on dev** | Pull `int/r-sprint` in the main checkout | Republish `dcos-dev` from `c1ac94d`; `ingest-smoke.ts`; Gate 2; "dev ready" | Pull `int/r-sprint`; run the web app in live mode on `dcos-dev` |
| **04:00–05:30** | **Live demo works on screen** (R5) | Run R5 **L1 → L2/L3 (speed 1) → L4–L6**; paste failures to Claude, which fixes and re-pushes | Stand by for DB fixes; Brev telemetry on **local DB only** | **Watch the dashboard during each run**: record it, list every UI bug seen live, fix them on `int/r-sprint` |
| **05:30–07:00** | **Real numbers + real GPU** | Start the **real Nemotron 12-case run**; Claude checks, publishes to dev, confirms the read-back | **Real Brev tile on dev** (collector → `ingest_observations` → tile; G5). Then, if time: supervised kill-and-resume of a real PyTorch job (label "supervised restart") | Scoreboard on the real batch; real-GPU tile rows (or Claude's agent adds them); Devpost draft |
| **07:00–08:30** | **Looks great** | Polish track (below) lands on `int/r-sprint`; final `/impeccable polish` + one `/review`; Suvan approves the visuals | **08:00 cutoff** for real-GPU work: working or labeled recording | Pair with the polish pass: owns feature behavior; Claude's agents own styling |
| **08:30** | **Ship to prod** | **Approve `int/r-sprint` → `main`**; Claude merges and deploys Vercel live (`VITE_DATA_MODE=live`, `VITE_STDB_DB=dcos`, **no admin token**) | Publish prod `dcos`; grant agent (+ gateway) roles; reset run-demo-1; tokens to Suvan privately | Check the live site on prod |
| **08:45–10:00** | **Rehearse** | Rehearsal #1 (timed), fix only blockers, rehearsal #2 + **backup screen recording** | Reset prod before each rehearsal | Present/record; finalize the pitch |
| **10:00** | **CODE FREEZE** | | | |
| **10:00–11:00** | **Submit** | Review Devpost | — | **Submit Devpost by 11:00**: one-liner, live link, video, sponsor tools (Nemotron/NIM, Brev, SpacetimeDB, NMC²), honest limits |

## Parallel polish track: Claude orchestrator + Fable agents with `/impeccable` (starts ~04:00)

Runs **at the same time** as R5. Only `apps/web` changes, never the DB module, so it can't affect the live proof.

1. **Critique (running since 03:45, read-only):** `/impeccable critique` on mock mode at 1440 / 390 px → at most 15 ranked fixes (P0 / P1 / P2), grouped by file.
2. **Suvan approves the list** (5 min).
3. **2–3 Fable agents on high effort** apply it on branch **`r/polish`** (not `int/r-sprint`). Each owns separate files.
   - **Styling only:** CSS, layout, typography, color, spacing, copy, empty/loading states.
   - **Karthik keeps behavior:** data and feature logic in the `.tsx` components; the agents don't touch what he's fixing live.
   - **Must keep:** simulated/REAL labels, NEMOTRON/CODE badges, BLOCKED reasons, 320 px and keyboard access, no admin token.
   - **Each agent runs** `pnpm --filter ./apps/web test`, `tsc` and `vite build` before pushing.
4. **~06:30:** the orchestrator merges `r/polish` → `int/r-sprint` after R5 and Karthik's live fixes; web tests + build; Suvan checks the screenshots.
5. **07:00–08:30:** a final `/impeccable polish` pass on the combined result, plus one `/review`; CRITICAL/HIGH fixes only.

## The demo judges see (what must work live)
1. Pump A degrades → r2–r4 heat on the 8×8 grid; **one incident**.
2. The agent's feed: **NEMOTRON** diagnoses and chooses, **CODE** simulates and checks safety; candidate options with the chosen one marked.
3. Presenter move onto hot r6 → **BLOCKED** with the plain-English reason.
4. XID 79 on the planned destination → **second, separate incident**; the plan adapts.
5. **Kill the agent** → the DB keeps ticking and the checkpoint finishes → a fresh agent resumes ("resumed by …, #1") → recovery verified.
6. **Handoff card:** what's recovered, what still needs a human (pump, GPU).
7. **Scoreboard:** real Nemotron batch vs baselines, losses included.
8. **REAL NVIDIA GPU (Brev)** tile updating live, with load → heat (+ supervised kill-and-resume if it made the cutoff).

## Cut order if late
Kill-and-resume → real GPU tile (use the recording) → polish depth → L4–L6 (keep L1–L3) → never cut: R5 L1–L3, the honest labels, rehearsal + backup video.
