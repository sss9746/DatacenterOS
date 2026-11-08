# P4 dashboard

React + Vite + TypeScript, Tailwind 4 and shadcn-compatible UI primitives. The default local view runs the real `@dcos/physics` GPU model inside the browser and projects it through the `@dcos/db-client` mock subscription API. Fixture views remain available for UI examples. The current upstream `connect()` is a deliberate rejection stub; live operation is **not yet verified**.

## Run from the repository root

```sh
corepack pnpm install
corepack pnpm --filter @dcos/web dev
```

Open `http://127.0.0.1:5173`. The default **Local physics simulation** runs in this browser only. Use the run-view selector for the older fixtures and scripted recovery example. Copy `apps/web/.env.example` to `apps/web/.env.local` to configure Vite. A repository-root `.env.local` is not loaded by this app.

```sh
corepack pnpm --filter @dcos/web build
corepack pnpm --filter @dcos/web test
corepack pnpm --filter @dcos/web test:e2e
```

Browser tests use installed Google Chrome and capture desktop/mobile views into the ignored `.impeccable/review/` directory. Install Chrome or adjust Playwright's `channel` for your machine.

## Available behavior

- Eight rack cabinets with 64 GPU modules; select a cooling pump, rack, and GPU to inspect dependencies and readings.
- Local simulation uses P1's `buildPreset`, `step`, and `simulatePlan`; it has no second browser physics model. Tune pump capacities and rack 6 inlet offset, inject any of the nine modeled fault kinds into valid targets, pause/resume, use 1–5× speed, or advance 30 simulated seconds. These changes affect the local run only.
- Compare keep, power cap, and checkpoint/move in an estimated copy of the current observed state. Predictions do not include future hidden faults and do not execute a recovery action.
- Separate simulated and wall-session clocks. The fixture run views use the mock client's simpler `tick()` playback.
- Cooling/pump readings, rack thermal headroom, progress versus durable work, checkpoints, observed job-status transitions and work-loss annotations.
- Separate incident records and links; actor-tagged summaries, evidence IDs and expandable tool calls; no raw model reasoning.
- Action lifecycle display, filtering and `SAFETY_REJECTED` → **BLOCKED** explanations. Missing operation metadata is explicitly unavailable.
- Fixture views retain their Pump A/XID 79 controls, inline reset confirmation, and disabled XID 48. The local physics view uses a separate fault selector for all modeled kinds.
- Hardware-only Brev readings with stale/missing states; never allocate `gpu-real-0`.
- Benchmark UI accepts result subscriptions, compares matched run/scenario/seed groups, shows distributions and loss cases, and exports JSON. It starts empty.

“Recovery example” seeds clearly labeled scripted incidents and tool summaries into the mock client. It is not a real model run or an executed safety decision. The local physics view has no connected agent or durable SpacetimeDB actions. No sample benchmark scores are shipped.

## Live mode and deployment

Use `VITE_DATA_MODE=live`, `VITE_STDB_URI`, and `VITE_STDB_DB` after P2 ships its client. The dashboard never silently switches to mock if connection fails. Public viewers are read-only; a `VITE_ADMIN_TOKEN` is accepted only by the local dev server. Production builds reject any configured admin token.

Planned Vercel project settings: framework Vite, root directory `apps/web`, install `corepack pnpm install --frozen-lockfile`, build `corepack pnpm --filter @dcos/web build`, output `dist`. Enable access to workspace files outside the root directory. Do not configure `VITE_ADMIN_TOKEN` on Vercel. A Vercel deployment has **not** been performed.

See [P2 integration handoff](../../docs/p4-handoff.md), [P4 status](../../plans/status/P4.md), [PRODUCT.md](PRODUCT.md), and [DESIGN.md](DESIGN.md).

Implementation references: [Vite](https://vite.dev/guide/), [Tailwind Vite integration](https://tailwindcss.com/docs/installation/using-vite), [shadcn Vite setup](https://ui.shadcn.com/docs/installation/vite), [Playwright configuration](https://playwright.dev/docs/test-configuration).
