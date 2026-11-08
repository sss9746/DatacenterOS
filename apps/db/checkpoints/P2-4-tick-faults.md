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
- [x] Ticks advance `run.sim_time_ms` without any client connected
- [x] pump-a degradation at 10,000 ms → r2–r4 `temp_c` rises in `gpu_current`; GPUs > 85 °C throttle; r5–r8 stay cool (real P1 physics)
- [x] XID 79 on `gpu-r3-n1-0` → `signal_event` row + job-a `failed`/`restarting`, progress back to `durable_work_units` (real P1 physics)
- [x] `telemetry_recent` stays ≤ 2,000 rows
- [x] `pause_run` stops time; `configure_run` speed 5 → 5 s per wall second
- [ ] Reducer time stays under the limit from the booth answer at speed 5× (no booth answer yet; at 5× with real physics the tick keeps pace and the logs show no errors; locally 50 steps incl. JSON round-trips = 75 ms)
- [ ] Dashboard (P4) sees it live (needs P4)

## Blocked by
P1's GPU `step()` (P1-4, due 11:00 PM).

## Architect notes (Codex)
Review of the uncommitted P2-4 diff (codex exec, read-only). All four **fixed** and verified live on `dcos-dev`:
- [P1] Fault activation/expiry set `material_change` with no observable effect → the public `decision_epoch` leaked private injection timing. Now only observable changes count. Live: a pump-a fault leaves the epoch at 0. **P1's real `step` must follow the same rule.**
- [P2] XID 48/74 could downgrade an `unreachable` (XID 79) GPU to `degraded`, so the outcome depended on fault-id order. Now it never downgrades. Live: 48 + 79 in one tick → `unreachable` / 79.
- [P2] Every event in a tick reused `source_seq = tick_index`. Now it's `tick_index × 1000 + n`, strictly increasing per source (live: 9001, 9002).
- [P3] `takeDueFaults` scanned the fault table on every step (5× per tick at speed 5). Now `pendingFaults` loads once per tick.

## Implementation report (Claude)
**Files** (`apps/db/src/`)
- `tick.ts`: `advance_tick` (scheduled only; `UNAUTHORIZED` for any other caller; deletes an orphaned schedule row whose run is gone; skips while paused). Per tick it runs `run.speed` steps: take due faults → `stepWorld` → (P2-5 hook for completed/failed command keys). It bumps `decision_epoch` once if any step had `material_change`, then saves the world, projects it, appends telemetry (last step only, so ≤ 1 sample per metric per GPU per wall second) and every signal (deduped by `event_id`; `observed_unix_ms` = tick wall time when physics leaves 0), and trims `telemetry_recent` to 2,000 rows (oldest by sim time, then `source_seq`). `stepWorld` is one line to swap: `TODO(P1-4)`.
- `faults.ts`: `inject_fault(fault_json)` (admin): JSON → `validatePayload('FaultInjection')` → run exists → target exists and fits the kind (pump faults → `cooling_pump`; XID / thermal → `gpu`; `node_crash` / `network_link_down` → node / link or `checkpoint_store` per §0.12 #7; `sensor_stale` → sensor-bearing kinds) → never real hardware (`brev_real`). Same `fault_id` + same payload is a no-op; a changed payload is rejected. **`fault_injection_truth` is the due-fault queue**: `takeDueFaults` hands undelivered rows starting within the next step to physics as `due_faults_private` and sets `active = true` ("delivered"). This keeps non-contract fields out of `PhysicsWorld`. A fault in the past applies on the next tick.
- `step-standin.ts`: **stand-in for P1's GPU `step`**, same signature, pure. It advances the clock, activates and expires faults, applies the XID effects pinned by §0.12 #8 (79 → `unreachable` + job on it `failed` with progress = durable; 48/74 → `degraded`) plus an `xid_error` signal whose `event_id` is built from public data, never the fault id, and emits one GPU temperature sample per simulated GPU. **No heat, throttling, job progress or pump effects.** Delete it when P1-4 lands.
- `run.ts`: `create_run` inserts the 1 s interval `tick_schedule` row (a reset removes the old one first).
- `index.ts`: exports `inject_fault`. Bindings regenerated (`inject_fault_reducer.ts`; `advance_tick` isn't client-callable, so it isn't generated).

**Verified on Maincloud `dcos-dev`** (code-only publishes, no data wiped)
- After `create_run`: 7 s later `tick_index` = 7, `sim_time_ms` = 607000, 448 telemetry rows (64 × 7), with no client connected.
- `inject_fault`: wrong kind (`gpu_xid_79` on a rack), `gpu-real-0`, unknown target, bad JSON, schema violation → `INVALID_PAYLOAD` / `NOT_FOUND`; anonymous → `UNAUTHORIZED`; same id + same payload → no-op; same id + changed payload → rejected.
- XID 79 on `gpu-r3-n1-0` at start+5 s: a `signal_event` row (`xid_error`, 79, critical, real wall `observed_unix_ms`); GPU `unreachable`, `last_xid_code` 79, version 1; `resource.current_status` `unreachable`, version 1; job-a `failed`, progress 95040 → 86400 (= durable), version 1; `decision_epoch` 0 → 1. A pump-a degradation fault was accepted and delivered (`active = true`) with no visible effect yet, as expected.
- `telemetry_recent` holds steady at exactly 2,000 rows.
- `pause_run true`: 5 s wall → `sim_time_ms` unchanged. `speed 5`: 678000 → 733000 in 11 s = 5 sim-s per wall-s. The logs show no tick errors.
- `tsc` clean (db, db-client); `pnpm -r test` 15 / 92 / 15.

**Real physics swapped in** (after `git merge origin/lane/p1-sim`, `b6040a4`)
- Both stand-ins (`preset.ts` + fixture JSON, `step-standin.ts`) were deleted. `create_run` calls `buildPreset`; `advance_tick` calls `step`; `projectWorld` projects `toObserved(world)` (it strips private keys, defense in depth). My own epoch bump was removed because P1's `step` already bumps `decision_epoch` on `material_change`. `ping` no longer uses `makeRng`, which moved to `@dcos/physics/v0`. `profile_version` = `gpu_demo_8@gpu_v1`.
- Live on `dcos-dev`: pump-a degradation at 10000 (speed 5). r2–r4 max temp 70.2 → 73.1 → 76.3 → 79.5 → 82.7 → 85.9 °C (8 GPUs throttled per rack at 85.9); r1/r5/r7/r8 stay at 38.7 °C; r6 stays at 82.2 °C (hot by design); pump-a `degraded`, capacity estimate 9600 W; epoch 1 → 12. XID 79 at 5000: signal `sig.5000.gpu-r3-n1-0.xid_error` (critical), GPU `unreachable`/79, job-a `failed` 95088 → 86400 (= durable), epoch 1. `pnpm -r test`: 15 / 335 / 15.

**P1's `buildPreset` misses three contract points** (P1 to fix; P2 can't patch them, because shifting the clock would desync P1's hidden state):
- clock starts at **0**, not 600000; both checkpoints are stamped at 0 (§0.12 #2). Until it's fixed, the gate times are relative to 0 (pump fault at 10000).
- no `node-real-0` and no `gpu-real-0` `gpu_current` row (§0.11 #4), so `gpu_current` = **64**, not the 65 that P2-3's check expects
- `cooling_current` has pumps only, no loop rows (§0.11 #9)
- also: the thermal throttle bit is `0x40` (`CLOCKS_EVENT_HW_THERMAL`), but §0.11 #5 says `clocks_event_reasons & 0x20`. P1 and P3 must agree, or P3 won't see throttling.

**Open** §0.12 #2: the gate's "10,000 ms" means **610000** (start + 10 s).
- Reducer time limit: still no booth answer. The stand-in tick keeps up at 5×. P1's real step runs 5× per tick, and each tick parses and stringifies the ~100 KB world, so re-check at 5× once it lands. If it's too slow, write the world only on the last step (already true) and cap `speed`.
- Telemetry budget: P1's `step` emits **266 rows per tick**, so the 2,000-row cap ≈ **7.5 s** of history. If P4's charts need longer, options: keep only the temperature metric per GPU in `telemetry_recent`, or downsample. Needs a P4 decision.
