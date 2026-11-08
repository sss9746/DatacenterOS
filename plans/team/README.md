# Fixed-cluster sprint: three-way split (from 01:30 Sun, Nov 8)

Source of truth: Asta's [IMPLEMENTATION-SCOPE](../IMPLEMENTATION-SCOPE.md), [TASKS](../IMPLEMENTATION-TASKS.md) and [STATUS](../IMPLEMENTATION-STATUS.md). This folder only says **who** does each R task and **when work is handed over**. If anything here disagrees with Asta's specs, the specs win.

| Person | File | Tasks | Branch |
|---|---|---|---|
| **Suvan + Claude orchestrator** (majority) | [SUVAN.md](SUVAN.md) | R0 schema, R1, R3, R5, R6 (adapter, counters, run), integration, final review | `lane/p3-agent`, `lane/p1-sim`, `int/r-sprint` |
| **Kaushik** (P2) | [KAUSHIK.md](KAUSHIK.md) | R2, R0 DB/client round-trip, module republish, dev-DB custody, prod switch | `lane/p2-db` |
| **Karthik** | [KARTHIK.md](KARTHIK.md) | R4 live dashboard, R6 scoreboard UI, R7 rehearsal, video, Devpost | `lane/p4-web` |

## Timeline (feature freeze 10:00, submit 11:30)

| By | Milestone |
|---|---|
| 03:30 | **M1:** R0 schema on `int/r-sprint`. R2 merged to `int/r-sprint`. |
| 05:00 | **M2:** R1 and R3 merged to `int/r-sprint`, full suite green. Kaushik republishes `dcos-dev` from `int/r-sprint`. |
| 07:00 | **M3:** R5 L1–L3 pass on `dcos-dev`; the real-Nemotron 12-case matrix is saved; R4 live-mode proof. |
| 08:30 | **M4:** `int/r-sprint` → `main` (Suvan approves). Switch the demo to prod `dcos`; rehearsal #1. |
| 09:30 | **M5:** Rehearsal #2, backup video recorded. |
| 10:00 | Feature freeze. After this, only fixes for things that break the demo. |

## Handoffs between people

| From → To | What | When |
|---|---|---|
| Suvan → Kaushik, Karthik | `packages/contracts` with optional `EvaluationResult.provenance` (CONTRACTS §0.14), types regenerated | M1 |
| Kaushik → Suvan | R2 merged; `dcos-dev` republished with R1 physics, which runs **inside the module** (R1 has no live effect until the republish) | M1 / M2 |
| Suvan → Karthik | Measured result rows + manifest at `apps/evaluation/results/<batch>/` | M3 |
| Kaushik → Karthik | A typed read helper for the plan's candidate options and the handoff, **only if** the current projections don't include them (R4.5) | as soon as Karthik asks |
| Karthik → Suvan | Browser witness (recording plus console log) of the R5 run, same commit and DB | M3 |

## Shared rules

1. **One integration branch, `int/r-sprint`, cut from `main` at `80b1d6e`.** Lane branches merge into it; it reaches `main` only with Suvan's OK. Never force-push.
2. **`dcos-dev` is a single shared resource.** Kaushik holds the lock. Post "taking dev" / "releasing dev" in team chat before you reset or run anything live. Nobody resets **prod `dcos`** before M4.
3. **One Nemotron key, one consumer at a time:** either the R6 matrix run or the R5 rehearsal, never both at once.
4. **Honesty rules (scope §7–8):**
   - Every number comes from a saved artifact.
   - A run with no model calls is labeled "deterministic planner", **not** Nemotron.
   - Ties and losses are shown.
   - No real-world savings claims.
   - The current `deterministic-2026-11-08.json` 24% figure is a **deterministic-only** result.
5. **Cut order if late:** hardware first, then advanced fault buttons, then polish, then going from 20 to 12 cases. Never cut: hard safety, the hidden-truth boundary, real crash/overlap evidence, the handoff, honest provenance.
6. Secrets stay in `.env.local` and on the presenter laptop. Never put `VITE_ADMIN_TOKEN` on Vercel.
