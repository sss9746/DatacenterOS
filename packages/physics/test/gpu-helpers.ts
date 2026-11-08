// Helpers for the GPU-layer tests: drive step() the way the DB tick does.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FaultInjection, PhysicsTickResult, PhysicsWorld, SimulationTickInput } from '@dcos/contracts';
import { buildPreset, step } from '../src/index.js';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'gpu');
export const readFixture = <T>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;

export const SLOTS = [0, 1, 2, 3, 4, 5, 6, 7];
export const gpusOn = (...racks: number[]) => racks.flatMap((r) => SLOTS.map((k) => `gpu-r${r}-n1-${k}`));

export const demoWorld = (seed = 1) => buildPreset('gpu_demo_8', 'run-demo-1', seed);

export function fault(
  kind: FaultInjection['kind'], target: string, startMs: number, opts: Partial<FaultInjection> = {},
): FaultInjection {
  return {
    schema_version: '1.1.0', fault_id: `fault-${kind}-${target}-${startMs}`, run_id: 'run-demo-1',
    target_resource_id: target, kind, start_sim_time_ms: startMs, duration_sim_ms: null, severity: 1,
    parameters: {}, seed_offset: 0, ...opts,
  };
}

/** Same fault as the P1-1 fixtures (fixtures/gpu/tick_result_example.json). */
export const PUMP_A_FAULT: FaultInjection = {
  schema_version: '1.1.0', fault_id: 'fault-pump-a-degradation-1', run_id: 'run-demo-1', target_resource_id: 'pump-a',
  kind: 'cooling_pump_degradation', start_sim_time_ms: 10_000, duration_sim_ms: null, severity: 0.6,
  parameters: { capacity_factor: 0.4 }, seed_offset: 0,
};

export function tickInput(world: PhysicsWorld, faults: FaultInjection[] = [], requested: string[] = [], seed = 1): SimulationTickInput {
  const t1 = world.observable.clock.sim_time_ms + 1000;
  return {
    schema_version: '1.1.0', run_id: world.run_id, step_ms: 1000, seed, world,
    // the DB passes the faults due by the end of this tick that are not active yet
    due_faults_private: faults.filter((f) => f.start_sim_time_ms <= t1 && !world.active_faults_private.some((a) => a.fault_id === f.fault_id)),
    requested_action_ids: requested,
  };
}

export interface RunOpts {
  faults?: FaultInjection[];
  /** action ids to request on the tick that ends at a given sim time */
  requestAt?: Record<number, string[]>;
  /** hook to change the world before a tick (e.g. enqueue commands); returns the world to step */
  before?: (world: PhysicsWorld) => PhysicsWorld;
  onTick?: (r: PhysicsTickResult) => void;
}

/** Step until the world's clock reaches untilMs. Returns the final world and every tick result. */
export function runUntil(world: PhysicsWorld, untilMs: number, opts: RunOpts = {}): { world: PhysicsWorld; results: PhysicsTickResult[] } {
  const results: PhysicsTickResult[] = [];
  let w = world;
  while (w.observable.clock.sim_time_ms < untilMs) {
    if (opts.before) w = opts.before(w);
    const t1 = w.observable.clock.sim_time_ms + 1000;
    const r = step(tickInput(w, opts.faults ?? [], opts.requestAt?.[t1] ?? []));
    results.push(r);
    opts.onTick?.(r);
    w = r.world_after;
  }
  return { world: w, results };
}

export function deepFreeze<T>(x: T): T {
  if (x && typeof x === 'object') {
    for (const v of Object.values(x as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(x);
  }
  return x;
}
