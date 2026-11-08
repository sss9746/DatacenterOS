# Handoff: integrate `r/ui-v2` and rebuild the Workflows tab around the agent team

> **Status 2026-11-08 09:30 — all five stages done and committed on `Prod-Multi-Agent-System`.**
> - **Stage 1:** `r/ui-v2` merged in `dd61041`; Agent room has Cooling, Workload, Lead and Supervisor seats built from `team_message`.
> - **Stage 2:** trace v2 live progress, `state.team_rounds` history, `team/progress.ts`; 572 agent tests pass.
> - **Stage 3:** `components/team/*` team stage, transcript and timeline.
> - **Stage 4:** RECORDED replay of the real L3 rounds.
> - **Stage 5:** reduced `/design-review` (contrast passes AA, NEMOTRON/CODE tags enlarged) and docs.
>
> **Live check:** L3 team mode on `dcos-dev`. The first run scored 17/18 (`apps/agent/live-results/agent-team-2026-11-08/L3-team-v2-dev/`): the stage updated live during both rounds, but the peer-conversation check failed. Workload's finding was rejected in both rounds for two *different* reasons — round 0 invalid arguments (`no_question_reason`), round 1 an unknown evidence id and an unknown resource id — and because the peer-answer phase requires the responder to hold a valid finding, Cooling covered each time and no peer answer was possible. After the grounding fix the rerun passes **18/18** (`…/L3-team-v4-grounded/`, 205 s): four consumed answers across both rounds (`workload → [cooling,lead]` and `cooling → [lead]`, twice) and `no cover occurred`.
>
> **No live run is citable yet.** All seven reports under `apps/agent/live-results/agent-team-2026-11-08/` record a `-dirty` commit, v4 included (`1a4c94f-dirty`), so no run can be re-derived from the repository. A clean-HEAD rerun after the next commit is required before any of this is quoted as evidence. Do not drop the cover-rendering guidance below on the strength of v4: covers still happen (SB/SBK), and the surfaces must render them.
>
> **Still open:**
> - A SIGKILL *during* a round (interrupted) is unit-tested only.
> - 4 web e2e failures predate this work.
>
> **Next work:** `plans/BACKEND-PROD-INTEGRATION.md`. The text below is the original handoff, kept for reference.

**Written:** 2026-11-08 08:15 CST, from commit `3ad6642` on `Prod-Multi-Agent-System`. Line numbers refer to that commit.
**Status:** research and design only. Nothing has been merged, built or changed; this file is the whole output of that session.
**Start here:** read this file, then `plans/MULTI-AGENT-HACKATHON-PLAN.md` §0 and §0.9, then begin at Stage 1. Re-check the clock and the facts below against the code before acting: they were true at `3ad6642`.

## Context

DataCenterOS is a simulated 8-rack, 64-GPU digital twin with a crash-safe recovery agent, built for HackUTD. Nemotron assesses and chooses, deterministic code simulates and enforces safety, and SpacetimeDB holds state and the action ledger. This branch adds three model agents in one process: Cooling, Workload and Recovery Lead (`plans/MULTI-AGENT-HACKATHON-PLAN.md` §0; status in §0.9).

**Goal:** merge the backend with the new frontend on `origin/r/ui-v2`, and restructure the backend and Workflows tab so the tab is dynamic and clearly shows the agents and their processes. Kaushik accepts a full restructure if needed, and asked for good frontend design skills to be used.

**Clock:** team schedule has feature freeze at 10:00 and submission 11:00–11:30 (`plans/team/RUNBOOK.md`; `PLAN.md` says 11:30). Check the time before choosing scope.

## Decisions Kaushik approved

1. **Theme:** keep the dark console that `r/ui-v2` ships. `apps/web/DESIGN-DIRECTION.md` is left over from `r/redesign`: its cream-paper tokens exist nowhere in the `r/ui-v2` code and it says the sidebar is gone, which is false. Use only its motion (§3), honesty and accessibility (§7) rules. Add a note at the top of the doc saying so.
2. **Scope:** staged work, every stage demoable. See Stages below.
3. **Layout:** a live team stage (Cooling, Workload, Lead) above a timeline of the whole recovery, with the decision trace, ledger and event log below.
4. **No agent connected:** replay a real saved Nemotron trace, badged RECORDED.

## Before you start

- **Commits:** Kaushik commits himself. Do not commit or push. Give him commands with short plain messages, always including `git add`.
- **Never merge `origin/r/multi-agent`.** Kaushik dropped it (zones, agent messages, per-incident workflows).
- **Sign-off still unconfirmed:** `plans/team/README.md` gives `apps/web` to Karthik, the runbook restricts behaviour edits to `App.tsx`, `styles.css`, `workflows/*`, `feed/*`, `ledger/*`, and `main` needs Suvan's approval. The sprint plan says only Kaushik and Claude work on this. Ask Kaushik whether anyone must sign off.
- **Do not touch** `apps/db`, `packages/contracts` or generated bindings; no republish is needed. Any prod republish needs Kaushik's explicit OK.
- **Secrets:** never print or commit `.env.local` or `~/.dcos-tokens/*`. Agent config comes from the repo-root `.env.local`; Vite reads only `apps/web/.env.local`.
- **Toolchain:** `source ~/.nvm/nvm.sh && nvm use 22` before `pnpm`.
- **zsh traps:** quote git refs (`git show "origin/r/ui-v2:apps/..."`, because `$B:a` is a zsh modifier) and do not `echo =====` unquoted.
- **Subagents:** pass `model: "haiku"` for search-only ones. Code-writing ones keep the default.
- **Stale docs:** `plans/FEATURES.md` and the web README are behind the code (README still says `connect()` is a stub). Code wins. Actor values are `nemotron | code`; stages are `triage, diagnose, plan, safety, execute, replan, verify, escalated, done`.

## What the code does today

**Merge:** `r/ui-v2` is 20 commits ahead and changes only `apps/web`; this branch is 6 ahead and changes none of it. `git merge-tree` reports no conflicts.

**Data path:** the team round runs in `planner.ts:925` and is built in `team/round.ts`. The trace is saved as `workflow.state.team` at `agent-loop.ts:409` (plan) and `:763` (replan). `workflow.state` reaches the browser whole through `onWorkflows` (`packages/db-client/src/live.ts:333`); `state_json` has no size cap.

**Gaps blocking a dynamic tab**

| Gap | Where |
|---|---|
| `state.team` is written only after a round ends, so nothing changes while agents think | `agent-loop.ts:409`, `:763` |
| Each round overwrites the last; L3 had two rounds, only one survives | same |
| `TeamMessage` has no timestamps; no per-call status, phase or timeout record | `team/protocol.ts:13-39` |
| Team feed rows are clipped to 200 characters, carry no evidence or round IDs, and arrive as a burst | `team/protocol.ts:118`, `agent-loop.ts:524` |
| Nothing in `apps/web` reads `state.team`, `state.recovery`, `waiting_jobs` or `operator_jobs` | r/ui-v2 |
| Agent room shows six old seats; Cooling, Workload and Lead all land on Planner, supervisor events on Simulator | r/ui-v2 `agent-room/seat-of.ts:32` |
| Cross-agent bubbles parse only `agent_message` (dropped branch), never `team_message` | r/ui-v2 `agent-room/room-view.ts:134` |
| Default mode is in-browser physics with no agent, so a team view would be empty | r/ui-v2 `dashboard.ts:136` |

**Saved real traces** (`apps/agent/live-results/agent-team-2026-11-08/`; all real Nemotron on local `dcos-r-local`):

| File | Round | Calls | Wall | Messages | Cover |
|---|---|---|---|---|---|
| `L3-team-scene-a/L3.json` | `a1:e1` | 5 | 9.0 s | 7 | none |
| `L3-team-scene-a/L3.json` | `a2:e3` | 4 | 12.1 s | 5 | Cooling covered Workload |
| `SBK-team-scene-b-kill/SBK.json` | `a2:e2` | 5 | 14.4 s | 7 | none |
| `SB-team-scene-b/SB.json` | `a2:e2` | 4 | 18.6 s | 4 | Cooling covered Workload |
| `L1-team/L1.json` | `a1:e1` | 5 | 11.0 s | 7 | none |

These hold only the trace (v1, no per-message timing), not `agent_event` rows.

## Stages

Do them in order. Stop at any boundary and the result still ships.

### Stage 1: merge, live mode, correct attribution

- `git merge origin/r/ui-v2` into `Prod-Multi-Agent-System` (Kaushik runs the commit).
- Run the web app in live mode (`VITE_DATA_MODE=live`, `VITE_STDB_DB=dcos-r-local`) against an agent with `DCOS_AGENT_TEAM_MODE=multi`, and confirm every page renders. `connect` hardcodes `runId: 'run-demo-1'` (`dashboard.ts:134`), which matches the harness.
- `seat-of.ts`: add `cooling`, `workload`, `lead` seats, parsed from the `team_message` tool call (args are `<kind> <from>-><to>`). Supervisor rows must not land on Simulator.
- `room-view.ts`: build cross-agent bubbles from `team_message`; remove `agent_message`, `TOPICS` and zone handling. Update the `2 Nemotron seats · 4 code seats` line in `AgentRoom.tsx`.

### Stage 2: live agent progress (backend)

Additive. `single` mode must stay unchanged.

**Trace v2 in `team/protocol.ts`** (keep every v1 field):
- `TeamMessage.t_ms`: offset from round start.
- `TeamTrace`: `status: 'running' | 'closed' | 'interrupted'`, `phase: 'findings' | 'peer_answers' | 'cover' | 'decide' | 'closed'`, `started_unix_ms`, and `budget` from `TEAM_BUDGET`.
- `TeamTrace.calls[]`: `{ role, phase, started_ms, ended_ms | null, status: 'running' | 'ok' | 'timeout' | 'rejected' | 'failed' }`, bounded.
- Check every reader of `version === 1` first, especially the live harness's team assertions and `malformed_workflows` in `apps/agent/scripts/live/`.

**Progress reporting in `team/round.ts`:** add an optional `onProgress(trace)` to `ChooserInput` (`planner.ts:32-40`, a frozen interface owned by the main session). Call it on phase change, call start, call end and message post. It must never throw into the round or delay it.

**New `team/progress.ts`:**
- `createTeamProgressSink({ write, minIntervalMs, log })`: one write in flight, latest wins, about 300 ms apart, with `drain()`.
- `withTeamProgress(chooser, sink)`: wraps a chooser and always awaits `drain()` before returning. `coord.updateStage` is compare-and-swap on `version` and is not serialized, so the final save at `agent-loop.ts:409` must not race a progress write.
- Pass the wrapped chooser at `agent-loop.ts:407` and where the replan is set up (about `:748`). `replan.ts` needs no change.
- `write` must keep the current stage: `coord.updateStage(coord.lease().workflow.stage, { team })`. A `plan` write during a replan would move the workflow backwards.
- Check how `isLostError` treats a version conflict. A failed progress write is logged and ignored; if ownership is lost, stop writing. Heartbeats do not bump `version` (`coordinator.ts:349`), so they are safe.

**Round history:** when a new round starts, move the previous `state.team` into `state.team_rounds` (keep the last 4, plus a dropped count). A trace still `running` becomes `interrupted`, which is how a SIGKILL mid-round shows up. A crash reruns the round, so handle a repeated `round_id`.

**Small additions:** pass evidence IDs through to team feed rows. Leave the rule that the feed never shows an unsaved round.

**Tests** in `apps/agent/test/team/`: progress order; coalescing; a throwing `write` does not affect the round; `drain` runs before the final save; stage preserved during replan; history bounds; `interrupted` marking; a late reply after the deadline changes nothing.

### Stage 3: the new Workflows tab

Everything lives in `apps/web`. Load the `dataviz` skill before writing the timeline or budget meter. No new npm dependencies; SVG and CSS are enough.

- **`components/team/team-view.ts`:** pure tolerant reader for `state.team`, `state.team_rounds` and `state.recovery`, following `readVerification` in `workflow-view.ts`. V1 traces show sequence with "timing not recorded".
- **`TeamStage.tsx`:**
    - Three agent nodes, then a Code safety gate, then Coordinator. The gate makes the rule visible: findings inform, code decides.
    - Node states come from `calls[]`: thinking, done, timed out, covering.
    - A message draws an edge with a travelling dot, using the seen-ID pattern at `AgentRoom.tsx:53` so nothing animates on first paint. Solid edge only when `consumed_by` contains the recipient; otherwise dashed and labelled "not consumed".
    - Budget readout: calls used of 6, seconds of 30, and whether the Lead or deterministic code decided.
    - Beside it, a live transcript with the full 400-character text from `state.team`, evidence and resource IDs, and a CLAIM label.
- **`RecoveryTimeline.tsx`:** ordinal chapters for the whole workflow: Round a1, Execute, Waiting (`state.recovery`), Agent killed and takeover (`state.resumed`), Round a2, Verify. Bars are to scale only inside a round. Team calls use wall time and actions use sim time, so never put them on one axis without a real mapping.
- **Rail and status:** show the Compare step of `TRACK` as "Team round" when a trace exists (keep the ID). Make `workflow-view.ts` read `state.recovery` for a real waiting status and `operator_jobs` for "needs an operator".
- **`WorkflowsPage` order:** workflow selector, stage plus transcript, timeline, `DecisionTrace`, all cards. Keep the Ledger, Event log and Model tabs.
- **Keep e2e hooks:** `#workflows`, `.wf-card`, `.decision-trace`, `table.dt-table`, `#ledger`, `#event-log`, `.feed-event`.
- **Motion and access:** follow the `DESIGN-DIRECTION.md` §3 timings; `prefers-reduced-motion` must still tell the whole story. WCAG AA, keyboard operable, no horizontal scroll at 320 and 390 px. `aria-live` only on the transcript.

### Stage 4: RECORDED replay

- Add a `recorded` value to `Preview` (`dashboard.ts:7`), an option in `TopBar.tsx:46`, and a `recorded` field in `PageProps`.
- Add a `loadRecordedRun` modelled on `loadRecoveryExample` (`data/recovery-example.ts:18`).
- **Data:** prefer a fresh v2 capture from a live run after Stage 2, which has real timings. Otherwise use `L3.json`: cooling scene, two rounds, a replan and a cover. Copy only real fields; the files have no feed rows, so do not invent any.
- Every surface shows RECORDED with model, date and database. A v1 replay must be labelled "replay pacing, not recorded timing".

### Stage 5: polish and docs

- Run `/design-review` on the Workflows tab with live and RECORDED data, and fix what it finds. Use `/plan-design-review` or `/design-shotgun` before Stage 3 only if there is time.
- Update `plans/FEATURES.md`, the web README and the Devpost team text. Add the note to `DESIGN-DIRECTION.md`.

**Cut order if time runs out:** Stage 5 polish, then Stage 4, then the timeline. Keep the Stage 1 attribution fix and the team stage.

## Honesty rules (must hold on every surface)

- Show only persisted data. Attribution comes from the `actor` field and from role fields in the trace; no actor means "unattributed".
- Findings are claims. Live runs produced factually wrong ones (§0.9), so never present them as facts.
- Do not promise a conversation every round: when Workload times out, Cooling covers and no peer answer happens. Show that as it happened.
- The demo must say: findings inform choices but deterministic safety decides; a running action cannot be interrupted; the agent process restarts, but a machine failure is not covered; better recovery from the team is unmeasured (§0.8).
- Team mode is proven on the local database only, in single runs. L2, L4–L6 in team mode, `dcos-dev` and prod are all untested.
- A restarted workload is not a repaired pump or GPU. Keep SIMULATED, REAL, NEMOTRON, CODE, MOCK, EXAMPLE and RECORDED labels visible.

## Critical files

- Agent: `apps/agent/src/team/{protocol,round}.ts`, new `team/progress.ts`, `agent-loop.ts`, `planner.ts` (interface only), `apps/agent/scripts/live/*` (v2 compatibility).
- Web: `apps/web/src/pages/WorkflowsPage.tsx`, `components/workflows/{WorkflowBoard.tsx,workflow-view.ts}`, `components/agent-room/{seat-of,room-view}.ts`, `AgentRoom.tsx`, new `components/team/*`, `data/dashboard.ts`, `components/shell/TopBar.tsx`, `app/page-props.ts`.

## Verification

- **Agent:** `pnpm --filter @dcos/physics build`, `pnpm --filter agent test`, `pnpm --filter agent typecheck`. The baseline at last report was 540 passing tests.
- **Web:** `pnpm --filter @dcos/web test`, `build`, `test:e2e`, with new unit tests for `team-view` and the seat mapping.
- **Live, end to end:** use the Scene A and Scene B harness under `apps/agent/scripts/live/` (see plan §11 and §0.8) against `dcos-r-local`, with the dashboard open in live mode. The exact commands were not checked for this handoff; read the scripts first. Confirm with the `/run` skill or a browser:
    - nodes change state while the round is running, not only afterwards;
    - both Scene A rounds stay visible after the replan;
    - a SIGKILL mid-round shows as interrupted, then takeover;
    - a timeout shows the cover;
    - harness team checks still pass and there are no duplicate actions or new version-conflict failures.
- **Announce to the team** before any `dcos-dev` run. Fake-LLM tests are not evidence of live multi-agent recovery.
