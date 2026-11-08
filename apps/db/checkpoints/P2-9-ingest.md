# P2-9: `ingest_observations` (optional, Gate 5)
**Due:** 8:00 AM · **Status:** ◐ (proven on `dcos-dev`; prod at K7) · **Owns:** `apps/db/src/ingest.ts` (+ tests)
**Optional.** Cut first if behind (PLAN.md cut order #2). Stop starting new work at 9:00 AM.

## Goal
Real signals from hardware appear in the twin: the Pico fan (via gateway) and the real Brev GPU `gpu-real-0` (F-NV2).

## Reducer `ingest_observations(batch_json)` (gateway role)
- Validate each item as `TelemetryEvent` or `SignalEvent`; batch is atomic.
- Reject: missing authorization, source mismatch, bad unit/metric, **duplicate `event_id`**, **non-monotonic `source_seq`** per source.
- `nvidia_smi.*` metrics on `gpu-real-0` → update its `gpu_current` row (`source_kind: "hardware"`).
- `fan.sound_rms` / `fan.anomaly_score` → `fan-sensor-r3` telemetry.
- Opt-in demo rule: `configure_run` `fan_drives_loop_a=true` → a **sustained** fan anomaly becomes a visible, labeled `cooling_pump_degradation` fault on pump-a.
- `gpu-real-0` is never allocatable (`REAL_GPU_NOT_ALLOCATABLE`).

## Done when
- [x] Gateway samples show up in `telemetry_recent` / `gpu_current` (`dcos-r-local` and `dcos-dev`; prod `dcos` still owed at K7)
- [x] Duplicate `event_id` and old `source_seq` rejected
- [ ] Fan rule off by default; when on, the fault is labeled as demo-driven (**dropped**: the Pico/fan path is out of scope per `plans/team/REAL-GPU.md`)

## Architect notes (Codex)
One read-only pass; no critical or high findings. One medium, not changed: duplicate `event_id` checks only see rows still in `telemetry_recent`, so an evicted ID resent with a new, higher `source_seq` is accepted. A real retransmit keeps its old `source_seq` and is rejected by `source_cursor`. A permanent ID table would grow without limit for a case the collector can't produce.

## Implementation report (Claude)
**Status: ◐ (2026-11-08 05:14 CST). G3 is on `int/r-sprint` and live on `dcos-dev` (module `c1ac94d`), and the real collector end-to-end (G5) passed there. Prod `dcos` is still owed at K7.**

- `apps/db/src/ingest.ts`: gateway-only reducer, max 20 events, atomic batches, run-clock stamping, telemetry cap.
- New private `source_cursor` table; additive, and it applied as a normal update on `dcos-r-local`.
- `projection.ts`: the per-tick prune now leaves `gpu-real-0` alone. Without this the row was deleted every tick.
- `triage.ts`: skips `gpu-real-0`, so real load or a stopped collector can't open a false incident.
- `reset.ts`: `controlledReset` ignores the real GPU when counting, in case a collector is running.
- A first batch missing a metric stores 0 for that column until it arrives. The dashboard tile reads telemetry, not those columns.

**Verified:** `pnpm -r test` 791 pass; typecheck clean; on `dcos-r-local`, `ingest-smoke.ts`, `smoke:ledger` and Gate 2 pass.

**Verified on `dcos-dev`:** Gate 2 and `ingest-smoke.ts` pass on `c1ac94d`. A real NVIDIA L40S streamed for about 2 minutes (04:58–05:00 CST) with zero rejected batches: `gpu_current[gpu-real-0]` went from 24°C / 35 W to 55°C / 325 W under load and back to 35°C / 37 W, while the simulated run kept ticking. A browser on dev showed the tile go from "collector offline" to "Live" with real idle readings.

**Observed behavior:** a stopped collector shows "collector offline", not "stale". The likely cause is simulator telemetry pushing the real rows out of the 2,000-row `telemetry_recent` table before the tile's 15-second stale check.

**Still owed:** publish to prod `dcos` at K7, grant the gateway role there, and run the collector with the prod gateway token during the demo.
