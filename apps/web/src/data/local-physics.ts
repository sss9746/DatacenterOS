import { validatePayload, type FaultInjection, type PhysicsWorld } from '@dcos/contracts';
import { createMockClient, type DbClient, type MockDbClient } from '@dcos/db-client';
import { buildPreset, step, toObserved, STEP_MS, WIRE_SCHEMA_VERSION } from '@dcos/physics';

/**
 * Browser-local demo using P1's real physics engine. The mock DB client only supplies the
 * existing subscription/read API; it does not advance the world or apply faults here.
 * This is an isolated run, not a durable SpacetimeDB session or an agent execution.
 */
export interface LocalPhysicsClient extends MockDbClient {
  readonly localPhysics: true;
  advance(seconds: number): void;
}

export interface LocalFacilityConfig {
  pumpACapacityPct: number;
  pumpBCapacityPct: number;
  rack6InletOffsetC: number;
}

export const DEFAULT_LOCAL_FACILITY: LocalFacilityConfig = {
  pumpACapacityPct: 100,
  pumpBCapacityPct: 100,
  rack6InletOffsetC: 12,
};

function configuredWorld(seed: number, config: LocalFacilityConfig, runId = 'run-demo-1'): PhysicsWorld {
  for (const value of [config.pumpACapacityPct, config.pumpBCapacityPct]) {
    if (!Number.isFinite(value) || value < 40 || value > 140) throw new Error('Pump capacity must be 40–140%.');
  }
  if (!Number.isFinite(config.rack6InletOffsetC) || config.rack6InletOffsetC < 0 || config.rack6InletOffsetC > 20) {
    throw new Error('Rack 6 inlet offset must be 0–20 °C.');
  }
  let next = buildPreset('gpu_demo_8', runId, seed);
  const pumpFactors: Record<string, number> = { 'pump-a': config.pumpACapacityPct / 100, 'pump-b': config.pumpBCapacityPct / 100 };
  for (const resource of next.observable.resources) {
    if (resource.kind === 'cooling_pump') {
      const nominal = resource.config.nominal_capacity_w;
      if (typeof nominal === 'number') resource.config.nominal_capacity_w = nominal * pumpFactors[resource.resource_id]!;
    }
    if (resource.resource_id === 'rack-r6') resource.config.inlet_offset_c = config.rack6InletOffsetC;
  }
  for (const row of next.observable.cooling) {
    const factor = pumpFactors[row.resource_id];
    if (factor !== undefined) {
      row.nominal_capacity_w *= factor;
      row.observed_capacity_estimate_w = row.nominal_capacity_w;
    }
  }
  if (config.pumpACapacityPct !== 100 || config.pumpBCapacityPct !== 100 || config.rack6InletOffsetC !== 12) {
    next = step({ schema_version: WIRE_SCHEMA_VERSION, run_id: next.run_id, world: next,
      step_ms: STEP_MS, seed, due_faults_private: [], requested_action_ids: [] }).world_after;
  }
  return next;
}

const allowedTargets: Record<FaultInjection['kind'], readonly string[]> = {
  cooling_pump_degradation: ['cooling_pump'],
  cooling_pump_outage: ['cooling_pump'],
  gpu_thermal_load: ['gpu'],
  gpu_xid_48: ['gpu'],
  gpu_xid_79: ['gpu'],
  gpu_xid_74: ['gpu'],
  network_link_down: ['network_link', 'checkpoint_store'],
  node_crash: ['node', 'checkpoint_store'],
  sensor_stale: ['gpu', 'rack', 'cooling_pump'],
};

export function createLocalPhysicsClient(seed = 42, config: LocalFacilityConfig = DEFAULT_LOCAL_FACILITY): LocalPhysicsClient {
  let world = configuredWorld(seed, config);
  const base = createMockClient({ snapshot: toObserved(world) });
  const pending: FaultInjection[] = [];
  const injected: FaultInjection[] = [];
  const sync = () => base.loadSnapshot(toObserved(world));
  const runSteps = (count: number, publishEachStep: boolean) => {
    if (world.observable.clock.paused) return;
    const signals = [] as ReturnType<typeof step>['signals'];
    for (let i = 0; i < count; i++) {
      const due = pending.filter((fault) => fault.start_sim_time_ms <= world.observable.clock.sim_time_ms + STEP_MS);
      for (const fault of due) pending.splice(pending.indexOf(fault), 1);
      const result = step({
        schema_version: WIRE_SCHEMA_VERSION,
        run_id: world.run_id,
        world,
        step_ms: STEP_MS,
        seed,
        due_faults_private: due,
        requested_action_ids: [],
      });
      world = result.world_after;
      signals.push(...result.signals);
      if (publishEachStep) sync();
    }
    if (!publishEachStep) sync();
    for (const signal of signals) base.injectSignal(signal);
  };

  return {
    ...base,
    localPhysics: true,
    get injectedFaults() { return injected; },
    getObservedSnapshot: async () => toObserved(world),
    tick(simMs = STEP_MS) { runSteps(Math.max(1, Math.round(simMs / STEP_MS)), true); },
    advance(seconds) { runSteps(Math.max(1, Math.min(600, Math.round(seconds))), false); },
    async injectFault(fault) {
      const validation = validatePayload('FaultInjection', fault);
      if (!validation.ok) throw new Error(`Invalid fault injection: ${validation.errors.join('; ')}`);
      if (fault.run_id !== world.run_id) throw new Error('Fault belongs to a different run.');
      const target = world.observable.resources.find((resource) => resource.resource_id === fault.target_resource_id);
      if (!target || !allowedTargets[fault.kind].includes(target.kind) || target.resource_id === 'gpu-real-0' || target.resource_id === 'node-real-0') {
        throw new Error(`${fault.target_resource_id} is not a supported target for ${fault.kind}.`);
      }
      if (injected.some((entry) => entry.fault_id === fault.fault_id)) throw new Error(`Fault ${fault.fault_id} already exists.`);
      injected.push(structuredClone(fault));
      pending.push(structuredClone(fault));
    },
    async createRun(runId, nextSeed, presetId) {
      if (presetId !== 'gpu_demo_8') throw new Error(`Unknown preset ${presetId}.`);
      world = configuredWorld(nextSeed, config, runId);
      pending.length = 0;
      injected.length = 0;
      await base.createRun(runId, nextSeed, presetId);
      sync();
    },
    async pauseRun(runId, paused) {
      if (runId !== world.run_id) throw new Error('Run not found.');
      world = { ...world, observable: { ...world.observable, clock: { ...world.observable.clock, paused } } };
      await base.pauseRun(runId, paused);
      sync();
    },
  };
}

export function asLocalPhysics(client: DbClient): LocalPhysicsClient | null {
  return 'localPhysics' in client && client.localPhysics === true ? client as LocalPhysicsClient : null;
}
