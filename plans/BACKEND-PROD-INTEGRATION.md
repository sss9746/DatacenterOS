# Handoff to Kaushik: get everything onto `main`, a demo database and the public site

**Written:** 2026-11-08 09:30 CST by Karthik's session, after committing and pushing `Prod-Multi-Agent-System`. **Kaushik owns every step below.** Suvan still approves anything reaching `main`.
**Deadlines:** code freeze 10:00 (after that, only demo-breaking fixes), Devpost by 11:00.
**Start here:** `git fetch && git checkout Prod-Multi-Agent-System && git pull`. Then read this file and `plans/WORKFLOW-TAB-INTEGRATION.md`; its status section says what landed.

## What this branch now contains (pushed)

- **`r/ui-v2` frontend merged** (`dd61041`).
- **Agent team live progress** (Stage 2): the round writes `state.team` while agents think (trace v2: per-call status, phase, message timing). The last 4 rounds stay in `state.team_rounds`, and a round cut short by a crash is marked interrupted. Single mode is unchanged. 572 agent tests pass and typecheck is clean.
- **Workflows team tab, Agent room seats and RECORDED replay** (Stages 1, 3 and 4): 243 web tests pass and the build is clean.
- **Live harness:** accepts v2 traces, counts only closed rounds, and its reset check now ignores the observation-only `gpu-real-0`. Every dev reset was failing on `gpus=65` before this.
- **Live evidence:** `apps/agent/live-results/agent-team-2026-11-08/L3-team-v2-dev/`, L3 in team mode on `dcos-dev` at 09:16.
    - 17/18: full recovery, SIGKILL, reclaim, separate GPU incident, new destination, no duplicates, verified handoff.
    - The dashboard stage moved live during both rounds.
    - **Failed:** the peer conversation. In both rounds code rejected Workload's finding for `no_question_reason` (it set `question_for_peer` to null without a reason), so Cooling covered.

## Where things stand (checked 09:25)

**No backend code is left to merge.** Every remote branch ahead of this one is dropped (`r/multi-agent`) or old web work (`r/redesign*`, `P4`, `check/live-readonly`).

| Piece | This branch | `dcos-dev` | Prod `dcos` | Public site |
|---|---|---|---|---|
| DB module (incl. `ingest_observations`) | ✅ unchanged since `c1ac94d` (only checkpoint docs differ) | ✅ module `c1ac94d` | ❌ older module: `ingest_observations` → "no such reducer" | — |
| Unique option ids web fix (`18f5a2b`) | ✅ cherry-picked | — | — | — |
| Agent team + live progress | ✅ | ✅ L3 17/18 at 09:16 | ❌ not run | — |
| Brev GPU: collector, `load.py`, recording, tile | ✅ | ✅ G5 passed 06:12; collector currently stopped | ❌ no reducer, no gateway role | — |
| New UI with the Workflows team tab | ✅ | — | — | ❌ old build |
| `origin/main` | `0b82369`, 104+ commits behind | | | |

**Not on this branch yet:**
- `922c9c1` on `origin/int/r-sprint`: docs only. (The unique-option-ids fix `18f5a2b`, which was only on Karthik's local `int/r-sprint`, is now cherry-picked onto this branch; 244 web tests pass.)
- An uncommitted 08:38 edit to `plans/MULTI-AGENT-HACKATHON-PLAN.md` on Karthik's machine (Codex review notes; not Karthik's). It is not in this push.

## Decision first: which database is the demo database?

| Option | What it takes | Risk |
|---|---|---|
| **A. Use `dcos-dev` (recommended at this hour)** | Nothing to publish: dev already has the module, the agent and gateway roles, and the Brev ingest | Dev is shared and the harness resets it. Post "dev is the demo DB: no `live-recovery` or resets except right before a rehearsal" |
| **B. Switch to prod `dcos`** | Publish `main`'s `apps/db` to `dcos` (the same module as dev), grant the roles, reset, new tokens | About 15 minutes of your time, and it is already 75 minutes past the planned 08:30 switch |

## Steps

### 1. Land on `main` (needs Suvan's OK, about 09:40)
1. `git merge origin/int/r-sprint` (docs only), then run the gate:
    - `pnpm --filter @dcos/physics build`;
    - the `contracts`, `db-client`, `physics`, `evaluation`, `agent`, `web` and `nvidia-smi-collector` tests;
    - `agent typecheck`;
    - `web build`.

    Web e2e has 4 failures that predate this work: the spec's `getByLabel('Simulated GPU')` now matches two controls (`FaultControls` and `FaultLibrary`). Fix the spec, or record the failure as known.
2. `int/r-sprint` ← this branch (fast-forward, or rebase first), then `main` ← `int/r-sprint` with Suvan's OK. Never force-push. Post `main merged @ <sha>`.

### 2. Demo database
- **Option A:** run `spacetime describe -s maincloud --anonymous dcos-dev reducers ingest_observations` and check it prints the signature. Reset `run-demo-1` right before each rehearsal only.
- **Option B:**
    1. Publish `main`'s `apps/db` to `dcos` and check the same `describe` line against `dcos`.
    2. `grant_role` the agent (`0xc200188f…40ca` → `"agent"`) and the gateway identity (→ `"gateway"`).
    3. Reset `run-demo-1`.
    4. DM the tokens, then post `prod ready @ <sha>`.

### 3. Brev GPU (about 09:50)
1. On `dcos-gpu`, restart the tmux collector loop with `--db <demo db>` and that database's gateway token. Run one collector only: two share a `source_id` and reject each other's batches.
2. Check that the REAL NVIDIA GPU tile shows live numbers. Run `~/dcos-venv/bin/python ~/load.py --seconds 60` and watch temperature and power rise. Stop the collector; the tile must show "collector offline".
3. **Fallback:** `--replay hardware/recordings/brev-l40s.jsonl`, labelled REPLAY OF REAL RECORDING. Never fake live readings.

### 4. Agent (presenter laptop, about 09:50)
1. **Pick the mode.**
    - `single` is the default and is proven L1–L6.
    - `multi` is proven once on dev, but in that run the agents didn't talk (see the L3 failure above).
    - Recommendation: run `multi` only if a rehearsal shows a consumed peer answer. Otherwise run `single` and show the team through the Workflows tab's RECORDED replay (Run view → "Recorded agent team (L3)", mock mode).
2. **Optional fix before freeze:** accept a null `question_for_peer` with no reason by recording a default reason, instead of rejecting the whole finding. Workload would then answer Cooling's question. It loosens a rule added on purpose, and needs one more L3 team-mode run on dev (about 4 minutes): `pnpm --filter agent live-recovery --db dcos-dev --case L3 --team-mode multi --speed 1 --timeout-s 600 --out live-results/...`.
3. Run the agent supervised, so the kill demo relaunches: `pnpm --filter agent supervised` with `STDB_DB=<demo db>`, its agent token and `DCOS_AGENT_TEAM_MODE=<mode>`.

### 5. Public site (Suvan's worktree has the `.vercel` link, about 09:55)
1. `npx vercel deploy --prod --yes` with `VITE_DATA_MODE=live` and `VITE_STDB_DB=<demo db>`. **Never `VITE_ADMIN_TOKEN`.**
2. Check that demo controls say "Read-only without the presenter token". Check that the Workflows tab, the REAL GPU tile and the scoreboard render, with no console errors.
3. The Run view selector (with RECORDED) exists only in mock mode, so show the recorded team from the presenter laptop.

### 6. Rehearse, record, docs (10:00–10:45)
1. Run the order from `FINAL-PLAN.md`: pump → r6 BLOCKED → XID on the destination → kill and supervised restart → handoff → Workflows team tab → scoreboard → REAL GPU under load. Reset before each run, time it at under 3 minutes, and save the backup video in `demo/`.
2. Docs:
    - `FEATURES.md`: demo DB, Vercel and Brev rows.
    - `docs/devpost.md`: cite `L3-team-v2-dev/` and resolve its `[[TODO]]` lines.
    - `plans/team/REAL-GPU.md`: status.

## Cut order if late
Public live deploy (keep the presenter laptop) → Brev live (labelled replay) → team mode in the live demo (`single` + RECORDED) → e2e spec fix. **Never cut:** the `main` gate, honest labels, no admin token on Vercel, and the backup video.

## Gotchas
- **Toolchain:** `source ~/.nvm/nvm.sh` before `pnpm`.
- **zsh:** quote git refs (`"origin/r/ui-v2:apps/..."`).
- **Harness results:** the harness writes a `.gitignore` into each results folder, so commit results with `git add -f`.
- **Ignore `origin/r/multi-agent`:** it is the dropped approach. Never merge it.
- **Secrets:** never print or commit `.env.local` or tokens.
