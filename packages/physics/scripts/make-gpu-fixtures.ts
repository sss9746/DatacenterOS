// P1-1: writes the GPU fixtures in packages/physics/fixtures/gpu/ for preset `gpu_demo_8`, from the REAL model.
//
//   pnpm --filter @dcos/physics build && node packages/physics/scripts/make-gpu-fixtures.ts
//
// Every file is produced by the package's own buildPreset / toObserved / step (plus scenarioTickInput, so faults are
// fed with the same dueFaults rule as the DB tick and the evaluation harness). main() runs the BUILT package (dist/),
// because Node's type stripping cannot resolve the `.js` import specifiers inside src/; test/gpu-fixtures.test.ts
// calls buildGpuFixtures() with the src API and fails if the files on disk differ, so a stale dist cannot slip through.
// Deterministic: no clock or randomness; writes happen only in main(). (A Node script, not package source: node:fs is OK.)
//
// Files (times relative to the run start, RUN_START_SIM_MS):
//   observed_snapshot_demo.json           toObserved(buildPreset('gpu_demo_8', 'run-demo-1', 1)) at the run start
//   observed_snapshot_pump_degraded.json  start + 120 s, pump-a degraded since start + 10 s (PUMP_A_FAULT)
//   tick_result_example.json              the PhysicsTickResult of the start + 9 s → start + 10 s tick that applies it
//   signal_xid79.json                     the XID 79 SignalEvent on gpu-r3-n1-0 at start + 150 s
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  FaultInjection,
  ObservedSnapshot,
  PhysicsTickResult,
  PhysicsWorld,
  SignalEvent,
  SimulationTickInput,
} from '../../contracts/src/index.js';
import type { Scenario } from '../src/gpu/scenarios.js';

export const RUN_ID = 'run-demo-1';
export const PRESET_ID = 'gpu_demo_8';
export const SEED = 1;
/** Offsets from the run start, ms. */
export const PUMP_A_FAULT_OFFSET_MS = 10_000;
export const PUMP_DEGRADED_OFFSET_MS = 120_000;
export const XID79_OFFSET_MS = 150_000;

/** The slice of @dcos/physics the generator needs (src in tests, dist in main()). */
export interface PhysicsApi {
  RUN_START_SIM_MS: number;
  buildPreset: (presetId: 'gpu_demo_8', runId: string, seed: number) => PhysicsWorld;
  toObserved: (world: PhysicsWorld) => ObservedSnapshot;
  step: (input: SimulationTickInput) => PhysicsTickResult;
  scenarioTickInput: (s: Scenario, world: PhysicsWorld, requestedActionIds?: string[], stepMs?: number) => SimulationTickInput;
}

/** pump-a loses 60% of its capacity and pump power at start + 10 s (the Gate 1 fault). */
export function pumpAFault(runStartMs: number): FaultInjection {
  return {
    schema_version: '1.1.0', fault_id: 'fault-pump-a-degradation-1', run_id: RUN_ID, target_resource_id: 'pump-a',
    kind: 'cooling_pump_degradation', start_sim_time_ms: runStartMs + PUMP_A_FAULT_OFFSET_MS, duration_sim_ms: null,
    severity: 0.6, parameters: { capacity_factor: 0.4 }, seed_offset: 0,
  };
}

/** XID 79 on gpu-r3-n1-0 at start + 150 s (30 s after the pump-degraded snapshot: the Gate 3 overlap window). */
export function xid79Fault(runStartMs: number): FaultInjection {
  return {
    schema_version: '1.1.0', fault_id: 'fault-xid79-r3-0', run_id: RUN_ID, target_resource_id: 'gpu-r3-n1-0',
    kind: 'gpu_xid_79', start_sim_time_ms: runStartMs + XID79_OFFSET_MS, duration_sim_ms: null, severity: 1,
    parameters: {}, seed_offset: 0,
  };
}

/** Step the demo world with these faults until the clock reaches untilMs; returns every tick result. */
function run(api: PhysicsApi, faults: FaultInjection[], untilMs: number): { world: PhysicsWorld; results: PhysicsTickResult[] } {
  const s: Scenario = { scenario_id: 'fixture', seed: SEED, preset_id: PRESET_ID, faults, horizon_s: 0 };
  let world = api.buildPreset(PRESET_ID, RUN_ID, SEED);
  const results: PhysicsTickResult[] = [];
  while (world.observable.clock.sim_time_ms < untilMs) {
    const r = api.step(api.scenarioTickInput(s, world));
    results.push(r);
    world = r.world_after;
  }
  return { world, results };
}

/** File name → payload. The contract type for each file is in FIXTURE_TYPES. */
export function buildGpuFixtures(api: PhysicsApi): Record<string, unknown> {
  const t0 = api.RUN_START_SIM_MS;
  const pump = run(api, [pumpAFault(t0)], t0 + PUMP_DEGRADED_OFFSET_MS);
  const tick = pump.results.find((r) => r.world_after.observable.clock.sim_time_ms === t0 + PUMP_A_FAULT_OFFSET_MS);
  const xid = run(api, [xid79Fault(t0)], t0 + XID79_OFFSET_MS).results.at(-1);
  const signal: SignalEvent | undefined = xid?.signals.find((s) => s.event_type === 'xid_error');
  if (!tick || !signal) throw new Error('make-gpu-fixtures: the fault tick or the XID signal is missing');
  return {
    'observed_snapshot_demo.json': api.toObserved(api.buildPreset(PRESET_ID, RUN_ID, SEED)),
    'observed_snapshot_pump_degraded.json': api.toObserved(pump.world),
    'tick_result_example.json': tick,
    'signal_xid79.json': signal,
  };
}

export const FIXTURE_TYPES = {
  'observed_snapshot_demo.json': 'ObservedSnapshot',
  'observed_snapshot_pump_degraded.json': 'ObservedSnapshot',
  'tick_result_example.json': 'PhysicsTickResult',
  'signal_xid79.json': 'SignalEvent',
} as const;

export const serializeFixture = (payload: unknown) => `${JSON.stringify(payload, null, 2)}\n`;

export const GPU_FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'gpu');

async function main(): Promise<void> {
  const api = (await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')).href)) as PhysicsApi;
  mkdirSync(GPU_FIXTURE_DIR, { recursive: true });
  for (const [name, payload] of Object.entries(buildGpuFixtures(api))) {
    writeFileSync(join(GPU_FIXTURE_DIR, name), serializeFixture(payload));
    console.log(`wrote fixtures/gpu/${name}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
