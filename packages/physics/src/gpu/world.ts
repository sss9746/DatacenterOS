// GPU world model: what lives in PhysicsWorld.hidden_physics_state_json, a topology index built from the
// observable resources, and the derivation of the observed GPU / node / cooling rows from the true state.
// Pure and deterministic. Only `import type` from @dcos/contracts.
import type {
  ActionCommand,
  CoolingCurrent,
  FaultInjection,
  GpuCurrent,
  JobSpec,
  JobState,
  NodeCurrent,
  PhysicsWorld,
  ResourceSpec,
} from '@dcos/contracts';
import {
  CLOCKS_EVENT_HW_THERMAL,
  CLOCKS_EVENT_SW_POWER_CAP,
  GPU_MODEL_VERSION,
  GPU_TEMP_RISE_C_PER_LOAD,
  IDLE_LOAD,
  LOOP_SUPPLY_C,
  POWER_CAP_CLOCK_FACTOR,
  POWER_LIMIT_W,
  RACK_THERMAL_MASS_KJ_PER_C,
  SHUTDOWN_C,
  SLOWDOWN_C,
  SM_CLOCK_NOMINAL_MHZ,
  THERMAL_LOAD_FAULT_MAX_C,
  THROTTLE_CLOCK_FACTOR,
  round1,
} from './constants.js';

// ---- hidden state ------------------------------------------------------------------------------

/** Latched hardware failure of a GPU (truth; survives the fault's duration: hardware does not self-heal). */
export type GpuFailure = 'xid_79' | 'xid_48' | 'xid_74' | 'thermal_shutdown' | 'node_crash';

/** How a command ended. reason_code uses CONTRACTS §0.7 codes where one fits, else a physics-specific code. */
export interface CommandOutcome {
  ok: boolean;
  reason_code: string | null;
  sim_time_ms: number;
}

/** A command that has started and completes on a later tick (P1-5). */
export interface InFlightCommand {
  command: ActionCommand;
  started_sim_ms: number;
  due_sim_ms: number;
  /** checkpoint: the job status to return to when the write ends. */
  resume_status?: 'running' | 'paused';
  /** checkpoint: the checkpoint row being written. */
  checkpoint_id?: string;
  /** migrate_restart: the destination GPUs allocated at start. */
  destination_gpu_ids?: string[];
}

/**
 * Shape of PhysicsWorld.hidden_physics_state_json (internal to @dcos/physics; the contract types it as an open object).
 * Never copied into ObservedSnapshot.
 */
export interface HiddenState {
  model: typeof GPU_MODEL_VERSION;
  preset_id: string;
  seed: number;
  /** True coolant temperature per loop, °C (unrounded). Rack inlet = loop temp + rack inlet_offset_c. */
  loop_temp_c: Record<string, number>;
  /** Seeded per-GPU temperature offset, °C. */
  gpu_offset_c: Record<string, number>;
  /** Latched hardware failures. */
  gpu_failure: Record<string, GpuFailure>;
  /** GPUs cordoned by `cordon_gpu` (cordon never repairs: a failed GPU stays unreachable). */
  gpu_cordoned: string[];
  /** Next checkpoint sequence number per job (ckpt-<job>-<n>). */
  checkpoint_counter: Record<string, number>;
  /** Commands handed to physics (see actions.ts) waiting for their action_id to appear in requested_action_ids. */
  command_inbox: ActionCommand[];
  /** Started commands that complete on a later tick. */
  in_flight: InFlightCommand[];
  /** command_keys already completed or failed (idempotency: a key never runs twice). */
  finished_command_keys: string[];
  /** Outcome per finished command_key (PhysicsTickResult has no per-command reason field; see commandOutcome()). */
  command_outcomes: Record<string, CommandOutcome>;
  /** Last good observed values for resources under a sensor_stale fault: `${resource_id}|${field}` → value. */
  stale_values: Record<string, number>;
}

export function hiddenOf(world: PhysicsWorld): HiddenState {
  const h = world.hidden_physics_state_json as unknown as HiddenState;
  if (!h || h.model !== GPU_MODEL_VERSION) throw new Error('physics: world.hidden_physics_state_json is not a gpu_v1 state');
  return h;
}

// ---- plain-JSON deep clone (no structuredClone / JSON round-trip needed) ------------------------

export function cloneJson<T>(x: T): T {
  if (Array.isArray(x)) return x.map((v) => cloneJson(v)) as unknown as T;
  if (x !== null && typeof x === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(x as Record<string, unknown>)) out[k] = cloneJson((x as Record<string, unknown>)[k]);
    return out as T;
  }
  return x;
}

// ---- topology index ----------------------------------------------------------------------------

export interface Topology {
  racks: string[];
  rackLoop: Map<string, string>;
  rackOffsetC: Map<string, number>;
  rackMassKjPerC: Map<string, number>;
  loops: string[];
  loopRacks: Map<string, string[]>;
  loopSupplyC: Map<string, number>;
  loopPumps: Map<string, string[]>;
  pumps: string[];
  pumpNominalCapacityW: Map<string, number>;
  pumpNominalPowerW: Map<string, number>;
  nodeRack: Map<string, string>;
  nodeGpus: Map<string, string[]>;
  gpuNode: Map<string, string>;
  gpuRack: Map<string, string>;
  resources: Map<string, ResourceSpec>;
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Index the observable resources (rack config: cooling_loop_id, inlet_offset_c; loop config: pump_id, supply_temp_c). */
export function buildTopology(resources: ResourceSpec[], gpus: GpuCurrent[]): Topology {
  const t: Topology = {
    racks: [], rackLoop: new Map(), rackOffsetC: new Map(), rackMassKjPerC: new Map(),
    loops: [], loopRacks: new Map(), loopSupplyC: new Map(), loopPumps: new Map(),
    pumps: [], pumpNominalCapacityW: new Map(), pumpNominalPowerW: new Map(),
    nodeRack: new Map(), nodeGpus: new Map(), gpuNode: new Map(), gpuRack: new Map(), resources: new Map(),
  };
  for (const r of resources) t.resources.set(r.resource_id, r);
  for (const r of resources) {
    if (r.kind === 'cooling_loop') {
      t.loops.push(r.resource_id);
      t.loopRacks.set(r.resource_id, []);
      t.loopSupplyC.set(r.resource_id, num(r.config.supply_temp_c, LOOP_SUPPLY_C));
      const pump = str(r.config.pump_id);
      t.loopPumps.set(r.resource_id, pump ? [pump] : []);
    } else if (r.kind === 'cooling_pump') {
      t.pumps.push(r.resource_id);
      t.pumpNominalCapacityW.set(r.resource_id, num(r.config.nominal_capacity_w, 0));
      t.pumpNominalPowerW.set(r.resource_id, num(r.config.nominal_pump_power_w, 0));
    }
  }
  for (const r of resources) {
    if (r.kind === 'rack') {
      t.racks.push(r.resource_id);
      const loop = str(r.config.cooling_loop_id);
      if (loop) {
        t.rackLoop.set(r.resource_id, loop);
        t.loopRacks.get(loop)?.push(r.resource_id);
      }
      t.rackOffsetC.set(r.resource_id, num(r.config.inlet_offset_c, 0));
      t.rackMassKjPerC.set(r.resource_id, num(r.config.thermal_mass_kj_per_c, RACK_THERMAL_MASS_KJ_PER_C));
    } else if (r.kind === 'node' && r.parent_id) {
      t.nodeRack.set(r.resource_id, r.parent_id);
      t.nodeGpus.set(r.resource_id, []);
    }
  }
  for (const g of gpus) {
    t.gpuNode.set(g.resource_id, g.node_id);
    t.nodeGpus.get(g.node_id)?.push(g.resource_id);
    const rack = t.nodeRack.get(g.node_id);
    if (rack) t.gpuRack.set(g.resource_id, rack);
  }
  return t;
}

// ---- fault-derived conditions (recomputed every tick from active_faults_private) ----------------

export interface FaultConditions {
  /** Capacity / pump-power factor per pump (1 = healthy). */
  pumpFactor: Map<string, number>;
  pumpState: Map<string, CoolingCurrent['operating_state']>;
  /** Extra °C per GPU from gpu_thermal_load faults. */
  gpuExtraC: Map<string, number>;
  /** Checkpoint stores that are unreachable (any active node_crash / network_link_down fault targeting the store). */
  storageDown: Set<string>;
  /** Resources whose sensors are stale. */
  stale: Set<string>;
}

export function faultConditions(faults: FaultInjection[], topo: Topology): FaultConditions {
  const c: FaultConditions = { pumpFactor: new Map(), pumpState: new Map(), gpuExtraC: new Map(), storageDown: new Set(), stale: new Set() };
  for (const f of faults) {
    const target = f.target_resource_id;
    switch (f.kind) {
      case 'cooling_pump_degradation': {
        c.pumpFactor.set(target, (c.pumpFactor.get(target) ?? 1) * (1 - f.severity));
        if (c.pumpState.get(target) !== 'failed') c.pumpState.set(target, 'degraded');
        break;
      }
      case 'cooling_pump_outage':
        c.pumpFactor.set(target, 0);
        c.pumpState.set(target, 'failed');
        break;
      case 'gpu_thermal_load': {
        const extra = num(f.parameters.extra_temp_c, f.severity * THERMAL_LOAD_FAULT_MAX_C);
        c.gpuExtraC.set(target, (c.gpuExtraC.get(target) ?? 0) + extra);
        break;
      }
      case 'node_crash':
      case 'network_link_down':
        if (topo.resources.get(target)?.kind === 'checkpoint_store') c.storageDown.add(target);
        break;
      case 'sensor_stale':
        c.stale.add(target);
        break;
      default:
        break; // XIDs latch into hidden.gpu_failure when applied (faults.ts)
    }
  }
  return c;
}

// ---- jobs --------------------------------------------------------------------------------------

/** GPU → job for every allocation. */
export function gpuJobMap(jobStates: JobState[]): Map<string, JobState> {
  const m = new Map<string, JobState>();
  for (const j of jobStates) for (const g of j.allocated_gpu_ids) m.set(g, j);
  return m;
}

export function specOf(world: PhysicsWorld, jobId: string): JobSpec | undefined {
  return world.observable.job_specs.find((s) => s.job_id === jobId);
}

/** Load of a GPU: 1 when it runs a job that is computing, else idle. */
export function gpuLoad(gpu: string, jobs: Map<string, JobState>): number {
  return jobs.get(gpu)?.status === 'running' ? 1 : IDLE_LOAD;
}

// ---- thermal / electrical derivation -----------------------------------------------------------

export interface GpuPhysics {
  temp_c: number; // observed-precision (0.1 °C) true temperature
  power_w: number;
  throttled: boolean;
  capped: boolean;
  clock_factor: number; // SM clock / nominal (job work-rate multiplier)
}

export const UNREACHABLE_FAILURES: ReadonlySet<GpuFailure> = new Set(['xid_79', 'thermal_shutdown', 'node_crash']);

export function rackInletC(rack: string, h: HiddenState, topo: Topology): number {
  const loop = topo.rackLoop.get(rack);
  const loopTemp = loop ? (h.loop_temp_c[loop] ?? topo.loopSupplyC.get(loop) ?? LOOP_SUPPLY_C) : LOOP_SUPPLY_C;
  return loopTemp + (topo.rackOffsetC.get(rack) ?? 0);
}

/** Physics of one reachable GPU at the current true state. GPU temp = inlet + 35 °C × load (+ seeded offset). */
export function gpuPhysics(
  gpu: GpuCurrent, load: number, h: HiddenState, topo: Topology, cond: FaultConditions,
): GpuPhysics {
  const rack = topo.gpuRack.get(gpu.resource_id) ?? '';
  const rawPower = POWER_LIMIT_W * load;
  const capped = rawPower > gpu.power_limit_w;
  const power = capped ? gpu.power_limit_w : rawPower;
  const heatLoad = capped ? gpu.power_limit_w / POWER_LIMIT_W : load;
  const temp = round1(
    rackInletC(rack, h, topo) + GPU_TEMP_RISE_C_PER_LOAD * heatLoad + (h.gpu_offset_c[gpu.resource_id] ?? 0)
      + (cond.gpuExtraC.get(gpu.resource_id) ?? 0),
  );
  const throttled = temp >= SLOWDOWN_C;
  const limited = gpu.power_limit_w < POWER_LIMIT_W;
  const clock_factor = (throttled ? THROTTLE_CLOCK_FACTOR : 1) * (limited ? POWER_CAP_CLOCK_FACTOR : 1);
  return { temp_c: temp, power_w: power, throttled, capped, clock_factor };
}

export function isShutdownTemp(tempC: number): boolean {
  return tempC >= SHUTDOWN_C;
}

/** Availability from truth: unreachable > cordoned > degraded > ready. Cordon never yields 'ready'. */
export function gpuAvailability(gpuId: string, h: HiddenState): GpuCurrent['availability'] {
  const failure = h.gpu_failure[gpuId];
  if (failure && UNREACHABLE_FAILURES.has(failure)) return 'unreachable';
  if (h.gpu_cordoned.includes(gpuId)) return 'cordoned';
  if (failure) return 'degraded';
  return 'ready';
}

/**
 * Recompute every observed GPU row from the true state at `simMs`. Unreachable GPUs keep their last observed
 * temperature and last_seen (no telemetry reaches us), draw 0 W and report 0 MHz. Stale-sensor GPUs keep their
 * last good telemetry-derived fields. Versions are bumped by step() (see materialKey*), not here.
 */
export function deriveGpus(
  gpus: GpuCurrent[], jobs: Map<string, JobState>, h: HiddenState, topo: Topology, cond: FaultConditions, simMs: number,
): { gpus: GpuCurrent[]; physics: Map<string, GpuPhysics> } {
  const physics = new Map<string, GpuPhysics>();
  const out = gpus.map((prev) => {
    const availability = gpuAvailability(prev.resource_id, h);
    let next: GpuCurrent;
    if (availability === 'unreachable') {
      next = { ...prev, availability, power_w: 0, sm_clock_mhz: 0, clocks_event_reasons: 0 };
    } else {
      const p = gpuPhysics(prev, gpuLoad(prev.resource_id, jobs), h, topo, cond);
      physics.set(prev.resource_id, p);
      next = {
        ...prev,
        availability,
        temp_c: p.temp_c,
        sm_clock_mhz: Math.round(SM_CLOCK_NOMINAL_MHZ * p.clock_factor),
        power_w: p.power_w,
        clocks_event_reasons: (p.throttled ? CLOCKS_EVENT_HW_THERMAL : 0) | (p.capped ? CLOCKS_EVENT_SW_POWER_CAP : 0),
        last_seen_sim_ms: simMs,
      };
      if (cond.stale.has(prev.resource_id)) {
        next = { ...next, temp_c: prev.temp_c, sm_clock_mhz: prev.sm_clock_mhz, power_w: prev.power_w,
          clocks_event_reasons: prev.clocks_event_reasons, last_seen_sim_ms: prev.last_seen_sim_ms };
      }
    }
    return next;
  });
  return { gpus: out, physics };
}

export function deriveNodes(
  nodes: NodeCurrent[], gpus: GpuCurrent[], h: HiddenState, topo: Topology,
): NodeCurrent[] {
  const byId = new Map(gpus.map((g) => [g.resource_id, g]));
  return nodes.map((prev) => {
    const mine = (topo.nodeGpus.get(prev.resource_id) ?? []).map((id) => byId.get(id)!).filter(Boolean);
    const live = mine.filter((g) => g.availability !== 'unreachable');
    const crashed = mine.length > 0 && mine.every((g) => h.gpu_failure[g.resource_id] === 'node_crash');
    const availability: NodeCurrent['availability'] = crashed ? 'unreachable' : 'ready';
    const maxTemp = live.length > 0
      ? Math.max(...live.map((g) => g.temp_c))
      : rackInletC(prev.rack_id, h, topo);
    return {
      ...prev,
      availability,
      power_headroom_w: live.reduce((s, g) => s + (g.power_limit_w - g.power_w), 0),
      thermal_headroom_c: round1(SLOWDOWN_C - maxTemp),
    };
  });
}

export function deriveCooling(cooling: CoolingCurrent[], topo: Topology, cond: FaultConditions): CoolingCurrent[] {
  return cooling.map((prev) => {
    const factor = cond.pumpFactor.get(prev.resource_id) ?? 1;
    const nominalPower = topo.pumpNominalPowerW.get(prev.resource_id) ?? 0;
    const power = factor === 1 ? nominalPower : nominalPower * factor;
    const state = cond.pumpState.get(prev.resource_id) ?? 'normal';
    let next: CoolingCurrent = {
      ...prev,
      operating_state: state,
      pump_power_w: power,
      // estimated from the observed pump power (the planner never sees the fault's severity directly)
      observed_capacity_estimate_w: nominalPower > 0 ? Math.round(prev.nominal_capacity_w * (power / nominalPower)) : null,
    };
    if (cond.stale.has(prev.resource_id)) next = { ...next, pump_power_w: prev.pump_power_w };
    return next;
  });
}

/** Effective cooling capacity of a loop, W. */
export function loopCapacityW(loop: string, topo: Topology, cond: FaultConditions): number {
  return (topo.loopPumps.get(loop) ?? []).reduce((s, p) => {
    const nominal = topo.pumpNominalCapacityW.get(p) ?? 0;
    const f = cond.pumpFactor.get(p) ?? 1;
    return s + (f === 1 ? nominal : nominal * f);
  }, 0);
}

/** Heat into a loop, W: the true electrical power of every reachable GPU in its racks (unreachable GPUs draw 0 W). */
export function loopHeatW(loop: string, gpuIds: string[], physics: Map<string, GpuPhysics>, topo: Topology): number {
  const racks = new Set(topo.loopRacks.get(loop) ?? []);
  let sum = 0;
  for (const id of gpuIds) if (racks.has(topo.gpuRack.get(id) ?? '')) sum += physics.get(id)?.power_w ?? 0;
  return sum;
}

// ---- material-change keys (decision_epoch / resource versions) ------------------------------------
// Only OBSERVABLE, safety-relevant fields count (CONTRACTS §A: per-tick gauge samples don't bump epochs), so the
// public decision_epoch never leaks a hidden fault that has no observable effect yet.

export const gpuMaterialKey = (g: GpuCurrent): string =>
  `${g.availability}|${g.clocks_event_reasons & CLOCKS_EVENT_HW_THERMAL}|${g.power_limit_w}|${g.last_xid_code}`;
export const nodeMaterialKey = (n: NodeCurrent): string => n.availability;
export const coolingMaterialKey = (c: CoolingCurrent): string => c.operating_state;
export const jobMaterialKey = (j: JobState): string =>
  `${j.status}|${j.allocated_gpu_ids.join(',')}|${j.durable_work_units}|${j.latest_checkpoint_id}`;
