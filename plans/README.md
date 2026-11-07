# DataCenterOS team plans: start here

Four people work at the same time across five lanes. **Each person owns their own folders, so merges don't collide.**

| Lane | Person | Your plan file | You own |
|---|---|---|---|
| **S: Core engine + integrator** (run with many Claude agents) | **Suvan** | [`LANE-S-core.md`](LANE-S-core.md) | `packages/physics/`, `eval/`, root files, CONTRACTS.md, **merging everything** |
| **B: SpacetimeDB** | Teammate B | [`LANE-B-spacetime.md`](LANE-B-spacetime.md) | `spacetime/module/`, bindings, publishing, tokens |
| **C: AI agents** | Teammate C | [`LANE-C-agents.md`](LANE-C-agents.md) | `agents/` |
| **D: Frontend + pitch** | Teammate D | [`LANE-D-frontend.md`](LANE-D-frontend.md) | `apps/web/`, `docs/pitch/`, Devpost |
| **A: Hardware + fan ML + QA** | **The whole team, shared** (whoever is free or blocked picks up the next A task, and claims it in `plans/status/A.md` first) | [`LANE-A-hardware.md`](LANE-A-hardware.md) | `hardware/`, `scripts/demo_check.py`, `qa/` |

> **The team is 4 people with 5 lanes.** S, B, C and D each have one owner. Lane A (hardware) is done together: whoever is free picks up the next A task.

> ## ⚠️ Scope: Tier 1 first, and only Tier 1 until it's tagged
> The full plan is about 75–85 h of work, against about 55–60 human-hours available. **Build Tier 1 only, and tag `tier1` by 1:00 AM.** Start Tier 2 work only after that tag exists.
>
> **Tier 1 (the version that wins):**
> 1. Preset facility (the Pump A trap), with no builder
> 2. The real fan driving rack_3, using the RMS-threshold detector
> 3. The safety engine blocking the Pump A shutdown
> 4. Agents: diagnose the ticket lie, test 3 plans with `simulate_plan`, execute, verify
> 5. Live dashboard: facility graph, agent steps, plan cards, fan panel
> 6. A **20-scenario** eval, giving one real number
>
> **Tier 2** (after 1 AM; each piece is independent and can be cut freely): builder + compiler, frozen sensor, fan autoencoder, Challenge mode, verified handoff, 50-scenario eval, Results page.
>
> **Cut outright:** UPS/power scenarios, inference on the ESP32 itself, the 2-vs-3-pump comparison, everything marked stretch.
>
> If a lane file says "Phase 2/3" for something that isn't in Tier 1, it's Tier 2.

**The two files everyone reads:**
1. **[`CONTRACTS.md`](CONTRACTS.md):** every shared name, table, function, endpoint and JSON shape. **If you're unsure, it's in there. If it isn't in there, ask Suvan; don't invent it.**
2. **[`../PLAN.md`](../PLAN.md):** the big picture, the demo script, the risks and the cut list.

---

## First 15 minutes (everyone, together)
1. `git clone https://github.com/sss9746/DatacenterOS && cd DatacenterOS`
2. Read this file, your lane file, and CONTRACTS §0–§1 (about 10 minutes).
3. Create your lane branch: `git checkout -b lane/<s-core|b-spacetime|c-agents|d-web|a-hardware>`
4. Copy `.env.example` to `.env.local`. **Never commit `.env.local`.** Lane B hands out tokens over team chat, not git.
5. Create `plans/status/<S|B|C|D|A>.md` from the template in your lane file, and push your branch.

## Rules (humans and Claude agents alike)
1. **Only edit paths your lane owns** (CONTRACTS §0). Need something from another lane? Open a GitHub issue titled `REQUEST <lane>: …`.
2. **Contract changes:** open an issue titled `CONTRACT <lane>: …`. Only Suvan edits CONTRACTS.md. After 7:00 PM, changes are additive only.
3. **Build against fixtures first** (`packages/physics/fixtures/`, delivered by 6:15 PM), so nobody waits on anybody.
4. **Small commits:** `feat(<lane>): …`. Never commit secrets, `node_modules`, or recorded data over 5 MB.
5. **Merges to `main` happen only at sync points, done by Suvan:** 7:00 PM · 9:00 PM · 11:00 PM · 1:30 AM · 7:30 AM · 9:45 AM.
   - Before each sync: `git fetch && git rebase origin/main`, run your lane's checks, open a PR into `main`.
6. **Update `plans/status/<lane>.md`** at every sync: done / doing / blocked / needs from others.
7. **Feature freeze is 10:00 AM Sunday.** After that, only `fix(demo):` commits, approved by Suvan.

## Telling a Claude Code agent to do your work
Paste this into Claude Code, opened in your worktree:
```
Read plans/README.md, plans/CONTRACTS.md and plans/LANE-<X>.md. Do task <TASK-ID> exactly as written.
Only edit files your lane owns. Do not change contracts. Run the task's definition-of-done checks,
commit with "feat(<lane>): <task-id> <summary>", and report: files changed, how verified, open questions.
```
Each lane file also has **ready-to-paste prompts for parallel sub-agents**, each in its own `git worktree`.

## Timeline at a glance (Sat → Sun)
| Time | Milestone |
|---|---|
| 4:45–6:00 PM | Phase 0: hello world through every layer |
| 6:15 PM | Fixtures delivered (S) |
| **7:00 PM** | **Contract freeze v1** + first merge |
| 9:00 PM | First live integration (tick → dashboard, fan → rack_3) |
| **10:45 PM** | **Devpost registered** (D) + track limit confirmed with an organizer |
| **11:00 PM** | **MVP tagged** (the Pump A trap + the real fan) |
| 1:30 AM | Merge, then A and D sleep (1:30–4:30) |
| 3:00 AM | Hard piece tagged: plans tested in simulation, execute + verify, frozen sensor, fan model |
| 4:30–7:30 AM | S and C sleep |
| 7:30 AM | Everyone back: builder + eval + Challenge mode integrated |
| 9:30 AM | Backup demo video recorded |
| **10:00 AM** | **Feature freeze** |
| **11:30 AM** | **Submitted** (deadline 12:00) |
| 1:00–4:00 PM | Judging |

## How long it takes
Rough estimate: **about 70–80 person-hours of work.**
- With 4 people, plus Claude agents running in parallel in Suvan's lane (and optionally the others), the **MVP lands by about 11 PM to midnight**, after about 6 hours of building.
- The **full feature set** (hard piece + builder + eval) lands by about **7:30 AM**.
- That leaves about 2.5 hours for polish, the video and submission.
- **If you're behind at 3:30 AM,** apply the PLAN.md §9 cut list in order. Never cut the Pump A trap, the real fan, the live agent steps, `simulate_plan`, or one measured number.

## Hardware backup (details in LANE-A-hardware.md)
1. The GY-521 vibration sensor fails → use the **Big Sounds** mic module (same pipeline, sound instead of vibration).
2. The ESP32 fails → use the **laptop microphone** listening to the fan.
3. The fan or motor fails → use **replay mode**, which streams a **real recording** made earlier. The UI labels it "REPLAY OF REAL RECORDING". **Record backups by 9 PM.**
4. Everything fails → run a simulated fan, honestly labeled. The project still stands on 3 tracks; only the Best Hardware angle weakens.
