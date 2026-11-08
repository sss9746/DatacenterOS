# P2 checkpoints (Kaushik): SpacetimeDB + durability

> **Current follow-up (2026-11-08):** [audited status](../../../plans/IMPLEMENTATION-STATUS.md) and [remaining tasks](../../../plans/IMPLEMENTATION-TASKS.md) supersede the original deadlines. Complete R2 start-time safety and support R0/R5 before optional P2-9. Existing Gate 2 proves DB/caller durability; full agent crash/overlap and live browser proof remain open. Historical test counts below were not rerun for this documentation update.

The P2 lane split into one file per task. Source of truth for scope: [`plans/LANE-P2-db.md`](../../../plans/LANE-P2-db.md). If a checkpoint file and the lane file disagree, the lane file wins (and CONTRACTS §0 beats both).

## R-sprint board (current)
Split: [`plans/team/KAUSHIK.md`](../../../plans/team/KAUSHIK.md). If this board disagrees with the specs, the specs win.

| # | Checkpoint | Due | Gate | Depends on | Status |
|---|---|---|---|---|---|
| K0 | [Branch, baseline, local target](P2-K0-branch-baseline.md) | before K1 | — | — | ☐ |
| K1 | [R2: `start_action` fails closed](P2-K1-start-fail-closed.md) | M1 03:30 | Gate 2 | K0 | ☐ |
| K3b | [Plan + workflow read helpers](P2-K3b-plan-workflow-reads.md) ‖ | when Karthik reaches C1.5 | Gate 3 | K0 | ☐ |
| K2 | [R0: provenance round-trip](P2-K2-provenance-roundtrip.md) | before M2 republish | Gate 4 | `origin/r/r0-provenance` | ☐ |
| K3 | [Republish `dcos-dev` + controlled reset](P2-K3-republish-reset.md) | M2 05:00 | Gates 2–3 | R1, K1, K2 | ☐ |
| K4 | [Prod switch](P2-K4-prod-switch.md) | M4 08:30 | Gates 3–4 | Suvan's approval | ☐ |

## Board (kickoff, historical)
| # | Checkpoint | Due | Gate | Depends on | Status |
|---|---|---|---|---|---|
| 0 | [Setup + booth questions](P2-0-setup.md) | 8:15 PM | — | — | ☑ (booth Qs never asked; not blocking) |
| 1 | [Scaffold module + publish + bindings](P2-1-scaffold.md) | 9:00 PM | **Gate 0** | P2-0 | ☑ |
| 2 | [db-client wrapper + mock](P2-2-db-client-mock.md) ‖ | 9:00 PM | Gate 0 | P1 fixtures (or local stand-ins) | ☑ (+ P3/P4 mock fixes, `onActionDetails`) |
| 3 | [Tier 1 tables + `create_run`](P2-3-tables-create-run.md) | 10:45 PM | — | P2-1, P1 `buildPreset` | ☑ (`gpu-real-0` row → P2-9) |
| 4 | [`advance_tick` + `inject_fault`](P2-4-tick-faults.md) | 11:30 PM | **Gate 1** | P2-3, P1 `step` | ◐ (P4 live view unconfirmed) |
| 5 | [Action ledger](P2-5-action-ledger.md) | 1:00 AM | — | P2-4, P1 `evaluateSafety` | ☑ |
| 6 | [Workflow + incidents](P2-6-workflow-incidents.md) ‖ | 1:15 AM | — | P2-3 | ☑ |
| 7 | [Gate 2 script](P2-7-gate2-script.md) | 1:30 AM | **Gate 2** | P2-5, P2-6 | ☑ (dev + prod; integrator ticks plans/README) |
| 8 | [Prod publish + tokens](P2-8-prod-tokens.md) | 4:30 AM | Gate 3 | P2-7 | ◐ (prod live, P3 verified; P4 open) |
| 9 | [`ingest_observations`](P2-9-ingest.md) | 8:00 AM | Gate 5 (optional) | P2-8 | ◐ (proven on `dcos-dev`; prod at K7) |

**Historical report (2026-11-08 ~00:40):** completed P2 work merged to `main` (`08f39d3`; reported suite 697 tests green). Prod `dcos` is live on Maincloud with role tokens. P3's agent + real Nemotron handled the pump-a incident end to end on both `dcos-dev` and `dcos`. Open: P4 dashboard live check, optional P2-9, and the follow-up safety/recovery proof above.

Status key: ☐ not started · ◐ in progress · ☑ done (all "Done when" boxes ticked) · ⛔ blocked (say why in the file).

## How a checkpoint moves
1. **Codex (architect)** reads the checkpoint file and writes into its `## Architect notes` section: anything it wants changed or pinned down. It may leave the section empty.
2. **Claude (coder)** implements it, runs the "Done when" checks and fills in `## Implementation report` (files, how verified, open questions).
3. **Codex reviews** the diff (`codex review` run by Claude, or by you in Codex.app) and appends findings under `## Architect notes`.
4. **Claude** ends the checkpoint with a quick summary report (what changed, how it was verified, what's still open) and the exact `git add` / `git commit` / `git push` commands for the current sprint branch. Claude never runs them.
5. **Kaushik** runs those commands, ticks the board above, and updates [`plans/status/P2.md`](../../../plans/status/P2.md) at each sync.

## Rules that apply to every checkpoint
- Edit only `apps/db/**`, `packages/db-client/**` and `plans/status/P2.md`.
- Wire types come from `@dcos/contracts`; never hand-write a duplicate type. Need a contract change → write `CONTRACT request` in `plans/status/P2.md` and stop.
- Validate every JSON reducer argument with `validatePayload()`; reject with the stable reason codes (CONTRACTS §0.7 + `BAD_PAYLOAD`, `UNAUTHORIZED`, `COMMAND_KEY_COLLISION`, `STALE_FENCING_TOKEN`, `LEASE_HELD`).
- Schema changes after 9 PM are **additive only**.
- Never commit tokens, `.env.local` or `node_modules`.
