// Fault application. Faults due by the end of the tick apply FIRST (before command completions revalidate), per
// ARCHITECTURE §3 "Delayed-operation ordering". Cooling / thermal / storage / stale-sensor effects are derived every
// tick from world.active_faults_private (world.ts faultConditions); GPU hardware failures (XIDs, node crash) latch
// into hidden.gpu_failure because hardware does not heal when a fault's duration ends.
import type { FaultInjection, PhysicsWorld } from '@dcos/contracts';
import { cloneJson, type GpuFailure, type HiddenState, type Topology } from './world.js';
import type { TickCtx } from './jobs.js';

const XID_FAILURE: Partial<Record<FaultInjection['kind'], { failure: GpuFailure; code: number }>> = {
  gpu_xid_79: { failure: 'xid_79', code: 79 },
  gpu_xid_48: { failure: 'xid_48', code: 48 },
  gpu_xid_74: { failure: 'xid_74', code: 74 },
};

/** Severity order of latched failures: a GPU keeps its worst one. */
const FAILURE_RANK: Record<GpuFailure, number> = { xid_74: 1, xid_48: 2, node_crash: 3, thermal_shutdown: 4, xid_79: 5 };

export function latchFailure(h: HiddenState, gpuId: string, failure: GpuFailure): boolean {
  const prev = h.gpu_failure[gpuId];
  if (prev && FAILURE_RANK[prev] >= FAILURE_RANK[failure]) return false;
  h.gpu_failure[gpuId] = failure;
  return true;
}

/** Remove faults whose duration has ended by t1 (start + duration ≤ t1). A node_crash on a node ends with a reboot. */
export function expireFaults(world: PhysicsWorld, h: HiddenState, topo: Topology, ctx: TickCtx): void {
  const keep: FaultInjection[] = [];
  for (const f of world.active_faults_private) {
    const ended = f.duration_sim_ms !== null && f.start_sim_time_ms + f.duration_sim_ms <= ctx.t1;
    if (!ended) {
      keep.push(f);
      continue;
    }
    if (f.kind === 'node_crash') {
      for (const g of topo.nodeGpus.get(f.target_resource_id) ?? []) {
        if (h.gpu_failure[g] === 'node_crash') delete h.gpu_failure[g];
      }
    }
    ctx.signals.push({ kind: 'fault_cleared', fault: f });
  }
  world.active_faults_private = keep;
}

/**
 * Apply every due fault with start_sim_time_ms ≤ t1 that is not already active (dedupe by fault_id). A fault with a
 * later start is ignored on this tick: the caller passes it again on the tick that reaches its start time.
 */
export function applyDueFaults(
  world: PhysicsWorld, h: HiddenState, topo: Topology, ctx: TickCtx, due: FaultInjection[],
): void {
  const active = new Set(world.active_faults_private.map((f) => f.fault_id));
  const ordered = [...due].sort((a, b) =>
    a.start_sim_time_ms - b.start_sim_time_ms || (a.fault_id < b.fault_id ? -1 : a.fault_id > b.fault_id ? 1 : 0));
  for (const f of ordered) {
    if (f.start_sim_time_ms > ctx.t1 || active.has(f.fault_id)) continue;
    active.add(f.fault_id);
    world.active_faults_private.push(cloneJson(f));
    const xid = XID_FAILURE[f.kind];
    if (xid) {
      const gpu = world.observable.gpus.find((g) => g.resource_id === f.target_resource_id);
      if (!gpu) continue; // inject_fault validates targets; an unknown GPU is a no-op here
      latchFailure(h, gpu.resource_id, xid.failure);
      gpu.last_xid_code = xid.code;
    } else if (f.kind === 'node_crash') {
      for (const g of topo.nodeGpus.get(f.target_resource_id) ?? []) latchFailure(h, g, 'node_crash');
    }
    ctx.signals.push({ kind: 'fault_applied', fault: f });
  }
}
