# Real NVIDIA GPU on Brev (F-NV2 / O1): build plan for Suvan

**Goal:** one real Brev GPU streams `nvidia-smi` readings into the twin as **`gpu-real-0`**. Judges watch a real NVIDIA GPU heat up under load next to the 64 simulated ones, reported in the same telemetry format.

**Scope (IMPLEMENTATION-SCOPE §2 / TASKS "Optional work"):**
- Observation only. It is never allocated, capped or acted on.
- It must never slow down R1–R7. It's the first thing cut.
- The Pico/fan path is **dropped** unless Suvan says otherwise.

**Branch:** `r/o1-real-gpu`, cut from `main`, merged into `int/r-sprint`.

## Status (2026-11-08 05:14 CST; Kaushik now owns this track)

| # | State | Evidence |
|---|---|---|
| G0 | Done | `dcos-gpu`, NVIDIA L40S, driver 580.173.02. Keep it running through judging |
| G1 | Done | Dry-run gives valid events every second; 14 collector tests pass |
| G2 | Done | 60 s load reaches about 55°C and 325 W. The box has no system `pip`, so use `~/dcos-venv/bin/python ~/load.py` |
| G3 | Done on dev | `ingest_observations` is in module `c1ac94d` on `dcos-dev`; prod at K7 |
| G4 | Done on dev | Dev gateway token in `.env.local`; prod gateway role and token at K7 |
| G5 | Passed on dev | About 2 minutes live with zero rejected batches; the tile went live in a browser on dev. Recording is `hardware/recordings/brev-l40s.jsonl` |

**Differences from the plan below:** omit the `--` after `start` in `pnpm` commands. A stopped collector shows "collector offline", not "stale". The recording is named `brev-l40s.jsonl`, and the tile labels a replay `REPLAY OF REAL RECORDING`.

## Already in place (don't rebuild)

| Piece | Where |
|---|---|
| The `gpu-real-0` / `node-real-0` resources; physics never simulates them; safety rejects them with `REAL_GPU_NOT_ALLOCATABLE` | `packages/physics/src/gpu/{preset,telemetry,safety,actions}.ts` |
| The `ingestObservations(batch)` API; the mock rejects duplicate `event_id` and non-increasing `source_seq` (tested) | `packages/db-client/src/{client,mock}.ts` |
| **The web tile, already wired:** `apps/web/src/components/heatmap/RealGpu.tsx` reads `evidence.telemetry` rows with `resource_id:'gpu-real-0'`, `source_kind:'hardware'`, `labels.collector:'nvidia-smi'`, and shows "stale" after 15 s | `apps/web` |
| The live client's `ingestObservations` **throws "lands in P2-9"**, and **no DB reducer exists** | `packages/db-client/src/live.ts:576`. **This is the real gap.** |

## Wire format (must match the tile exactly)

One `TelemetryEvent` per metric per second (`packages/contracts`, schema 1.1.0):

```json
{ "schema_version":"1.1.0", "event_id":"hw.<unix_ms>.gpu-real-0.nvidia_smi.temperature_gpu",
  "run_id":"run-demo-1", "resource_id":"gpu-real-0",
  "source_kind":"hardware", "source_id":"nvsmi-brev-1", "source_seq":<strictly increasing int>,
  "observed_unix_ms":<Date.now()>, "sim_time_ms":0, "metric":"nvidia_smi.temperature_gpu",
  "value":61, "unit":"C", "quality":"good", "labels":{"collector":"nvidia-smi","gpu_name":"NVIDIA L4","host":"brev"} }
```

| nvidia-smi field | `metric` | `unit` | Notes |
|---|---|---|---|
| `temperature.gpu` | `nvidia_smi.temperature_gpu` | `C` | |
| `power.draw` | `nvidia_smi.power_draw` | `W` | `[N/A]` → skip the row, never send 0 |
| `utilization.gpu` | `nvidia_smi.utilization_gpu` | `ratio` | **Send as a 0–1 fraction**; the tile multiplies by 100 |
| `clocks.sm` | `nvidia_smi.clocks_sm` | `MHz` | |
| `power.limit` | `nvidia_smi.power_limit` | `W` | extra; the tile ignores it |
| `clocks_event_reasons.active` (newer drivers) or `clocks_throttle_reasons.active` (older) | `nvidia_smi.clocks_event_reasons` | `bitmask` | hex → int; 0x20 is the same SW thermal bit the sim uses |

`sim_time_ms`: the collector can't know the sim clock, so the **reducer stamps the current run clock** and ignores the sent value.

## Tasks

| # | Task | Owns | Done when |
|---|---|---|---|
| **G0** | **Brev box:** rent the cheapest GPU (L4/T4/A10 is plenty). `brev login`, `brev refresh` (adds the SSH host), then `ssh <host> nvidia-smi` prints a table. Stop the instance when you're not rehearsing. | — | `ssh <host> nvidia-smi --query-gpu=temperature.gpu,power.draw,utilization.gpu,clocks.sm --format=csv,noheader,nounits -l 1` streams lines |
| **G1** | **Collector** `hardware/nvidia-smi-collector/` (Node TS, tsx; **no new deps**: `child_process.spawn('ssh', …)`). It parses the CSV, maps rows using the table above, checks each event with `validatePayload`, and batches the 5–6 events per second into `ingestObservations` using the **gateway** token. Handles `[N/A]`; detects the throttle-reason field name once at startup (run `nvidia-smi --help-query-gpu`). Reconnects with backoff when SSH drops; `source_seq` keeps increasing across reconnects (seed it from `Date.now()`). Flags: `--host`, `--db dcos-dev|dcos`, `--dry-run` (print JSON, no DB), `--record <file.jsonl>`, `--replay <file.jsonl>` (resends with `source_kind:"replay"`, new seq and timestamps). Env from `.env.local`: `STDB_URI`, `STDB_DB`, `STDB_GATEWAY_TOKEN`. **Never log the token.** | `hardware/nvidia-smi-collector/**`, add `"hardware/*"` to `pnpm-workspace.yaml` (ask the orchestrator) | `--dry-run` prints valid events every 1 s from the real box; a unit test of the CSV→event mapping, including `[N/A]` and both throttle field names |
| **G2** | **Load script** `hardware/brev/load.py`: torch matmul loop on `cuda`, `--seconds 60`, default 60 and **hard max 120**. Falls back to a message if torch is missing (`pip install torch` on the box). | `hardware/brev/**` | Temperature and power visibly rise in `--dry-run` output while it runs, then fall after |
| **G3** | **DB reducer** `ingest_observations`, **Kaushik's code; he reviews and publishes.** Gateway role only. Validate each event; reject the whole batch on a duplicate `event_id` or non-increasing `source_seq` per `source_id` (same rule as the mock). Accept only `resource_id === 'gpu-real-0'` + `source_kind ∈ {hardware, replay}` for now. Stamp `sim_time_ms` = current run clock; insert into `telemetry_recent`; upsert `gpu_current[gpu-real-0]` (temp, power, clock, limit, reasons, `last_seen_sim_ms`, `availability:'ready'`, version+1). Then wire `live.ts ingestObservations` to call it. Rate limit: max 20 events per call. | `apps/db/src/ingest.ts`, `apps/db/src/index.ts` registration, `packages/db-client/src/live.ts` | A test or script: one batch is accepted, the same batch is rejected, the agent/admin role is refused; `spacetime sql dcos-dev "select * from gpu_current where resource_id='gpu-real-0'"` shows the row |
| **G4** | **Gateway token:** Kaushik mints a gateway identity for `dcos-dev` (later prod), the same way he did the agent one, and `grant_role ... '"gateway"'`. The token goes **only** into your `.env.local` as `STDB_GATEWAY_TOKEN`. | — | The collector connects without an auth error |
| **G5** | **End-to-end on `dcos-dev`:** the collector runs live → the tile goes from "No data" to live numbers → run `load.py` → the tile's temperature and power rise → stop the collector → after 15 s the tile shows "stale". Record a 2-minute `--record hardware/recordings/brev-l4.jsonl` as the backup. | `hardware/recordings/**` | Screenshot or recording of the tile changing under load; the replay file plays back labeled REPLAY |

**Order:** G0 → G1 + G2 (no DB needed, use `--dry-run`) → G3 + G4 (Kaushik, about 30–45 min) → G5.

## What the agent and dashboard must NOT do with it

- No job placement, power cap or verification on `gpu-real-0` (safety already rejects it).
- Not counted in the 8×8 heat map, cluster totals or eval metrics.
- `telemetry_recent` holds about 2,000 rows (~7.5 s of sim telemetry), so real rows age out quickly. That's fine at 1 Hz with the tile's 15 s stale rule. Don't raise the cap.
- Replay must say **REPLAY OF REAL RECORDING**, never live.

## Pitch line (only after G5 has passed)

> "Every simulated GPU reports in the same format as a real NVIDIA GPU. Here's a real one on Brev, live. When I load it, you watch it heat up."

## If short on time

- No G3 by 8:00 → show the `--dry-run` terminal next to the dashboard (still real) and say the ingest path is in progress.
- No Brev box → cut it entirely. **Never fake readings.**
