# P4 dashboard

React + Vite + TypeScript, Tailwind 4 and shadcn-compatible UI primitives. Uses the actual `@dcos/db-client` API and its fixture-backed `createMockClient()`. The current upstream `connect()` is a deliberate rejection stub; live operation is **not yet verified**.

## Run from the repository root

```sh
corepack pnpm install
corepack pnpm --filter @dcos/web dev
```

Open `http://127.0.0.1:5173`. Default mode is `mock`. Copy `apps/web/.env.example` to `apps/web/.env.local` to configure Vite. A repository-root `.env.local` is not loaded by this app.

```sh
corepack pnpm --filter @dcos/web build
corepack pnpm --filter @dcos/web test
corepack pnpm --filter @dcos/web test:e2e
```

Browser tests use installed Google Chrome and capture desktop/mobile views into the ignored `.impeccable/review/` directory. Install Chrome or adjust Playwright's `channel` for your machine.

## Available behavior

- 64 stable GPU IDs in an eight-by-eight matrix; temperature states, XID/unavailability, thermal throttling, job colors, keyboard neighbor selection and inspection.
- Separate simulated and wall-session clocks; pause/resume and 1–5× mock playback through the client's `tick()` test control. No frontend physics model.
- Cooling/pump readings, rack thermal headroom, progress versus durable work, checkpoints, observed job-status transitions and work-loss annotations.
- Separate incident records and links; actor-tagged summaries, evidence IDs and expandable tool calls; no raw model reasoning.
- Action lifecycle display, filtering and `SAFETY_REJECTED` → **BLOCKED** explanations. Missing operation metadata is explicitly unavailable.
- Mock pump/XID 79 controls, inline reset confirmation, and disabled mock XID 48 (not implemented upstream).
- Hardware-only Brev readings with stale/missing states; never allocate `gpu-real-0`.
- Benchmark UI accepts result subscriptions, compares matched run/scenario/seed groups, shows distributions and loss cases, and exports JSON. It starts empty.

“Recovery example” seeds clearly labeled scripted incidents and tool summaries into the mock client. It is not a real model run or an executed safety decision. No sample benchmark scores are shipped.

## Live mode and deployment

Use `VITE_DATA_MODE=live`, `VITE_STDB_URI`, and `VITE_STDB_DB` after P2 ships its client. The dashboard never silently switches to mock if connection fails. Public viewers are read-only; a `VITE_ADMIN_TOKEN` is accepted only by the local dev server. Production builds reject any configured admin token.

Planned Vercel project settings: framework Vite, root directory `apps/web`, install `corepack pnpm install --frozen-lockfile`, build `corepack pnpm --filter @dcos/web build`, output `dist`. Enable access to workspace files outside the root directory. Do not configure `VITE_ADMIN_TOKEN` on Vercel. A Vercel deployment has **not** been performed.

See [P2 integration handoff](../../docs/p4-handoff.md), [P4 status](../../plans/status/P4.md), [PRODUCT.md](PRODUCT.md), and [DESIGN.md](DESIGN.md).

Implementation references: [Vite](https://vite.dev/guide/), [Tailwind Vite integration](https://tailwindcss.com/docs/installation/using-vite), [shadcn Vite setup](https://ui.shadcn.com/docs/installation/vite), [Playwright configuration](https://playwright.dev/docs/test-configuration).
