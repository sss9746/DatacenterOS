# GPU fixtures: preset `gpu_demo_8` (P1-1)

Generated from the real model (`buildPreset` / `toObserved` / `step` in `@dcos/physics`) by:

```
pnpm --filter @dcos/physics build && node packages/physics/scripts/make-gpu-fixtures.ts
```

Do not hand-edit: `test/gpu-fixtures.test.ts` fails if a file differs from the generator. IDs follow CONTRACTS §0.3.
**Every number is simulated.** Contract: CONTRACTS v1.1.1 (§0.11, §0.12).

The run clock starts at **`sim_time_ms = 600000`** (CONTRACTS §0.12 #2). Times below are "start + N s".

| File | Type | What it is |
|---|---|---|
| `observed_snapshot_demo.json` | `ObservedSnapshot` | Run start (sim 600 000, tick 0), healthy. job-a on r2+r3, job-b on r4, job-c on r6; r1/r5/r7/r8 free |
| `observed_snapshot_pump_degraded.json` | `ObservedSnapshot` | Start + 120 s (sim 720 000, tick 120); pump-a degraded since start + 10 s. r2–r4 GPUs 74.1–74.7 °C and rising ≈0.04 °C/s |
| `tick_result_example.json` | `PhysicsTickResult` | The start + 9 s → start + 10 s tick (ends at sim 610 000) that applies the pump-a fault: the private world, 266 telemetry events, 1 alarm, `material_change: true` |
| `signal_xid79.json` | `SignalEvent` | XID 79 on `gpu-r3-n1-0` at start + 150 s (sim 750 000) |

## Contents

- **Checkpoints before the run**: job-a's completed at **60 000** (requested 30 000), so it is 9 min old at the start;
  job-b's completed at **540 000** (requested 510 000), 1 min old; job-c has none. Age is always
  `clock.sim_time_ms − complete_sim_time_ms`, and it matches `progress − durable` (job-a 8 640 work units at risk,
  job-b 480).
- **`clock.tick_index`** counts ticks since the run start (0 at sim 600 000). `source_seq` is
  `tick_index × 1000 + i` (telemetry i < 900, signals 900 + j), unique and increasing. Event ids embed `sim_time_ms`:
  `tel.<t>.<resource>.<metric>`, `sig.<t>.<resource>.<event_type>`.
- **Thermal throttle bit** (CONTRACTS §0.11 #5): `clocks_event_reasons & 0x20` (DCGM SW thermal slowdown). A power cap
  sets `0x04` (SW power cap). `0x40` is never set.
- **`cooling_current`** (CONTRACTS §0.11 #9) has four rows: `pump-a`, `pump-b`, `loop-a`, `loop-b`. A loop row mirrors
  its driving pump: same `operating_state` and `version` bump, `nominal_capacity_w` / `observed_capacity_estimate_w`
  = its pump's, `pump_power_w` = the driving pump's observed power. **Never add pump and loop rows together**: sum
  capacity over pump rows (resource kind `cooling_pump`) only. `pump.power_w` telemetry exists for the two pumps only.
- **The real Brev GPU** (CONTRACTS §0.11 #4): `gpu-real-0` sits on node `node-real-0` (resource kind `node`,
  `profile: "brev_real"`, `parent_id: null`, `config.allocatable: false`), with a `gpu-real-0 hosted_on node-real-0`
  edge. Neither appears in `gpus[]` or `nodes[]`: `gpu-real-0`'s `gpu_current` row comes from `nvidia-smi` ingest
  (`source_kind: "hardware"`), and `node-real-0` has no `node_current` row (`NodeCurrent.rack_id` is required). No job
  may be placed on them; safety answers `REAL_GPU_NOT_ALLOCATABLE`.

Assumptions not in §0.4 (all in `src/gpu/constants.ts`):
- loop supply / rack inlet 35 °C, so a loaded GPU sits at ≈70 °C
- r6 inlet +12 °C, so r6 is the hot destination with 2.9 °C of headroom
- idle GPU load 0.1 (70 W)
- pump capacity 8 kW per rack (pump-a 24 kW, pump-b 40 kW)
- pump power 500 W per rack
- pump-a fault severity 0.6, so capacity and pump power drop to 40% (9.6 kW, 600 W)
- rack thermal mass 60 kJ/°C (from v0)

## Changed in v1.1.1 (for P2 / P3 / P4)

- **Clock**: the run starts at sim **600 000** (was 0). The pump fault is at 610 000, the degraded snapshot at 720 000,
  the XID at 750 000. `tick_index` still starts at 0. Event ids, `source_seq`, `last_seen_sim_ms`,
  `last_update_sim_time_ms` and `observed_unix_ms` (= 1 794 091 200 000 + sim_time_ms) moved with it.
- **Checkpoints**: pre-run rows now have real times (job-a 30 000 → 60 000, job-b 510 000 → 540 000) instead of 0.
- **Thermal bit**: `0x20`, was `0x40`.
- **`node-real-0`**: new `node` resource; `gpu-real-0.parent_id` is now `node-real-0` (was `null`), plus a new
  `hosted_on` edge.
- **`cooling`**: two new rows, `loop-a` and `loop-b`, after the pumps.
- **`tick_result_example.json`**: `hidden_physics_state_json` is now the real `gpu_v1` hidden state (private; never
  show it), not the old stand-in.
- Scenario faults (`fixtures/scenarios/`) moved by +600 000 as well; `horizon_s` is still relative to the run start.
