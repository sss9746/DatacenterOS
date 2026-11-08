# DataCenterOS · Design direction (redesign, HackUTD 2026)

**Direction in one line:** a warm, paper-and-ink operations room. Cream paper, forest-green ink, sage rules, and one
vivid orange that only ever means *heat, failure, or the agent acted*. Dense and scannable like a tool, with a few
dramatic, data-driven moments (a GPU dies, a handoff travels between agents) that make judges look up.

- **Purpose:** show a GPU cluster digital twin plus a crash-safe multi-agent recovery loop in a 3-minute demo.
- **Audience:** judges (NVIDIA, NMC² GPU-infra, SpacetimeDB) watching from 2 m away; the presenter driving it.
- **Tone:** industrial-editorial. Quiet surfaces, strong type, honest labels. No purple, no gradients-as-decoration,
  no cards inside cards.
- **Memorable detail:** the **Agent room** (specialist agents passing work to each other with a traveling handoff
  dot) beside a **cluster** whose tiles visibly cook, crack, and get drained by the agent.
- **Honesty is part of the look:** SIMULATED / REAL / NEMOTRON / CODE / MOCK / EXAMPLE labels are styled components,
  never hidden, never muted below AA.

## 1. Tokens (CSS custom properties on `:root`, defined in `src/styles.css`)

Light theme only (no dark toggle). Every colour below is a token; components never hard-code hex.

| Token | Value | Use |
|---|---|---|
| `--forest` | `#3E503C` | brand, primary buttons, header/masthead, Agent-room shell, NEMOTRON pill, selected states |
| `--forest-deep` | `#2C3A2B` | masthead bottom edge, hover of primary, agent-room gutters |
| `--ink` | `#1F2A1E` | body text on cream (≈13:1) |
| `--ink-muted` | `#5B6650` | secondary text on cream (≈5.2:1, AA for small text). **Never use `--sage` for small text on cream** (3.1:1) |
| `--sage` | `#7F886A` | borders, rules, icons, CODE actor outline, healthy heat, large (≥19px bold) labels only |
| `--sage-soft` | `#C9CDB7` | hairline fills, track backgrounds, inactive seat ring |
| `--cream` | `#F3ECDB` | page background |
| `--paper` | `#FAF6EC` | panels / cards (one step lighter than the page) |
| `--paper-inset` | `#EDE4CE` | inset wells, table header rows, code chips, tool-call chips |
| `--orange` | `#FF6F3D` | fills only: alerts, BLOCKED, failed-GPU flash, hot heat, "agent acted" accent, coolant-degraded line |
| `--orange-ink` | `#A8380F` | orange *text* on cream (5.5:1). Any small orange text uses this, never `--orange` |
| `--orange-soft` | `#FFD9CB` | alert backgrounds (text on it is `--ink` or `--orange-ink`) |
| `--amber` | `#E3B35A` | warm heat, warnings (fill only; text on it is `--ink`) |
| `--amber-ink` | `#7A5A12` | warning text on cream |
| `--cream-on-forest` | `#F3ECDB` | text on forest (7.7:1) |
| `--nvidia` | `#76B900` | **only** the REAL-hardware dot/badge and the Nemotron dot. Never for simulated values |
| `--focus` | `#1F2A1E` | focus ring (2px solid, offset 3px) on cream; on forest surfaces use `--cream` |
| `--job-a` / `--job-b` / `--job-c` | `#3E503C` / `#8A6A2F` / `#5A6E8C` | job identity outlines (forest / ochre / slate). Fills at 18% for progress |

Heat ramp (GPU tiles, rack glyphs, inlet readings). Transition `background-color 600ms`, `box-shadow 600ms`:

| State | Rule (unchanged from `SimulationView.stateOf`) | Fill | Text |
|---|---|---|---|
| healthy | `temp < 80` | `--heat-0: #DCE0CC` | `--ink` |
| warm | `80 ≤ temp < 85` | `--heat-1: #E3B35A` (amber) | `--ink` |
| hot (throttling) | `temp ≥ 85` | `--heat-2: #FF6F3D` (orange) | `--ink` |
| failed / unavailable / XID | `availability !== 'ready' \|\| last_xid_code !== null` | `--heat-fail: #5B2C1F` | `--cream` + `✕` glyph |
| no data | missing | `--paper-inset`, dashed `--sage` border | `--ink-muted` |

Radii: `--r-chip 4px`, `--r-control 8px`, `--r-panel 14px`, `--r-seat 999px`. Panels have **no drop shadow**; they are
`--paper` with a `1px solid color-mix(in srgb, var(--sage) 45%, transparent)` border. The only shadows: the Agent
room shell (`0 1px 0 var(--forest-deep)` inset feel) and the demo-controls bar when sticky.

## 2. Type

Google Fonts, loaded once in `index.html` (`preconnect` + one `<link>`):
`Bricolage+Grotesque:opsz,wght@12..96,400..800` (display), `Inter:wght@400..700` (UI), `JetBrains+Mono:wght@400;600` (data).

```
--font-display: "Bricolage Grotesque", "Inter", system-ui, sans-serif;
--font-ui:      "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
--font-mono:    "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
```
`body { font-family: var(--font-ui); font-feature-settings: "tnum" 1, "cv11" 1; }` — tabular numbers everywhere.

| Role | Face | Size / line / weight | Where |
|---|---|---|---|
| Hero number | display | 40 / 1 / 700, `letter-spacing: -.03em` | "61/64 GPUs ready", scoreboard headline totals |
| H1 | display | 30 / 1.15 / 700, -.025em | page title "Cluster operations" |
| H2 (panel title) | display | 19 / 1.25 / 650, -.015em | every `Panel` heading |
| H3 | ui | 14 / 1.4 / 600 | card titles (incident, job, seat name) |
| Body | ui | 14 / 1.5 / 400 | paragraphs, bubbles |
| Small | ui | 12.5 / 1.45 / 400–500 | meta rows, legends (**floor: 12px**; nothing smaller) |
| Eyebrow | ui | 11.5 / 1 / 650, uppercase, `.08em` | section labels ("SIMULATED CLUSTER", "AGENT ROOM"), badges |
| Data | mono | 12.5–13 / 1.4 / 400 | ids, times, temperatures, tool-call chips, ledger cells |

Nothing uses pure white text on cream; nothing uses orange text under 19px except `--orange-ink`.

## 3. Motion

- Easing `--ease-out: cubic-bezier(.2,.7,.2,1)`, `--ease-in-out: cubic-bezier(.65,0,.35,1)`.
- Durations `--t-fast 160ms` (hover, focus, chip), `--t-base 280ms` (enter/exit, tab change), `--t-slow 600ms`
  (heat colour, progress ring), `--t-drama 1400ms` (GPU failure sequence, handoff travel).
- **Transforms and opacity only** for anything that runs more than once; colour transitions are fine for ≤64 tiles.
  No animating `width/height/top/left`, no `filter` on tiles, no layout thrash. Use `will-change` sparingly on the
  element that is currently animating, remove after.
- Enter: `translateY(6px) → 0` + `opacity 0 → 1` at `--t-base`. Exit is instant or `opacity` only.
- Pulse (thinking seat, live REAL dot): `box-shadow` ring 0→7px over 1.8s infinite, `ease-out`.
- Handoff travel: one 8px dot moves along a straight line (SVG `<line>` + `<circle>` with `offset-path`, or
  `transform: translate()` keyframes computed from seat centers) over `--t-drama`; the line itself draws in with
  `stroke-dashoffset`.
- GPU failure (XID 79): `tile-fail` keyframes ≈ 1400ms once: 0% orange flash (`--orange`) → 15% scale(1.06) →
  40% `--heat-fail` + crack mask reveals `✕` → 70% ripple ring on the rack (`box-shadow` spread) → 100% settled.
  Triggered only on a *transition* of real store data (`last_xid_code` becoming non-null / `availability` leaving
  `ready`); on first paint with an already-failed tile, no animation.
- Heat haze (throttling): a pseudo-element with a 2-stop translucent gradient translating ±3px over 2.4s infinite,
  `opacity .5`. Never on more than the throttled tiles.
- `@media (prefers-reduced-motion: reduce)`: all infinite animations off, travel dot jumps to the end, failure
  sequence collapses to the final state, transitions ≤ 160ms. Everything must still be understandable without motion.

## 4. Layout (owned by Theme + Shell)

- Masthead: 60px, `--forest` background, cream text; brand "DataCenterOS" in display face; right side: mode badge
  (MOCK · fixtures / MOCK · local physics / LIVE DB · name) and the run view select (mock only). The old left sidebar
  is removed; sections are reachable through the skip link and anchor ids below.
- Page: `max-width 1560px`, gutters `clamp(16px, 2.4vw, 40px)`, background `--cream`.
- Title row: H1 + one-line subhead, right: sim clock / wall clock / connection chip, speed select, pause button.
- **Hero row (≥1200px):** `grid-template-columns: minmax(0, 3fr) minmax(400px, 2fr)`; left `#overview` cluster
  (SimulationView), right `#agent-room`. Both `align-items: stretch`; the Agent room is `min-height: 560px` with its
  own internal scroll for the chat stream. 930–1199px: same grid at `1.4fr 1fr`. <930px: stack, cluster first.
- Below the hero, in order: `#incidents` + `#workflows` (two columns ≥930px), `#activity` (full log, collapsed by
  default on phones) + `#ledger`, `#real-gpu` + `#scoreboard` + model assumptions, footer.
- **Demo controls** (`#presenter`, kept id for the e2e): a sticky bottom bar (not a drawer) when admin; on phones it
  is in-flow above the footer. See §6 for its contract.
- 390px: single column, 16px gutters, tiles ≥ 30px, no horizontal scroll at 320.

## 5. Component looks

- **Panel**: `--paper`, sage-45% border, radius 14px; heading row 56px with an *eyebrow* above the H2 when the
  section is one of the provenance-bearing ones ("SIMULATED", "REAL HARDWARE", "EXAMPLE").
- **Badges** (`Badge tone=…`, all 11.5px eyebrow style, radius 4px, 3px 7px):
  - `neutral` → `--paper-inset` fill, `--ink` text · `simulated` → outline 1px `--sage`, `--ink-muted` text
  - `real` → `--forest` fill, cream text, leading 6px `--nvidia` dot
  - `nemotron` → `--forest` solid pill, cream text "NVIDIA Nemotron", leading `--nvidia` dot
  - `code` → sage outline pill, `--ink-muted` text "code"
  - `unknown` → dashed sage outline, "unattributed"
  - `warning` → `--amber` fill, `--ink` text · `danger`/`blocked` → `--orange` fill, `--ink` text, weight 700
  - `example` / `mock` → `--orange-soft` fill, `--orange-ink` text
- **Buttons**: `default` forest fill / cream text; `secondary` paper fill, 1px forest border, ink text;
  `ghost` ink-muted text; `destructive` orange fill, ink text, 700. Min height 40px (demo controls 56px), radius 8px.
  Hover: `translateY(-1px)` + darker fill at `--t-fast`; active: translateY(0).
- **GPU tile**: 36–44px square-ish, radius 6px, 1px border `color-mix(var(--forest) 25%)`, job outline is a 2px
  bottom border in the job colour; selected = 2px `--ink` outline, offset 2px. Failed tile: `--heat-fail` + cream ✕.
- **Coolant loop**: an SVG polyline threading racks r2–r4 (loop A) and r1,r5–r8 (loop B) drawn in `--sage` with a
  `stroke-dasharray` flow animation; degraded pump → stroke `--orange`, dash speed halves, opacity .7, label
  "pump-a · 60 %". Data-driven from `coolingLoops(snapshot)` / `degradedPumps(snapshot)` only.
- **Agent seat**: 44px circle avatar (initial in display face), name (H3), actor badge under it, state ring:
  idle = `--sage-soft` 1px; thinking = forest 2px + pulse; done = forest 1px + small check. Six seats laid out as a
  2×3 grid (desktop) / horizontal scroll row (phone).
- **Chat bubble**: `--paper` on the forest room? No — the room body is `--paper-inset` with the room *header* in
  forest. Bubbles are `--paper`, radius 12px with a 4px flat corner toward the seat; thread accent (2px left rule) in
  the thread colour (`--job-a` forest for thread 1, `--amber` for thread 2). Handoff line under a bubble: eyebrow
  style "TRIAGE → PLANNER" with a 10px arrow. Tool-call chips: mono 12.5px, `--paper-inset`, radius 4px.
- **System divider** (resume): full-width hairline with centred eyebrow text in `--orange-ink`:
  "Agent process stopped → new process resumed by w-2 (#1), reconciling…".
- **Ledger**: table rows 44px; status pill per row; BLOCKED rows get an orange left rule and the reason inline
  (`--orange-ink`, mono) beneath the command — no accordions for the reason.
- **Scoreboard**: headline totals as hero numbers (wins / ties / losses / losses open), provenance label beside each
  column header. Columns are visually equal; **no colour favouring the deterministic column**.
- **Workflow / handoff card**: result stripe at the top: "Recovered" (forest fill, cream text) or "Needs a human"
  (orange fill, ink text) + the persisted handoff text verbatim.
- **Empty / loading**: paper panel with sage dashed border, display-face title, one sentence.

## 6. Contracts between slices (props; build against these, do not change them without reporting)

```ts
// A renders, D implements: src/components/controls/DemoControls.tsx
export function DemoControls(props: {
  store: DashboardStore; canAdmin: boolean; open: boolean;               // open = ?presenter=1 (A reads the URL)
  selectedGpuId: string; selectedPumpId: PumpId;
  onSelectGpu: (id: string) => void; onSelectPump: (id: PumpId) => void; onReset: () => void;
  plans: PlanRecord[]; actionDetails: ActionDetail[]; workflows: WorkflowRecord[]; snapshot: ObservedSnapshot;
}): JSX.Element;   // root element keeps id="presenter"; buttons ①–④ have accessible names:
                   // 'Break cooling pump A', 'Try unsafe move to hot rack 6', 'Fail a GPU (XID 79)', 'Reset run'; confirm = 'Confirm reset'

// A renders, B implements: src/components/agent-room/AgentRoom.tsx
export function AgentRoom(props: {
  events: AgentEventInput[]; workflows: WorkflowRecord[]; incidents: Incident[];
  nowUnixMs: number; example: boolean; mode: 'mock' | 'live';
}): JSX.Element;   // root <section id="agent-room">

// A renders, C implements (existing props unchanged, two optional additions):
SimulationView({ snapshot, selected, onSelect, onSelectPump, telemetry, actionDetails?, history? })
RealGpu({ evidence, now })        // unchanged
Jobs({ snapshot, losses, history, details })   // unchanged

// A renders, D implements (existing props unchanged):
WorkflowBoard, Ledger, Scoreboard, Feed, Incidents
```

Shared primitives (A owns, everyone uses): `Panel`, `Badge` (tones above), `Empty`, `Button`, plus new `Eyebrow`
and `Stat` in `src/components/ui/panel.tsx`. If you need a primitive that does not exist, build it locally in your
own folder and report it.

## 7. Non-negotiables

- Only `apps/web/**`. No new npm dependencies. Never touch `apps/agent`, `apps/db`, `packages/**`, `hardware/**`.
- Every visual is driven by real store data. Nothing is fabricated; mock stays labelled MOCK; the recovery example
  stays labelled EXAMPLE; `gpu-real-0` is the only REAL thing.
- Attribution comes from the persisted `actor` field only. No `actor` → "unattributed", never Nemotron.
- WCAG AA, visible focus, keyboard operable, `prefers-reduced-motion` respected, no horizontal scroll at 320/390.
- Keep these e2e hooks working: `[data-gpu]`, `button[name^="Rack N"]`, `#jobs`, `#ledger`, `#workflows`,
  `#activity`, `#scoreboard`, `#presenter`, `.incident`, `.wf-card`, `.feed-event`, `.feed-event.actor-nemotron`,
  `[data-testid=sim-clock]`, `select[aria-label="Run view"]`, `select[aria-label="Simulated GPU"]`,
  the 'Pause'/'Resume' button, 'Show all (N)' and the Nemotron/All filter buttons in the feed.
