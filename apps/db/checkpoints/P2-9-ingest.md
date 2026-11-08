# P2-9: `ingest_observations` (optional, Gate 5)
**Due:** 8:00 AM · **Status:** ☐ · **Owns:** `apps/db/src/ingest.ts` (+ tests)
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
- [ ] Gateway samples show up in `telemetry_recent` / `gpu_current`
- [ ] Duplicate `event_id` and old `source_seq` rejected
- [ ] Fan rule off by default; when on, the fault is labeled as demo-driven

## Architect notes (Codex)

## Implementation report (Claude)
