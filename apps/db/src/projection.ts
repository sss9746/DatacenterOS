// projectWorld(ctx, world): copy the observable part of the private PhysicsWorld into the public
// current-state tables. Used by create_run (P2-3) and every advance_tick (P2-4).
//
// Only `world.observable` (an ObservedSnapshot) is read, so private faults and hidden physics state
// can't leak. Rows are upserted and only rewritten when they changed (keeps subscription traffic to
// real changes). For full-set tables (topology, current state, allocations) rows of this run that
// are no longer in the world are deleted; checkpoints are history and are only upserted.
//
// Telemetry and signals aren't part of the snapshot; the tick appends them (P2-4).
import type { ObservedSnapshot, PhysicsWorld } from '@dcos/contracts';
import { toObserved } from '@dcos/physics';
import type { Ctx } from './schema';

type PkIndex<K, R> = { find(key: K): R | null; update(row: R): R; delete(key: K): boolean };
type Tbl<R> = { insert(row: R): R; iter(): Iterable<R> };

/** Field-wise equality, independent of key order (rows have no bigint columns here). */
function same<R extends object>(a: R, b: R): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (JSON.stringify((a as Record<string, unknown>)[k]) !== JSON.stringify((b as Record<string, unknown>)[k])) {
      return false;
    }
  }
  return true;
}
const nn = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

/** Upsert `rows` keyed by `keyOf`; when `prune`, delete this run's rows not in `rows`. Returns #writes. */
function sync<R extends { run_id: string }>(
  table: Tbl<R>,
  pk: PkIndex<string, R>,
  keyOf: (r: R) => string,
  runId: string,
  rows: R[],
  prune: boolean,
  retain?: (row: R) => boolean
): number {
  let writes = 0;
  const keep = new Set<string>();
  for (const row of rows) {
    const key = keyOf(row);
    keep.add(key);
    const existing = pk.find(key);
    if (existing && existing.run_id !== runId) {
      throw new Error(`projectWorld: ${key} belongs to run ${existing.run_id}, not ${runId}`);
    }
    if (!existing) {
      table.insert(row);
      writes++;
    } else if (!same(existing, row)) {
      pk.update(row);
      writes++;
    }
  }
  if (prune) {
    const stale = [...table.iter()].filter((r) => r.run_id === runId && !keep.has(keyOf(r)) && !retain?.(r));
    for (const r of stale) {
      pk.delete(keyOf(r));
      writes++;
    }
  }
  return writes;
}

/** `resource.current_status` / `version` come from the matching current-state row, if any. */
function resourceStatus(obs: ObservedSnapshot): Map<string, { status: string; version: number }> {
  const m = new Map<string, { status: string; version: number }>();
  for (const g of obs.gpus) m.set(g.resource_id, { status: g.availability, version: g.version });
  for (const n of obs.nodes) m.set(n.resource_id, { status: n.availability, version: n.version });
  for (const c of obs.cooling) m.set(c.resource_id, { status: c.operating_state, version: c.version });
  return m;
}

export function projectWorld(ctx: Ctx, world: PhysicsWorld): number {
  const obs = toObserved(world); // strips any private key (defense in depth)
  const runId = world.run_id;
  const db = ctx.db;
  let writes = 0;

  // run: clock fields only; seed/status/speed/profile_version are owned by run.ts.
  const runRow = db.run.run_id.find(runId);
  if (runRow) {
    const c = obs.clock;
    const next = {
      ...runRow,
      sim_time_ms: c.sim_time_ms,
      tick_index: c.tick_index,
      step_ms: c.step_ms,
      wall_tick_ms: c.wall_tick_ms,
      decision_epoch: c.decision_epoch,
      paused: c.paused,
    };
    if (!same(runRow, next)) {
      db.run.run_id.update(next);
      writes++;
    }
  }

  const status = resourceStatus(obs);
  writes += sync(
    db.resource,
    db.resource.resource_id,
    (r) => r.resource_id,
    runId,
    obs.resources.map((r) => {
      const prev = db.resource.resource_id.find(r.resource_id);
      const s = status.get(r.resource_id);
      return {
        resource_id: r.resource_id,
        run_id: runId,
        kind: r.kind,
        parent_id: nn(r.parent_id),
        failure_domain_id: r.failure_domain_id,
        profile: r.profile,
        config_json: JSON.stringify(r.config),
        current_status: s?.status ?? (r.enabled ? 'ok' : 'disabled'),
        version: s?.version ?? prev?.version ?? 0,
        enabled: r.enabled,
      };
    }),
    true
  );

  writes += sync(
    db.dependency_edge,
    db.dependency_edge.edge_id,
    (r) => r.edge_id,
    runId,
    obs.dependencies.map((d) => ({
      edge_id: d.edge_id,
      run_id: runId,
      consumer_id: d.consumer_id,
      provider_id: d.provider_id,
      relation: d.relation,
      weight: d.weight,
    })),
    true
  );

  writes += sync(
    db.gpu_current,
    db.gpu_current.resource_id,
    (r) => r.resource_id,
    runId,
    obs.gpus.map((g) => ({
      resource_id: g.resource_id,
      run_id: runId,
      node_id: g.node_id,
      availability: g.availability,
      temp_c: g.temp_c,
      sm_clock_mhz: g.sm_clock_mhz,
      power_w: g.power_w,
      power_limit_w: g.power_limit_w,
      clocks_event_reasons: g.clocks_event_reasons,
      last_xid_code: nn(g.last_xid_code),
      last_seen_sim_ms: g.last_seen_sim_ms,
      version: g.version,
    })),
    true,
    (r) => r.resource_id === 'gpu-real-0' // owned by ingest_observations; physics never models it
  );

  writes += sync(
    db.node_current,
    db.node_current.resource_id,
    (r) => r.resource_id,
    runId,
    obs.nodes.map((n) => ({
      resource_id: n.resource_id,
      run_id: runId,
      rack_id: n.rack_id,
      availability: n.availability,
      power_headroom_w: n.power_headroom_w,
      thermal_headroom_c: n.thermal_headroom_c,
      version: n.version,
    })),
    true
  );

  writes += sync(
    db.cooling_current,
    db.cooling_current.resource_id,
    (r) => r.resource_id,
    runId,
    obs.cooling.map((c) => ({
      resource_id: c.resource_id,
      run_id: runId,
      operating_state: c.operating_state,
      nominal_capacity_w: c.nominal_capacity_w,
      pump_power_w: c.pump_power_w,
      observed_capacity_estimate_w: nn(c.observed_capacity_estimate_w),
      version: c.version,
    })),
    true
  );

  writes += sync(
    db.job_spec,
    db.job_spec.job_id,
    (r) => r.job_id,
    runId,
    obs.job_specs.map((s) => ({
      job_id: s.job_id,
      run_id: runId,
      gpus_required: s.gpus_required,
      placement_policy: s.placement_policy,
      compatible_node_ids_json: JSON.stringify(s.compatible_node_ids),
      gpu_profile: s.gpu_profile,
      priority: s.priority,
      preemptible: s.preemptible,
      checkpoint_supported: s.checkpoint_supported,
      checkpoint_storage_id: nn(s.checkpoint_storage_id),
      checkpoint_duration_ms: s.checkpoint_duration_ms,
      restart_duration_ms: s.restart_duration_ms,
      checkpoint_interval_ms: s.checkpoint_interval_ms,
      total_work_units: s.total_work_units,
      work_rate_per_gpu_per_sim_s: s.work_rate_per_gpu_per_sim_s,
    })),
    true
  );

  writes += sync(
    db.job_current,
    db.job_current.job_id,
    (r) => r.job_id,
    runId,
    obs.job_states.map((j) => ({
      job_id: j.job_id,
      run_id: runId,
      status: j.status,
      progress_work_units: j.progress_work_units,
      durable_work_units: j.durable_work_units,
      latest_checkpoint_id: nn(j.latest_checkpoint_id),
      last_update_sim_time_ms: j.last_update_sim_time_ms,
      version: j.version,
    })),
    true
  );

  writes += sync(
    db.job_gpu_allocation,
    db.job_gpu_allocation.allocation_id,
    (r) => r.allocation_id,
    runId,
    obs.allocations.map((a) => ({
      allocation_id: `${a.job_id}/${a.gpu_id}`,
      run_id: runId,
      job_id: a.job_id,
      gpu_id: a.gpu_id,
      since_sim_time_ms: a.since_sim_time_ms,
    })),
    true
  );

  writes += sync(
    db.checkpoint,
    db.checkpoint.checkpoint_id,
    (r) => r.checkpoint_id,
    runId,
    obs.checkpoints.map((c) => ({
      checkpoint_id: c.checkpoint_id,
      run_id: runId,
      job_id: c.job_id,
      storage_resource_id: c.storage_resource_id,
      status: c.status,
      progress_work_units: c.progress_work_units,
      command_key: c.command_key,
      requested_sim_time_ms: c.requested_sim_time_ms,
      complete_sim_time_ms: nn(c.complete_sim_time_ms),
      accessible: c.accessible,
    })),
    false
  );

  return writes;
}
