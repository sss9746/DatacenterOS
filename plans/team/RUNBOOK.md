# RUNBOOK: step by step for everyone (Sun Nov 8, 03:45 → 11:00)

**Read this file only.** It supersedes `KAUSHIK.md`, `KARTHIK.md`, `SUVAN.md` and the timeline in `README.md`. `FINAL-PLAN.md` is the one-page summary of this file.

- **Branch:** `int/r-sprint`. Everyone works there.
- **Code freeze:** 10:00, hard.
- **Devpost:** submitted by 11:00 (deadline 11:30).
- **If you're stuck for more than 15 minutes, post in chat.** Don't silently skip a step.

---

## 0. Rules for everyone (read once)

1. **One branch.** Before every push:
   ```bash
   git pull --rebase origin int/r-sprint
   pnpm --filter <your package> test        # whatever you touched
   git push origin int/r-sprint
   ```
   **Never `--force`.** If a rebase conflicts and it isn't yours, stop and ask in chat.
2. **Commit messages:** `feat: …` / `fix: …`, small and often.
3. **`dcos-dev` is one shared stage.** Before anything that resets it, injects faults or runs live tests, post **"taking dev"**. When done, post **"releasing dev"**. Only one person holds it at a time.
4. **Nobody touches prod `dcos` before step K7 (08:30).**
5. **One Nemotron key, one consumer at a time:** either R5 or the eval run, never both at once.
6. **Secrets:** tokens only in your own `.env.local`, sent by private DM. Never in chat, git, screenshots or any `VITE_*` variable.
7. **Honest labels:** simulated vs REAL, NEMOTRON vs CODE, "supervised restart" vs agent recovery. No number on screen unless a saved run produced it.
8. **Chat check-in messages** (copy these exactly so everyone can scan):
   `dev ready @ <commit>` · `taking dev` · `releasing dev` · `R5 L1 PASS/FAIL` · `eval done` · `polish merged` · `main merged` · `prod ready` · `freeze`

---

## Milestones (everyone watches these)

| ID | Target | Signal in chat | Blocks |
|---|---|---|---|
| M-A | 04:00 | `dev ready @ c1ac94d` (Kaushik) | R5 |
| M-B | 05:30 | `R5 L1–L3 PASS` (Suvan) + `releasing dev` | Eval run, Brev on dev |
| M-C | 07:00 | `eval done` (Suvan/Claude) | Scoreboard |
| M-D | 07:00 | `polish merged` (Claude) | Final polish |
| M-E | 08:00 | Brev cutoff: `brev live` or `brev → recording` (Kaushik) | — |
| M-F | 08:30 | `main merged` (Suvan approves) → `prod ready` (Kaushik) | Rehearsals |
| M-G | 09:30 | Rehearsal #2 + backup video saved (Karthik) | — |
| M-H | 10:00 | `freeze` | — |
| M-I | 11:00 | Devpost submitted (Karthik) | — |

---

## KAUSHIK: step by step

**K1: republish dev with everything integrated** (now → 04:00)
1. `git fetch origin && git checkout int/r-sprint && git pull`. Confirm it contains `c1ac94d` (G3 + collector).
2. Publish: `pnpm --filter db publish:dev` (or your usual publish of `int/r-sprint` to `dcos-dev`).
3. Run `apps/db/scripts/ingest-smoke.ts` (it **resets** the run, which is fine now; nobody else is on dev yet).
4. Run Gate 2: `pnpm --filter db gate2`.
5. Reset run-demo-1 to fresh (600000, epoch 0).
6. Check that the agent identity `0xc200188f…40ca` still has the `agent` role on dev.
7. Post **`dev ready @ <commit>`** with the module version.

**K2: support R5** (04:00 → 05:30, Suvan holds dev)
1. Stay reachable. If Suvan pastes a DB error, fix it in `apps/db` / `packages/db-client`, push, and **republish dev**, then post `dev ready @ <new commit>`.
2. Meanwhile, Brev on your **local DB only** (never dev during this window):
   - Rent the cheapest Brev GPU (L4/T4/A10) if none exists. Note the hourly rate in chat.
   - `brev login && brev refresh`; check `ssh <host> nvidia-smi`.
   - `pnpm --filter nvidia-smi-collector start --host <host> --dry-run` shows valid events every second.
   - Mint a **gateway** identity for dev and `grant_role` it `"gateway"`. Keep the token private.

**K3: Brev live on dev** (after `releasing dev` from Suvan, ~05:30 → 07:00)
1. Post `taking dev`.
2. `pnpm --filter nvidia-smi-collector start --host <host> --db dcos-dev` (gateway token in your `.env.local`).
3. Check that the dashboard's **REAL NVIDIA GPU** tile shows live numbers.
4. `scp hardware/brev/load.py <host>:~/` then `ssh <host> "python3 ~/load.py --seconds 60"`. The tile's temperature and power rise.
5. Stop the collector; after 15 seconds the tile shows "stale".
6. Record 2 minutes: `... start -- --host <host> --db dcos-dev --record ../recordings/brev-live.jsonl`. Commit `hardware/recordings/brev-live.jsonl` (if < 5 MB).
7. Post `releasing dev`.
8. **Optional, only if steps 1–7 are done by 06:30:** the supervised kill-and-resume of a small PyTorch job (`train.step`, `train.checkpoint_step`, `train.attempt` metrics through the same ingest). Label it **"supervised restart (not agent)"**. Send the final metric names to Suvan so Claude adds the tile rows.

**K4: M-E cutoff (08:00)**
- Post `brev live` if K3 steps 1–5 pass. Otherwise post `brev → recording`; the demo shows the labeled recording via `--replay`.

**K5: 07:00–08:30**
- Help on any blockers.
- Prepare the prod publish command and the role grants, but **don't run them yet**.

**K6: wait for `main merged` from Suvan.**

**K7: prod switch** (08:30)
1. `git checkout main && git pull`.
2. Publish `main` to prod `dcos`.
3. Grant roles on `dcos`:
   - agent: `0xc200188f5b9a75fbc8d3bfc5b5f3d04f601c7261506fa0e9bf017f130ec740ca` → `"agent"`
   - gateway identity → `"gateway"` (only if Brev is live)
4. Reset run-demo-1 on prod.
5. **DM** Suvan the prod tokens needed (agent and admin for presenter controls; gateway if Brev is live).
6. Post **`prod ready @ <commit>`**.

**K8: rehearsals** (08:45 → 10:00)
- Reset prod run-demo-1 right before each rehearsal when Suvan asks.

---

## KARTHIK: step by step

**C1: set up live dashboard on dev** (now → 04:00)
1. `git fetch origin && git checkout int/r-sprint && git pull`.
2. `pnpm install --frozen-lockfile`.
3. Wait for `dev ready`, then start the dashboard live:
   ```bash
   VITE_DATA_MODE=live VITE_STDB_DB=dcos-dev \
   VITE_ADMIN_TOKEN="$(grep '^STDB_ADMIN_TOKEN=' ~/.dcos-tokens/dcos-dev.env | cut -d= -f2-)" \
   pnpm --filter @dcos/web dev
   ```
   `VITE_ADMIN_TOKEN` is required for presenter mode. Without it the dashboard
   connects read-only and every Fault library row is disabled
   (`use-dashboard.ts:25` → `mode.ts:5` → `FaultLibrary.tsx:77`), which blocks the
   "move onto hot r6 → BLOCKED" beat. It is accepted only by the local dev server;
   `vite.config.ts:9` rejects any build that has it set, so never put it in a
   `.env` file you also build from, and **never** configure it on Vercel.
4. While waiting: draft `docs/devpost.md`:
   - one-liner
   - problem + statistic (Meta Llama 3: 419 interruptions in 54 days, 58.7% GPU-related, arXiv 2407.21783)
   - how it works (NEMOTRON decides, CODE computes, SpacetimeDB is durable)
   - sponsor tools
   - honest limits (simulated cluster, illustrative GPU profile)
   - "built with"

**C2: witness R5 live** (04:00 → 05:30)
1. Start a screen recording (OBS / Xbox Game Bar `Win+Alt+R`) **before** Suvan starts each case.
2. Watch for each of these and note the time. Each one is a demo beat:
   - L1: checkpoint running → **agent killed** → DB keeps ticking → fresh agent **resumes** (resumed-by callout) → move verified.
   - L2: **second incident** appears separately after the XID; the plan adapts to a new destination.
   - L3: both at once (the centerpiece).
3. List every UI bug you see (wrong labels, missing rows, stale panels, errors in the browser console).
4. Fix **behavior bugs only** (data/logic in `.tsx`/`.ts`). **Styling is owned by Claude's polish agents** on `r/polish`: `App.tsx` layout order, `styles.css`, `simulation/*`, `RealGpu.tsx`, `controls/*`, `feed/*`, `workflows/*`, `ledger/*`, `scoreboard/*`. If you must edit one of those files, say so in chat first.
5. Run `pnpm --filter @dcos/web test` before each push. Push to `int/r-sprint`.
6. Save the recordings to `demo/witness/` (local; commit only if < 50 MB, otherwise keep them on your laptop and note the path).

**C3: scoreboard and Devpost** (05:30 → 07:00)
1. After `eval done`: check the scoreboard against `apps/evaluation/results/nemotron-fixed12/`:
   - labels from provenance
   - losses shown
   - batch mixing refused
2. Report any mismatch to Suvan.
3. Finish the Devpost draft. Leave placeholders for the video link and the final numbers.

**C4: pair on polish** (07:00 → 08:30)
1. After `polish merged`: pull, run the dashboard, check that nothing you fixed regressed.
2. Write the pitch: 3 minutes, following the demo order in §DEMO below.

**C5: prod check** (after `prod ready`, ~08:40)
- Open https://datacenteros.vercel.app and check it's live on `dcos` (not mock) and shows a fresh run.

**C6: rehearsals** (08:45 → 10:00)
1. Rehearsal #1, timed: you narrate, Suvan drives. Note what broke.
2. Rehearsal #2: **record the backup video** of the full run. Save it to `demo/backup.mp4`, or upload it and keep the link.

**C7: submit** (10:00 → 11:00)
- Finish Devpost: final numbers (from saved artifacts only), video link, live link, screenshots, every sponsor tool (NVIDIA Nemotron via NIM, NVIDIA Brev, SpacetimeDB, NMC² GPU track). **Submit by 11:00.**

---

## SUVAN (+ Claude orchestrator): step by step

**S1: prep** (now → 04:00)
1. In the main checkout:
   ```bash
   cd /c/Users/suvan/Desktop/Desktop/code/hackathon/datacenteros
   git fetch origin && git checkout --detach origin/int/r-sprint
   pnpm install --frozen-lockfile && pnpm --filter @dcos/physics build
   grep -c '^STDB_ADMIN_TOKEN=' .env.local    # should print 1
   ```
2. Say **"go"** to Claude for the 3 polish agents (on `r/polish`, in parallel; styling only).

**S2: R5 live runs** (after `dev ready`, 04:00 → 05:30)
1. Post `taking dev`. Tell Karthik to start recording.
2. Run one case at a time:
   ```bash
   pnpm --filter agent live-recovery --db dcos-dev --case L1 --speed 2 --timeout-s 480
   pnpm --filter agent live-recovery --db dcos-dev --case L2 --speed 1 --timeout-s 600
   pnpm --filter agent live-recovery --db dcos-dev --case L3 --speed 1 --timeout-s 600
   pnpm --filter agent live-recovery --db dcos-dev --case L4,L5,L6 --speed 2 --timeout-s 480
   ```
3. After each case: paste the last ~20 lines (or the `report.md` path in `apps/agent/live-results/`) to Claude.
   - **PASS:** post `R5 Lx PASS` and go on.
   - **FAIL:** Claude fixes, pushes, and you `git pull` and re-run that case. If the fix touched `apps/db`, `packages/physics`, contracts or db-client, **Kaushik republishes dev first**.
4. **L1–L3 must pass.** L4–L6 are nice to have; cut them at 05:30 if behind.
5. Post `releasing dev`.

**S3: real Nemotron eval** (05:30 → 07:00)
1. First, a single-case sanity check (look for `live_model_responses` > 0 in the output row):
   ```bash
   cd apps/evaluation
   pnpm run evaluate --cases fixed12 --max-live-calls 30 --batch-id nim-check --out results/nim-check
   ```
   If live responses = 0, stop and tell Claude (the NIM env isn't loaded).
2. The full run:
   ```bash
   pnpm run evaluate --cases fixed12 --max-live-calls 400 --batch-id nemotron-fixed12 --out results/nemotron-fixed12
   ```
3. Tell Claude. Claude checks the provenance and the honest comparison, commits the artifacts, publishes to `dcos-dev` with the read-back check, and posts `eval done`.

**S4: polish review** (~06:30–07:00)
1. Claude merges `r/polish` into `int/r-sprint` after the web tests and build pass, and posts `polish merged`.
2. You look at the dashboard and the screenshots, and say what to change. Then the final `/impeccable polish` and `/review` run (CRITICAL/HIGH fixes only).

**S5: ship** (08:30)
1. Tell Claude **"approve main"**. Claude merges `int/r-sprint` → `main`, runs all the checks, and posts `main merged`.
2. After `prod ready`: put the prod tokens in `.env.local` (`STDB_DB=dcos`, the prod agent token, and the prod admin token for the presenter laptop only).
3. Claude republishes the saved eval batch to `dcos` and deploys Vercel with `VITE_DATA_MODE=live` and `VITE_STDB_DB=dcos` (**no admin token**).

**S6: rehearsals** (08:45 → 10:00): you drive, Karthik narrates and records
1. Start the agent on prod: `pnpm --filter agent start`.
2. Run §DEMO steps 1–8. Time it.
3. Fix only what broke the demo (Claude). Freeze at 10:00.

**S7: submit** (10:00 → 11:00)
- Review Devpost with Karthik. Make sure every number on it comes from a saved artifact.

---

## DEMO: the script judges see (≈3 min)

1. **Hook (15 s):** "Meta lost training work 419 times in 54 days on Llama 3. 58.7% of those were GPU-related. When a GPU cluster starts failing, which jobs do you keep, cap, or move?"
2. **Pump A degrades:** r2–r4 heat up → **one incident** (shared cause).
3. **The feed:** **NEMOTRON** diagnoses and picks; **CODE** simulates and checks safety. Options listed, the chosen one marked.
4. **Move onto hot r6** (presenter probe) → **BLOCKED**: "destination rack has too little thermal headroom".
5. **XID 79 on the planned destination** → **second, separate incident**; the plan picks a new destination.
6. **Kill the agent** → the DB keeps ticking and the checkpoint finishes → a fresh agent **resumes** with no duplicate actions → move verified.
7. **Handoff:** recovered ✅ vs needs a human ⚠ (pump, GPU).
8. **Scoreboard:** real Nemotron batch vs baselines, **losses shown**. **REAL NVIDIA GPU (Brev)** tile live, or the labeled recording.
9. **Close:** "Nemotron decides, code computes, SpacetimeDB remembers. Built on NVIDIA NIM, Brev and SpacetimeDB."

---

## If something goes wrong

| Problem | Do this |
|---|---|
| R5 case fails | Paste the output to Claude; don't re-run blindly |
| Dev broken / stuck lease | Kaushik: controlled reset (stop the agent first) |
| NIM slow or rate-limited | Use speed 1; cut L4–L6; the eval falls back and is labeled |
| Brev box won't start | Cut to the recording (`--replay`), labeled REPLAY |
| Behind schedule | Cut in this order: kill-and-resume → Brev live → polish depth → L4–L6. **Never cut:** R5 L1–L3, honest labels, backup video |
| Live demo fails on stage | Play `demo/backup.mp4` |
