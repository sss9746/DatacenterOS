// Fault builders for the harness (pure). SCOPE §3: "delay zero means the next tick", so start_sim_time_ms is
// built from a freshly read sim clock plus one step. Pump 60% loss = severity 0.6, capacity_factor 0.4
// (scenarios.data.ts convention). Xid 79 = severity 1, persistent.

import type { FaultInjection } from '@dcos/contracts';

export const PUMP_A = 'pump-a';
export const LOOP_A = 'loop-a';
/** Racks cooled by loop-a in gpu_demo_8 (fixture header: "loop-a cools racks r2–r4"). */
export const LOOP_A_RACKS = ['rack-r2', 'rack-r3', 'rack-r4'] as const;
export const COOLING_RESOURCE_IDS: readonly string[] = [PUMP_A, LOOP_A, ...LOOP_A_RACKS];

export const DEFAULT_PUMP_LOSS = 0.6;

const V = '1.1.0' as const;

export interface FaultClock {
  sim_time_ms: number;
  step_ms: number;
}

/** Next-tick start: current sim clock + one step (never "now", which the tick may already have passed). */
export const nextTickMs = (clock: FaultClock): number => clock.sim_time_ms + clock.step_ms;

export function pumpDegradation(runId: string, clock: FaultClock, loss = DEFAULT_PUMP_LOSS, tag = 'lr'): FaultInjection {
  if (!(loss > 0 && loss < 1)) throw new Error(`pump loss must be in (0,1), got ${loss}`);
  return {
    schema_version: V,
    fault_id: `${tag}-pump-${clock.sim_time_ms}`,
    run_id: runId,
    target_resource_id: PUMP_A,
    kind: 'cooling_pump_degradation',
    start_sim_time_ms: nextTickMs(clock),
    duration_sim_ms: null,
    severity: loss,
    parameters: { capacity_factor: Number((1 - loss).toFixed(4)) },
    seed_offset: 0,
  };
}

/** Xid 79 on `gpuId`. `startSimMs` defaults to the next tick; L5 passes the checkpoint's due tick. */
export function xid79(runId: string, gpuId: string, clock: FaultClock, startSimMs?: number, tag = 'lr'): FaultInjection {
  const start = startSimMs ?? nextTickMs(clock);
  if (start < clock.sim_time_ms) throw new Error(`xid79 start ${start} is in the past (sim now ${clock.sim_time_ms})`);
  return {
    schema_version: V,
    fault_id: `${tag}-xid79-${gpuId}-${start}`,
    run_id: runId,
    target_resource_id: gpuId,
    kind: 'gpu_xid_79',
    start_sim_time_ms: start,
    duration_sim_ms: null,
    severity: 1,
    parameters: {},
    seed_offset: 0,
  };
}

/**
 * Finite `node_crash` on `nodeId`, for Scene B. The caller gives every node the same future `startSimMs`. The
 * schedule lives only in this private fault row: when the node is back is never told to the agent.
 */
export function nodeCrash(runId: string, nodeId: string, clock: FaultClock, startSimMs: number, durationSimMs: number, tag = 'lr'): FaultInjection {
  if (startSimMs <= clock.sim_time_ms) throw new Error(`nodeCrash start ${startSimMs} must be in the future (sim now ${clock.sim_time_ms})`);
  if (!Number.isFinite(durationSimMs) || durationSimMs <= 0) throw new Error(`nodeCrash duration must be a positive number of sim-ms, got ${durationSimMs}`);
  return {
    schema_version: V,
    fault_id: `${tag}-node-crash-${nodeId}-${startSimMs}`,
    run_id: runId,
    target_resource_id: nodeId,
    kind: 'node_crash',
    start_sim_time_ms: startSimMs,
    duration_sim_ms: durationSimMs,
    severity: 1,
    parameters: {},
    seed_offset: 0,
  };
}

/** The simulated nodes: `inject_fault` refuses to target hardware-backed resources such as node-real-0. */
export function simulatedNodeIds(resources: readonly { resource_id: string; kind: string; config: Record<string, unknown> }[]): string[] {
  return resources.filter((r) => r.kind === 'node' && r.config.hardware_backed !== true).map((r) => r.resource_id);
}

/** Node hosting a demo GPU id (`gpu-r7-n1-3` -> `node-r7-n1`); null for unknown shapes. */
export const nodeOfGpu = (gpuId: string): string | null => {
  const m = /^gpu-(r\d+-n\d+)-\d+$/.exec(gpuId);
  return m ? `node-${m[1]}` : null;
};

/** Rack of a demo GPU id (`gpu-r7-n1-3` -> `rack-r7`). */
export const rackOfGpu = (gpuId: string): string | null => {
  const m = /^gpu-(r\d+)-n\d+-\d+$/.exec(gpuId);
  return m ? `rack-${m[1]}` : null;
};

/**
 * L5 timing guard: scheduling a fault exactly on `dueSimMs` only makes sense if the clock has not passed it
 * and there is at least `minLeadSteps` of lead time for the reducer call to land. Returns a reason or null.
 */
export function dueTickTooLate(clock: FaultClock, dueSimMs: number, minLeadSteps = 2): string | null {
  if (dueSimMs <= clock.sim_time_ms) return `checkpoint due tick ${dueSimMs} already passed (sim now ${clock.sim_time_ms})`;
  if (dueSimMs - clock.sim_time_ms < minLeadSteps * clock.step_ms) return `only ${dueSimMs - clock.sim_time_ms} sim-ms until due tick ${dueSimMs}; need ${minLeadSteps * clock.step_ms}`;
  return null;
}
