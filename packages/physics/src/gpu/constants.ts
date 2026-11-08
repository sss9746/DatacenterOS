// GPU layer constants. EVERY number here is SIMULATED and configurable (CONTRACTS §0.4: shown in the UI as
// "simulated, configurable"). §0.4 values come first; the rest are the P1-1 fixture assumptions
// (packages/physics/fixtures/gpu/README.md, scripts/make-gpu-fixtures.ts FIXTURE_SIM) so the real model and the
// fixtures P2/P3/P4 build against agree.
import { DEFAULT_THERMAL_MASS_KJ_PER_C } from '../constants.js';

/** Wire schema version stamped on every payload (same value as @dcos/contracts SCHEMA_VERSION). */
export const WIRE_SCHEMA_VERSION = '1.1.0' as const;
export const GPU_MODEL_VERSION = 'gpu_v1' as const;

// ---- §0.4 simulated defaults -----------------------------------------------------------------
/** Simulated: GPU temp = rack inlet + 35 °C × load (load = power / 700 W, so ≈70 °C healthy at 35 °C inlet). */
export const GPU_TEMP_RISE_C_PER_LOAD = 35;
/** Simulated slowdown (throttle) temperature, °C. At or above it: SM clock −30%, HW thermal bit set. */
export const SLOWDOWN_C = 85;
/** Simulated shutdown temperature, °C. At or above it the GPU becomes unavailable; a non-elastic job fails. */
export const SHUTDOWN_C = 92;
/** Simulated SM clock factor while thermally throttled (−30%). */
export const THROTTLE_CLOCK_FACTOR = 0.7;
/** Simulated nominal SM clock, MHz. */
export const SM_CLOCK_NOMINAL_MHZ = 1980;
/** Simulated GPU power at full load and default power limit, W. */
export const POWER_LIMIT_W = 700;
/** Simulated power cap applied by `power_cap`, W. */
export const POWER_CAP_W = 500;
/** Simulated SM clock factor under a power cap (−15%). */
export const POWER_CAP_CLOCK_FACTOR = 0.85;
/** Simulated checkpoint write time, ms. */
export const CHECKPOINT_DURATION_MS = 30_000;
/** Simulated checkpoint interval, ms. Informational only: there are NO automatic periodic checkpoints. */
export const CHECKPOINT_INTERVAL_MS = 600_000;
/** Simulated restart time after a move, ms. */
export const RESTART_DURATION_MS = 120_000;
/** Simulated tick, ms. */
export const STEP_MS = 1000;
/** Simulated wall time per tick at demo speed 1×, ms. */
export const WALL_TICK_MS = 1000;
/** Simulated planner horizon, s (used by simulatePlan, P1-7). */
export const PLANNER_HORIZON_S = 600;

// ---- fixture assumptions (not in §0.4), all simulated -----------------------------------------
/** Simulated loop supply / healthy rack inlet temperature, °C (chiller setpoint; loops never cool below it). */
export const LOOP_SUPPLY_C = 35;
/** Simulated load of a GPU with no job (power = 700 W × load = 70 W). */
export const IDLE_LOAD = 0.1;
/** Simulated rack thermal mass, kJ/°C (same as the v0 facility model's DEFAULT_THERMAL_MASS_KJ_PER_C). */
export const RACK_THERMAL_MASS_KJ_PER_C = DEFAULT_THERMAL_MASS_KJ_PER_C;
/** Simulated cooling capacity per rack served, W (pump-a: 3 racks = 24 kW; pump-b: 5 racks = 40 kW). */
export const PUMP_CAPACITY_W_PER_RACK = 8000;
/** Simulated pump electrical power per rack served at nominal flow, W (pump-a 1.5 kW, pump-b 2.5 kW). */
export const PUMP_POWER_W_PER_RACK = 500;
/** Simulated inlet offset of rack-r6 (restricted manifold), °C: r6 is the hot destination (§0.3 job-c row). */
export const R6_INLET_OFFSET_C = 12;
/** Simulated per-GPU temperature spread, °C: a seeded offset in [−0.3, +0.3). */
export const GPU_TEMP_SPREAD_C = 0.6;
/** Simulated work rate per GPU at nominal clock, work units per sim-second. */
export const WORK_RATE_PER_GPU_PER_SIM_S = 1;
/** Simulated unix-ms of sim t=0: observed_unix_ms = this + sim_time_ms (demo speed 1×). */
export const RUN_EPOCH_UNIX_MS = 1_794_091_200_000;
/** DCGM/NVML clocks_event_reasons HW thermal slowdown bit. */
export const CLOCKS_EVENT_HW_THERMAL = 0x40;
/** DCGM/NVML clocks_event_reasons SW power cap bit. */
export const CLOCKS_EVENT_SW_POWER_CAP = 0x4;
/** Simulated extra GPU temperature for a `gpu_thermal_load` fault at severity 1, °C (scaled by severity). */
export const THERMAL_LOAD_FAULT_MAX_C = 20;
/** Telemetry source id of the simulator. */
export const SIM_SOURCE_ID = 'sim-engine-1';
/** Per-tick source_seq layout: tick × 1000 + i; telemetry uses i < 900, signals 900 + j. */
export const SEQ_PER_TICK = 1000;
export const SIGNAL_SEQ_BASE = 900;
/** Most recent signal event ids kept in ObservedSnapshot.observation_event_ids. */
export const MAX_OBSERVATION_EVENT_IDS = 200;

// ---- preset gpu_demo_8 (CONTRACTS §0.3, frozen IDs) ------------------------------------------
export const PRESET_ID = 'gpu_demo_8' as const;
export const DEMO_RUN_ID = 'run-demo-1';
export const RACK_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export const GPU_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7] as const;
export const LOOP_A_RACKS: readonly number[] = [2, 3, 4];
export const CHECKPOINT_STORE_ID = 'ckpt-store-1';
export const POWER_DOMAIN_ID = 'power-main';
export const GPU_PROFILE = 'demo_gpu';

export const rackId = (r: number): string => `rack-r${r}`;
export const nodeId = (r: number): string => `node-r${r}-n1`;
export const gpuId = (r: number, k: number): string => `gpu-r${r}-n1-${k}`;
export const linkId = (r: number): string => `link-r${r}`;

/** Round to 0.1 (observed temperatures and headrooms). */
export const round1 = (x: number): number => Math.round(x * 10) / 10;
