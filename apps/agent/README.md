# agent (lane P3)

Node.js/TypeScript incident orchestrator: Nemotron (via NIM) triages GPU-cluster symptoms into incidents,
plans per-job recovery scored by `simulatePlan`, and drives durable actions through SpacetimeDB.
Spec: `plans/LANE-P3-agent.md`; shared names: `plans/CONTRACTS.md` §0.

## Layout
- `src/ports.ts`: the seams. `DbPort` (P2 `@dcos/db-client`), `PhysicsPort` (P1 `@dcos/physics`), `LlmPort` (NIM), `Policy`, `PlanMetrics`.
- `src/config.ts`: env loading (zod), `redact()` / `redactString()` for logs.
- `test/fixtures/`: `gpu_demo_8` snapshots + XID 79 signals (regenerate with `pnpm --filter agent fixtures`).
- `test/fakes/`: **TEST-ONLY** `FakeDb`, `FakePhysics`, `FakeLlm`. Never used in production.

## Run
```sh
pnpm --filter agent start      # tsx src/main.ts (placeholder until wired)
pnpm --filter agent test       # vitest
pnpm --filter agent typecheck  # tsc --noEmit
pnpm --filter agent smoke      # NIM tool-call smoke test (P3-0, scripts/smoke-nim.ts)
```

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
| `LLM_TIMEOUT_MS` | 20000 | |
