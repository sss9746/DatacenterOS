# DataCenterOS frontend: what it has (06:35 Sun, Nov 8)

App: `apps/web` (React + Vite + TypeScript). Deployed via the Vercel CLI from Suvan's account. Two versions exist:

| Version | Branch | Status |
|---|---|---|
| **Current (shipping fallback)** | `int/r-sprint` / `stable/working-single-agent` | Merged, all checks green |
| **UI v2 (candidate)** | `r/ui-v2` | Awaiting owner review; preview http://127.0.0.1:5196 (mock). Tweaks in progress: old rack/GPU pictures back, Real GPU moved to the Cluster page top-right |

Both keep the dark operator-console look. UI v2 adds a left sidebar with separate pages.

---

## UI v2: page by page

### Global shell
- **Left sidebar nav** (hash routes, deep links, back button): Cluster · Training jobs · Recovery activity · Workflows · Benchmarks. *(Real GPU is being moved into Cluster.)*
- **Top bar:**
  - sim clock
  - mode badge (MOCK / LIVE) + **SIMULATED** label
  - connection status
  - Run view selector (Local physics / Recovery example)
  - speed and Pause
  - **Demo controls** button
- **Demo controls drawer** (local/admin only; never in the public build):
  1. Break cooling pump A
  2. Try unsafe move → hot rack 6 (shows the **BLOCKED** reason inline)
  3. Fail a GPU (XID 79), with a smart default target
  4. Reset run

  Plus "Advance 30 sim-s" and an **Advanced** form with every fault option. Killing an agent is done from the presenter terminal; the browser never gets process control.

### 1. Cluster overview (`#/cluster`)
- One plain-English sentence: "All 64 GPUs healthy", or "Pump A is failing; racks 2–4 heating · 1 GPU failed".
- **8 racks × 8 GPUs** (old cabinet/tile pictures being restored): heat colors, temperature on hover, failed tiles ✕ with a red flash on XID.
- Pump A / Pump B cooling loops with animated coolant; the **degraded loop slows and turns amber**, and its racks are ringed ("On degraded Pump A").
- **Impact tiles:** pumps degraded · racks hot · GPUs failed · N of 3 jobs protected · **unsafe moves blocked**.
- **REAL NVIDIA GPU (Brev L40S)** tile, top right above "unsafe moves blocked" *(in progress)*:
  - live temperature, power, utilization, clock
  - REPLAY badge for the recording; "collector offline" when stopped
  - observation only

### 2. Training jobs (`#/jobs`)
- One card per job (job-a, job-b, job-c):
  - **two-layer progress bar**: work done vs work checkpointed (safe)
  - "% safe" shield
  - "N work units at risk since the last checkpoint"
  - status chip: running / checkpointing / moving / restarting / failed / done
  - racks it's on, with a **move indicator** ("R4 → R5") during migration
  - **what the agent decided** for the job (keep / cap / checkpoint + move), with a NEMOTRON or CODE badge, from the saved candidates

### 3. Recovery activity (`#/recovery`)
- **Agent room:**
  - **6 seats:** Triage and Planner (**NEMOTRON**), Simulator, Safety, Coordinator, Verifier (**CODE**); unknown → "Unattributed", never guessed
  - **chat bubbles** with handoff arrows (Triage → Planner → …), 2-line summaries, tool details on click
  - **one thread per incident** (tabs), each with an **owner chip** ("owned by agent-alpha")
  - **takeover / resume dividers** ("agent-alpha stopped → agent-beta took over")
  - **Agents ↔ lane:** agent-to-agent messages (cross-zone move, ack/conflict, incident update, takeover) with topic chips
- **Incident cards:** What happened · Why (evidence: shared cause vs independent) · What the agents decided · Status now · Evidence disclosure.
- **"Evidence the agents recovered":** takeover/resume, skipped duplicate, verified window (progress before → after, destination), needs-a-human items, blocked moves with reasons.

### 4. Workflows (`#/workflows`)
- Tabs: **Workflows · Ledger · Event log · Model.**
- **Workflow cards:**
  - owner chip and plan attempt
  - stage track (triage → diagnose → compare → safety → execute → verify); Safety turns red with the reason when a move was blocked
  - **chosen vs rejected options** with predicted lost work ("not simulated" when unknown)
  - **Recovered ✅ / Needs a human ⚠** handoff cards (verified window, next step)
- **Ledger:** every action's lifecycle, with **BLOCKED** reasons in plain English.
- **Event log:** the full agent feed with All / Nemotron / Code filters.
- **Model:** simulation assumptions, signals and provenance.

### 5. Benchmarks (`#/benchmarks`)
- **3 big numbers** (lost work): Reactive **127,558** · Threshold **35,468** · Nemotron **18,800**.
- Wins / ties / losses: **4W · 7T · 1L vs threshold** (6W · 5T · 1L vs reactive).
- Provenance line: "76 live Nemotron calls + 51 cached + 3 fallbacks across 127 model requests", plus a mixed-provenance warning.
- **Losses list open by default** (honesty); per-scenario table in a disclosure.
- Mock: "Load Nemotron batch" button. Live: reads published evaluation rows.
- Never color-favors a deterministic-only batch.

---

## Honesty rules built into the UI
- **SIMULATED** label always visible on the cluster; **REAL / REPLAY** only on the L40S tile.
- NEMOTRON vs CODE comes only from the saved `actor` field.
- **EXAMPLE** label on every scripted Recovery-example surface. The example alpha/beta messages are not live.
- A failed live connection never silently shows mock data.
- Null metrics show "not simulated", never 0.
- The admin token only works in local dev builds; the Vercel build refuses it.

## Quality
- **169 web tests**, type check clean, production build OK.
- **Playwright e2e 10/10** (desktop + mobile) with **axe WCAG 2.1 AA** checks; no horizontal scroll at 390 px; 0 console errors on all pages.
- Animations use transform/opacity only and respect "reduce motion".

## Not yet done (frontend)
- Owner review of UI v2 → merge into `int/r-sprint`.
- The in-progress tweaks (old rack pictures, Real GPU on Cluster).
- **Live deploy to Vercel** on prod `dcos` at 08:30. Today's public site is still the old mock build.
- The Agent room shows the scripted EXAMPLE until the multi-agent backend merges and L7 passes live.
