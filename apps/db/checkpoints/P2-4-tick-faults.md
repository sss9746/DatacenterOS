# P2-4: `advance_tick` + `inject_fault`
**Due:** 11:30 PM · **Gate:** 1 · **Status:** ☐
**Owns:** `apps/db/src/tick.ts`, `apps/db/src/faults.ts`, `apps/db/src/projection.ts`

## Goal
The world runs on its own: a scheduled tick advances physics, faults take effect, and the browser sees it live.

## Design (already decided)
- `tick_schedule` with `ScheduleAt.interval(1_000_000n)` (1 s wall) → `advance_tick`. Runs `speed` logical steps of 1000 ms. Skips when paused. Missed intervals are **not** replayed.
- **Order inside one tick:** faults due → physics `step()` → due action completions (revalidated; P2-5 plugs in here) → epoch bump → commit.
- Load `world_state` → `step()` → write `world_after` → `projectWorld` → append telemetry/signals.
- `telemetry_recent`: ≤1 Hz per GPU; delete oldest past **2,000** rows.
- `inject_fault(fault_json)`: admin; `validatePayload('FaultInjection', …)`; check target exists and fits the fault kind; store in private `fault_injection_truth` **and** in world_state's due faults.
- Only bump `decision_epoch` on `material_change` from physics, not every tick.

## Done when (Gate 1)
- [ ] Ticks advance `run.sim_time_ms` without any client connected
- [ ] pump-a degradation at 10,000 ms → r2–r4 `temp_c` rises in `gpu_current`; GPUs > 85 °C throttle; r5–r8 stay cool
- [ ] XID 79 on `gpu-r3-n1-0` → `signal_event` row + job-a `failed`/`restarting`, progress back to `durable_work_units`
- [ ] `telemetry_recent` stays ≤ 2,000 rows
- [ ] `pause_run` stops time; `configure_run` speed 5 → 5 s per wall second
- [ ] Reducer time stays under the limit from the booth answer at speed 5×
- [ ] Dashboard (P4) sees it live

## Blocked by
P1's GPU `step()` (P1-4, due 11:00 PM).

## Architect notes (Codex)

## Implementation report (Claude)
