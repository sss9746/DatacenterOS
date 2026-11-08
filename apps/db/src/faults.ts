// inject_fault(fault_json): admin. Validates a FaultInjection and queues it in private
// `fault_injection_truth`. That table IS the due-fault queue: advance_tick takes undelivered rows
// whose start time falls inside the step it is running and passes them to physics as
// `SimulationTickInput.due_faults_private` (rows then get `active = true`, meaning "delivered").
// Keeping the queue there avoids adding non-contract fields to PhysicsWorld.
import { t } from 'spacetimedb/server';
import { validatePayload, type FaultInjection, type ResourceSpec } from '@dcos/contracts';
import spacetimedb, { type Ctx } from './schema';
import { reject, requireRole } from './auth';
import { loadWorld } from './run';

type FaultKind = FaultInjection['kind'];
type ResourceKind = ResourceSpec['kind'];

/** Which resource kinds each fault may target (kit §C invariant; §0.12 #7 for storage outages). */
const TARGET_KINDS: Record<FaultKind, readonly ResourceKind[]> = {
  cooling_pump_degradation: ['cooling_pump'],
  cooling_pump_outage: ['cooling_pump'],
  gpu_thermal_load: ['gpu'],
  gpu_xid_48: ['gpu'],
  gpu_xid_79: ['gpu'],
  gpu_xid_74: ['gpu'],
  network_link_down: ['network_link', 'checkpoint_store'],
  node_crash: ['node', 'checkpoint_store'],
  sensor_stale: ['gpu', 'node', 'rack', 'cooling_pump', 'cooling_loop', 'fan_sensor'],
};

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

type FaultRow = ReturnType<Ctx['db']['fault_injection_truth']['iter']> extends Iterable<infer R> ? R : never;

/** Undelivered faults of `runId`, oldest first. Load once per tick, then `takeDueFaults` per step. */
export function pendingFaults(ctx: Ctx, runId: string): FaultRow[] {
  return [...ctx.db.fault_injection_truth.iter()]
    .filter((f) => f.run_id === runId && !f.active)
    .sort((a, b) => a.start_sim_time_ms - b.start_sim_time_ms || (a.fault_id < b.fault_id ? -1 : 1));
}

/** Removes from `pending` (sorted) every fault starting at or before `uptoSimMs`, marks it delivered. */
export function takeDueFaults(ctx: Ctx, pending: FaultRow[], uptoSimMs: number): FaultInjection[] {
  const due: FaultInjection[] = [];
  while (pending.length > 0 && pending[0]!.start_sim_time_ms <= uptoSimMs) {
    const f = pending.shift()!;
    ctx.db.fault_injection_truth.fault_id.update({ ...f, active: true });
    due.push(JSON.parse(f.fault_json) as FaultInjection);
  }
  return due;
}

export const inject_fault = spacetimedb.reducer({ fault_json: t.string() }, (ctx, { fault_json }) => {
  requireRole(ctx, 'admin');

  let fault: unknown;
  try {
    fault = JSON.parse(fault_json);
  } catch {
    reject('INVALID_PAYLOAD', 'fault_json is not valid JSON');
  }
  const v = validatePayload('FaultInjection', fault);
  if (!v.ok) reject('INVALID_PAYLOAD', `FaultInjection: ${v.errors.slice(0, 5).join('; ')}`);
  const f = fault as FaultInjection;

  if (!ctx.db.run.run_id.find(f.run_id)) reject('NOT_FOUND', `run ${f.run_id} does not exist`);

  // Same fault_id: identical payload is a no-op retry; a different one is rejected.
  const existing = ctx.db.fault_injection_truth.fault_id.find(f.fault_id);
  if (existing) {
    if (stableStringify(JSON.parse(existing.fault_json)) === stableStringify(f)) return;
    reject('INVALID_PAYLOAD', `fault_id ${f.fault_id} already used with a different payload`);
  }

  const world = loadWorld(ctx, f.run_id);
  const target = world.observable.resources.find((r) => r.resource_id === f.target_resource_id);
  if (!target) reject('NOT_FOUND', `target ${f.target_resource_id} does not exist`);
  const allowed = TARGET_KINDS[f.kind];
  if (!allowed.includes(target.kind)) {
    reject('INVALID_PAYLOAD', `${f.kind} can't target a ${target.kind} (allowed: ${allowed.join(', ')})`);
  }
  // Never fake failures on real hardware (kit §A source attribution).
  if (target.profile === 'brev_real' || target.config['hardware_backed'] === true) {
    reject('INVALID_PAYLOAD', `${f.target_resource_id} is real hardware; simulated faults can't target it`);
  }

  ctx.db.fault_injection_truth.insert({
    fault_id: f.fault_id,
    run_id: f.run_id,
    target_resource_id: f.target_resource_id,
    kind: f.kind,
    start_sim_time_ms: f.start_sim_time_ms,
    fault_json: JSON.stringify(f),
    active: false,
  });
  const now = world.observable.clock.sim_time_ms;
  console.info(
    `inject_fault ${f.kind} on ${f.target_resource_id} at ${f.start_sim_time_ms}` +
      (f.start_sim_time_ms < now ? ` (in the past; applies on the next tick at ${now})` : '')
  );
});
