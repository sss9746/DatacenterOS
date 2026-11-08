# DataCenterOS frontend plan

## Product direction

Build an operator console for the NMC² mission, **Keep the World Running**. An engineer should be able to describe a GPU facility, introduce a modeled problem, watch the system investigate it, inspect predicted responses, and see what actually happened. A judge should be able to complete the same story in about three minutes using a reliable preset.

The core journey is:

```text
Choose or configure a facility
  → inject a supported fault
  → watch evidence and agent roles
  → compare plans in an estimated copy
  → see the safety decision and durable action
  → verify recovery and compare outcomes
```

The frontend is a view and control surface. `@dcos/physics` owns simulation behavior; SpacetimeDB owns the live run, command ledger, workflow, and leases; the agent owns diagnosis and planning. Browser code must not maintain a second authoritative simulator.

## Audience and primary questions

| User | What the interface must answer quickly |
| --- | --- |
| Facility engineer | What is failing, what depends on it, which jobs are at risk, and what action is safe? |
| Shift operator | What has been done, what is still running, and what needs a handoff? |
| Hackathon judge | Can I trigger a problem and clearly see the agent investigate, test, act, and recover from interruption? |

Use plain labels. Prefer “GPU unavailable” to an unexplained XID, and show the code in the detail view. Keep simulated time, wall time, observed evidence, estimates, and verified outcomes visually distinct.

## Facility model shown in the UI

The configuration surface should expose **modeled dependencies**, not just a count of GPUs. NVIDIA documents GPUs, interconnects, network adapters, storage, and power supplies inside DGX systems, and separates compute, storage, and management networks in its larger reference architecture. The MVP can show the categories below without claiming to emulate every device internally. Sources: [DGX H100/H200 components](https://docs.nvidia.com/dgx/dgxh100-user-guide/introduction-to-dgxh100.html), [DGX SuperPOD architecture](https://docs.nvidia.com/dgx-superpod/reference-architecture-scalable-infrastructure-b200/latest/dgx-superpod-architecture.html).

| Category | What an engineer configures | MVP UI representation | Current model boundary |
| --- | --- | --- | --- |
| Compute | Racks, nodes, GPU slots, profiles, spare capacity | Rack cabinets and GPU modules | `gpu_demo_8` has 8 racks, 1 node/rack, 8 GPUs/node |
| Cooling | Pumps, loops, rack assignments, capacity | Pump-to-rack routes | Pump A and B, loop A and B are modeled |
| Power | Shared domains, rack power budget | Power-domain badge and detail | A power domain exists; detailed electrical simulation is limited |
| Networking | Node links and connectivity | Dependency line and link detail | Link faults are modeled; not packet-level fabric simulation |
| Storage | Checkpoint stores, access, write duration | Store node linked to jobs | Checkpoint accessibility and duration are modeled |
| Workloads | GPU requirement, placement, checkpoint policy, priority | Job lanes over allocated GPUs | Three demo jobs; specs are modeled |

Every connection should answer “what stops working if this component fails?” A rack selection should reveal its cooling loop, pump, power domain, node, GPUs, jobs, and checkpoint dependencies. Do not draw an elaborate network graph until the underlying relationships are available from the contracts.

## Information architecture

Use one focused workspace with five destinations. Keep the facility map visible as the anchor during a live run.

1. **Facility** — choose a preset or configure a supported topology; inspect dependencies and capacity.
2. **Run** — inject a fault, view the physical map and timeline, inspect jobs and evidence.
3. **Response** — follow triage, diagnosis, plan comparison, safety, execution, and verification.
4. **Results** — compare measured outcomes with reactive and threshold policies on matched seeds.
5. **Handoff** — concise current state, completed actions, open incidents, and next operator task.

For the hackathon, these can be sections or tabs within the existing React app. Do not create separate pages that force the presenter to lose the live run context.

## How the UI should look

**Visual idea:** a credible facility operations display. The memorable element is a physical rack-and-dependency map: steel cabinets with eight visible modules each, cooling paths that visibly feed their racks, and restrained status lights. Keep controls, agent evidence, and metrics quieter than the map. The current dark console palette is suitable; retain mint for agent action, amber for risk, red for failure, and cool blue for healthy infrastructure. Text labels and icons must accompany color.

### Desktop composition

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ DataCenterOS   Facility: Demo 8        SIMULATED   Clock   Pause  Speed │
├───────────────┬─────────────────────────────────────────────────────────┤
│ Facility      │ Current situation: Pump A degraded; jobs A/B at risk   │
│ Run           ├────────────────────────────────────┬────────────────────┤
│ Response      │ Pump A ── R2 R3 R4                 │ Fault controls     │
│ Results       │ Pump B ── R1 R5 R6 R7 R8           │ Type / target /    │
│ Handoff       │                                    │ timing / severity  │
│               │  [R1][R2][R3][R4][R5][R6][R7][R8]│ Inject fault       │
│               │  Select rack → inspect 8 GPUs      │                    │
│               ├────────────────────────────────────┴────────────────────┤
│               │ Job progress vs. last durable checkpoint               │
│               ├───────────────────────────────┬─────────────────────────┤
│               │ Incident & agent timeline     │ Plan options & safety   │
│               ├───────────────────────────────┴─────────────────────────┤
│               │ Durable action ledger and verified outcome             │
└───────────────┴─────────────────────────────────────────────────────────┘
```

At mobile widths, stack in this order: current situation, fault controls, rack map, selected rack/GPU detail, jobs, response, action ledger. A selected rack remains in view; users should never need to scan 64 individual controls at once. Keep a visible “Back to racks” action inside the detail view.

### Visual language

- **Canvas:** deep navy `#10151c`; **equipment:** steel slate `#263741`; **healthy:** cool blue `#83b8c8`; **agent:** mint `#8bd6b1`; **warning:** amber `#e2b071`; **failure:** soft red `#df8a8d`.
- Use one clear sans family for headings and body, tabular numerals for readings, and monospace only for command keys or IDs. Avoid decorative all-caps labels.
- Cabinets should look physical through rails, vents, card slots, and small LEDs. The data layer controls their status; decoration must not invent device readings or imply the real Brev GPU is part of the simulated 64.
- Motion should mark a meaningful transition: a new fault, plan superseded, command status advanced, or recovery verified. Respect reduced-motion settings. Do not pulse every hot GPU continuously.
- The default view should explain itself in one scan: **what happened → what is affected → what the system is doing now**.

## Core interactions and states

### 1. Configure facility

Start with **Use demo facility** as the primary path. A separate **Configure facility** flow can offer constrained controls: rack count, GPUs per node, cooling assignment/capacity, available spare GPUs, job placements, and checkpoint age. Show a dependency preview and validation before **Create run**.

Configuration must be backed by a validated preset or new contract and physics support. The current `buildPreset('gpu_demo_8')` accepts only one preset, so this flow should be visibly marked **planned** until P1/P2 provide a create-run interface for custom topology. Never let the browser edit a snapshot and present it as a real run.

### 2. Inject a fault

Place fault controls beside the facility map. The user selects a supported fault, valid target, optional timing/duration and severity, then sees a confirmation of what will be injected. A compact “Demo sequence” can offer **Degrade Pump A**, followed later by **Fail destination GPU (XID 79)**. The fault menu should list only types the active backend can execute. Unsupported types show an explanation rather than a clickable control that silently changes a fixture.

Mock mode must say **Preview using sample data** beside the controls. Live mode must show authorized reducer status and the resulting signal/event ID. The private injected-fault truth must not leak into the agent evidence feed.

### 3. Investigate

The map highlights shared impact: Pump A → loop A → racks 2–4 → affected GPUs → jobs A/B. Clicking any component opens a detail panel with current readings, upstream providers, downstream consumers, and recent observed signals. An incident rail groups correlated warnings under one cooling incident while keeping an independent XID incident separate.

The agent timeline should show role/stage, timestamp, summary, evidence IDs, and tool-call summaries. Suggested stages: detect, correlate, diagnose, compare, safety-check, execute, verify, handoff. These can be roles inside one orchestrator process; the UI must not imply independent agents unless the implementation actually provides them. Never display raw chain-of-thought.

### 4. Compare plans in a copy

Show candidate cards for **Keep running**, **Cap power**, and **Checkpoint and move** with projected work loss, delay, GPU busy waste, risk, and assumptions. Label this area **Estimated copy of the observed cluster**. Do not show future hidden faults in plan predictions. A side-by-side view should indicate when a proposed destination is rejected, with the plain-language safety reason and code. Show prediction and actual outcome in separate columns after execution.

### 5. Execute and recover

The action rail should expose `requested → claimed → running → succeeded/failed/needs reconciliation`, checkpoint write progress, and the `command_key`. Explain durability in four separate records: training checkpoints save work; workflow state saves the recovery stage; the action ledger saves command status; fencing tokens reject stale workers. On an agent restart, show **Reconnected to existing action** rather than a second action animation. Verification should explicitly state what changed in the live world.

### 6. Results and handoff

Results compare Nemotron, reactive rule-based, and threshold policies on identical seeded scenarios. Show lost work, completion delay, wasted GPU time, blocked unsafe actions, unnecessary moves, unfinished jobs, and cases where Nemotron loses. Empty results remain empty; never fabricate scores. Handoff summarizes current incidents, affected jobs, actions still running, blocked actions, and the next operator step.

## Demo script represented in the interface

1. Open `gpu_demo_8`; point to 8 racks, 64 GPUs, 3 jobs, and checkpoint age.
2. Trigger Pump A degradation. Show one cooling incident and rising heat in racks 2–4.
3. Show job-specific plan comparison; Job A checkpoints/moves, Job B stays or caps. Show rack 6 blocked for inadequate thermal headroom.
4. Inject XID 79 during recovery. Show a separate incident, superseded plan, and replan.
5. Restart the agent. Show the same command key continuing through the ledger without duplicate work.
6. Open Results and Handoff. Show matched-seed baseline numbers, unresolved items, and the verified outcome.

This is the target end-to-end story from `PLAN.md`; it is not a claim that every integration exists today.

## Current code and gaps

| Capability | Current state | Frontend work |
| --- | --- | --- |
| Physical rack/GPU view | `SimulationView.tsx` shows 8 cabinets and 64 status modules; selected rack exposes 8 GPU cards | Add dependency selection and job overlays; keep the rack-first interaction |
| Local faults | Browser-local adapter runs P1 `step()` for all nine modeled kinds; fixture views still respond only to Pump A degradation and XID 79 | Connect live authorized reducers when P2 is ready |
| Facility configuration | Fixed `gpu_demo_8` topology; local view can tune both pump capacities and rack 6 inlet offset | Add validated topology creation with P1/P2 before changing rack/GPU/job counts |
| Live DB/agent | Web README says live `connect()` is not verified | Integrate typed subscriptions, command actions, and agent events |
| Plan comparison | Local view uses P1 `simulatePlan()` on an observed copy for keep/cap/checkpoint-move | Add P3/P2 candidate stream for real agent decisions; distinguish it from this manual local comparison |
| Durable action story | Ledger UI exists; current mock has no real recovery execution | Show lifecycle, command key, fencing/reconciliation events when live rows exist |
| Results | Scoreboard exists but starts empty | Populate only from real matched evaluation runs |

## Build order and acceptance

1. **Make the current preset understandable.** Add component selection, dependency highlighting, affected-job links, and a short current-situation summary. Check desktop, mobile, keyboard, and screen-reader labels.
2. **Make fault entry contextual.** Selecting a GPU or pump preselects it in the fault controls. Restrict choices to valid targets and show pending/success/error states. Mock and live provenance remain explicit.
3. **Build the response workspace.** Incident separation, agent stages, candidate plan comparison, safety verdict, and action lifecycle use typed server data. Missing stages say “Waiting for agent” rather than using scripted content in live mode.
4. **Design the configuration form.** Validate topology and job constraints against a backend-defined capability schema. Keep Create run disabled until the corresponding physics and DB contracts are implemented and tested.
5. **Complete proof and handoff.** Render verified outcomes, matched baseline results, and an operator summary; run the three-minute scenario twice without hidden manual setup.

Acceptance for the frontend: a first-time judge can identify the failing component, affected racks/jobs, current agent stage, predicted choices, blocked action, running durable command, and verified outcome without the presenter narrating every panel. No UI state may imply a custom cluster, live agent action, or measured score when the backing data is only a fixture.

## Cross-lane requests before promising full customization

- **P1 / contracts:** Define validated configurable topology input and allowed ranges; preserve deterministic stepping, safety, and scenario reproducibility for new layouts.
- **P2:** Provide `create_run` or equivalent with a validated configuration, public topology subscriptions, authorized fault capabilities, action/workflow status, and reconciliation events.
- **P3:** Publish agent stage summaries, evidence IDs, candidate plans and estimates, safety results, supersession, verification, and handoff through public projections.
- **P4:** Keep all frontend data access in `@dcos/db-client`; update browser checks for the full demo and document mock versus live behavior.

Until those interfaces exist, the dependable judge path remains the fixed `gpu_demo_8` preset with clearly labeled mock or live status.
