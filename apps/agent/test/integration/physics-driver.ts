// Integration helper: drive P1's REAL @dcos/physics world tick by tick (the same loop P2's DB tick runs),
// collecting the signals it emits. No fakes. Used by the real-physics and p2-mock integration tests.
import type { ActionCommand, FaultInjection, ObservedSnapshot, PhysicsWorld, SignalEvent } from '@dcos/contracts';
import {
  STEP_MS,
  WIRE_SCHEMA_VERSION,
  buildPreset,
  enqueueCommands,
  loadScenarios,
  step,
  toObserved,
  type Scenario,
} from '@dcos/physics';

export const RUN_ID = 'run-demo-1';

export interface Driver {
  world: PhysicsWorld;
  signals: SignalEvent[];
  /** Faults handed to step() once their start time is reached (in addition to any scenario faults). */
  pending: FaultInjection[];
  completed: string[];
  failed: string[];
}

export function scenario(id: string): Scenario {
  const s = loadScenarios().find((x) => x.scenario_id === id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
}

export function newDriver(seed: number, faults: FaultInjection[] = []): Driver {
  return { world: buildPreset('gpu_demo_8', RUN_ID, seed), signals: [], pending: [...faults], completed: [], failed: [] };
}

export const simNow = (d: Driver): number => d.world.observable.clock.sim_time_ms;
export const observe = (d: Driver): ObservedSnapshot => toObserved(d.world);

/** One physics tick; `start` = action ids to start this tick (§0.12 #3). */
export function tick(d: Driver, start: string[] = []): void {
  const t1 = simNow(d) + STEP_MS;
  const active = new Set(d.world.active_faults_private.map((f) => f.fault_id));
  const due = d.pending.filter((f) => f.start_sim_time_ms <= t1 && !active.has(f.fault_id));
  d.pending = d.pending.filter((f) => !due.includes(f));
  const r = step({
    schema_version: WIRE_SCHEMA_VERSION,
    run_id: d.world.run_id,
    step_ms: STEP_MS,
    seed: 0,
    world: d.world,
    due_faults_private: due,
    requested_action_ids: start,
  });
  d.world = r.world_after;
  d.signals.push(...r.signals);
  d.completed.push(...r.completed_command_keys);
  d.failed.push(...r.failed_command_keys);
}

export function runUntil(d: Driver, simMs: number): void {
  while (simNow(d) < simMs) tick(d);
}

/** Enqueue commands (trusted harness path) and start them on the next tick. */
export function startCommands(d: Driver, cmds: ActionCommand[]): void {
  d.world = enqueueCommands(d.world, cmds);
  tick(d, cmds.map((c) => c.action_id));
}

export function xidFault(gpuId: string, atMs: number): FaultInjection {
  return {
    schema_version: WIRE_SCHEMA_VERSION,
    fault_id: `flt.integration.xid79.${gpuId}`,
    run_id: RUN_ID,
    target_resource_id: gpuId,
    kind: 'gpu_xid_79',
    start_sim_time_ms: atMs,
    duration_sim_ms: null,
    severity: 1,
    parameters: {},
    seed_offset: 0,
  };
}

/** The demo pump fault (sc17 / sc06: pump-a at 40% capacity from 610000, the §0.12 gate time). */
export function demoPumpFault(): FaultInjection {
  const f = scenario('sc17-demo-destination-xid79').faults.find((x) => x.kind === 'cooling_pump_degradation');
  if (!f) throw new Error('sc17 has no pump fault');
  return structuredClone(f);
}

export const rackOf = (gpuId: string): string => gpuId.split('-')[1]!;
export const LOOP_A_RACKS = new Set(['r2', 'r3', 'r4']);
