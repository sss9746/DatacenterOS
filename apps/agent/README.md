# agent (lane P3)

Node.js/TypeScript incident orchestrator: Nemotron (via NIM) triages GPU-cluster symptoms into incidents,
plans per-job recovery scored by `simulatePlan`, and drives durable actions through SpacetimeDB.
Spec: `plans/LANE-P3-agent.md`; shared names: `plans/CONTRACTS.md` §0.

## Layout
- `src/ports.ts`: the seams. `DbPort` (P2 `@dcos/db-client`), `PhysicsPort` (P1 `@dcos/physics`), `LlmPort` (NIM), `Policy`, `PlanMetrics`.
- `src/config.ts`: env loading (zod), `redact()` / `redactString()` for logs.
- `src/agent-loop.ts`: the main loop. `createAgentLoop(deps)` -> `{ start, stop, runOnce, lastResume }`.
  One tick = triage -> diagnose -> plan -> execute (replan watcher; max 3 replans, then escalate) -> verify + handoff.
  `start()` runs `resumeOpenWorkflows` first, then ticks on `db.onChange` (debounced 1 s) and a 2 s poll; ticks never overlap and never throw.
  One workflow per triage batch (`wf-<first incident id>`); incidents go `open -> investigating -> monitoring | escalated` (never `resolved`).
- `src/adapters/`: `createDbPort` (P2 `@dcos/db-client`) and `createPhysicsPort` (P1 `@dcos/physics`), both dynamic imports that throw `AdapterNotReadyError` until the packages ship.
- `src/main.ts`: live entry point (SpacetimeDB + real physics + NIM).
- `test/fixtures/`: `gpu_demo_8` snapshots + XID 79 signals (regenerate with `pnpm --filter agent fixtures`).
- `test/fakes/`: **TEST-ONLY** `FakeDb`, `FakePhysics`, `FakeLlm`. Never used in production.

## Run
```sh
pnpm --filter agent demo       # ARCHITECTURE §11 demo end to end on in-memory fakes (scripts/demo-local.ts)
pnpm --filter agent start      # live agent (tsx src/main.ts); exits 3 until @dcos/db-client + @dcos/physics GPU functions ship
pnpm --filter agent test       # vitest
pnpm --filter agent typecheck  # tsc --noEmit
pnpm --filter agent smoke      # NIM tool-call smoke test (P3-0, scripts/smoke-nim.ts)
pnpm --filter agent exec tsx scripts/crash-test.ts   # crash/resume at kill points a-e
```

`demo` uses the real Nemotron when `NIM_API_KEY` + `NIM_MODEL` are set (capped at 12 calls), else runs deterministically.
It prints the F-NV1 feed (stage chip, `[NEMOTRON]`/`[CODE]` actor badge, tool calls) and a summary table, and exits 0 only if
every check passes (2 incidents, replan, job-a safe, no duplicates, crash resumed by command key, workflow closed).

`start` exit codes: 0 clean stop (SIGINT/SIGTERM), 1 config error, 3 a lane's package is not shipped yet.
When P1/P2 ship, add `"@dcos/physics": "workspace:*"` and `"@dcos/db-client": "workspace:*"` to `dependencies`.
No LLM key -> deterministic mode with a warning.

## Env (CONTRACTS §0.10)
Read from `process.env`, then repo-root `.env.local` for anything unset.

| Var | Default | Notes |
|---|---|---|
| `STDB_URI`, `STDB_DB` | — | SpacetimeDB connection |
| `STDB_AGENT_TOKEN` | — | secret, `agent` role (from P2, never committed) |
| `NIM_BASE_URL`, `NIM_MODEL` | — | primary NIM (Brev) |
| `NIM_API_KEY` | — | secret |
| `NIM_FALLBACK_BASE_URL` | `https://integrate.api.nvidia.com/v1` | hosted fallback |
| `NIM_FALLBACK_MODEL` | — | |
| `LLM_MAX_TOKENS` | 768 | |
| `LLM_MAX_TOOL_STEPS` | 8 | |
| `LLM_TIMEOUT_MS` | 10000 | |
| `LLM_RETRIES` | 1 | per-endpoint retries, int 0-5 |
| `NIM_ENABLE_THINKING` | false | `true` / `false` / `omit` (omit = don't send `enable_thinking`) |
