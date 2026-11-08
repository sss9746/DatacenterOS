// Run lifecycle reducers (admin only, CONTRACTS §0.9): create_run, pause_run, configure_run.
//
// create_run builds the world from physics, stores it in private `world_state`, and projects it
// into the public tables. Calling it again for an existing run_id RESETS that run: every row
// scoped to the run (incl. actions, incidents, telemetry, faults) is deleted first.
import { t } from 'spacetimedb/server';
import { validatePayload, type PhysicsWorld } from '@dcos/contracts';
import spacetimedb, { type Ctx } from './schema';
import { reject, requireRole } from './auth';
import { projectWorld } from './projection';
import { buildPresetStandIn, PRESET_IDS, type PresetId } from './preset';

/** Mirrors db-client `RunConfig`. `speed` is also stored on `run.speed`. */
export interface RunConfig {
  speed?: number;
  fan_drives_loop_a?: boolean;
}

const DEFAULT_CONFIG: Required<RunConfig> = { speed: 1, fan_drives_loop_a: false };

// ---------------------------------------------------------------------------------------------
// world_state helpers (also used by the tick in P2-4)
// ---------------------------------------------------------------------------------------------

export function loadWorld(ctx: Ctx, runId: string): PhysicsWorld {
  const row = ctx.db.world_state.run_id.find(runId);
  if (!row) reject('NOT_FOUND', `run ${runId} does not exist`);
  return JSON.parse(row.world_json) as PhysicsWorld;
}

export function saveWorld(ctx: Ctx, world: PhysicsWorld): void {
  const row = ctx.db.world_state.run_id.find(world.run_id);
  if (!row) reject('NOT_FOUND', `run ${world.run_id} does not exist`);
  ctx.db.world_state.run_id.update({ ...row, world_json: JSON.stringify(world), version: row.version + 1 });
}

export function loadConfig(ctx: Ctx, runId: string): Required<RunConfig> {
  const row = ctx.db.world_state.run_id.find(runId);
  if (!row) reject('NOT_FOUND', `run ${runId} does not exist`);
  return { ...DEFAULT_CONFIG, ...(JSON.parse(row.config_json) as RunConfig) };
}

function requireId(field: string, value: string): void {
  const v = validatePayload('Identifier', value);
  if (!v.ok) reject('INVALID_PAYLOAD', `${field}: ${v.errors.join('; ')}`);
}

// ---------------------------------------------------------------------------------------------
// Reset: delete every row scoped to a run
// ---------------------------------------------------------------------------------------------

type RunScoped<R> = { iter(): Iterable<R>; delete(row: R): boolean };

function wipe<R extends { run_id: string }>(table: RunScoped<R>, runId: string): number {
  const rows = [...table.iter()].filter((r) => r.run_id === runId);
  for (const r of rows) table.delete(r);
  return rows.length;
}

function clearRun(ctx: Ctx, runId: string): number {
  const db = ctx.db;
  return (
    wipe(db.resource, runId) +
    wipe(db.dependency_edge, runId) +
    wipe(db.gpu_current, runId) +
    wipe(db.node_current, runId) +
    wipe(db.cooling_current, runId) +
    wipe(db.job_spec, runId) +
    wipe(db.job_current, runId) +
    wipe(db.job_gpu_allocation, runId) +
    wipe(db.checkpoint, runId) +
    wipe(db.telemetry_recent, runId) +
    wipe(db.signal_event, runId) +
    wipe(db.symptom, runId) +
    wipe(db.incident, runId) +
    wipe(db.incident_symptom, runId) +
    wipe(db.incident_resource, runId) +
    wipe(db.workflow, runId) +
    wipe(db.workflow_incident, runId) +
    wipe(db.plan, runId) +
    wipe(db.action, runId) +
    wipe(db.action_dependency, runId) +
    wipe(db.action_event, runId) +
    wipe(db.resource_lease, runId) +
    wipe(db.agent_event, runId) +
    wipe(db.evaluation_result, runId) +
    wipe(db.fault_injection_truth, runId) +
    wipe(db.tick_schedule, runId) +
    wipe(db.world_state, runId) +
    wipe(db.run, runId)
  );
}

// ---------------------------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------------------------

export const create_run = spacetimedb.reducer(
  { run_id: t.string(), seed: t.u32(), preset_id: t.string() },
  (ctx, { run_id, seed, preset_id }) => {
    requireRole(ctx, 'admin');
    requireId('run_id', run_id);
    if (!(PRESET_IDS as readonly string[]).includes(preset_id)) {
      reject('INVALID_PAYLOAD', `preset_id must be one of ${PRESET_IDS.join(', ')}`);
    }

    // Resource IDs are frozen and global (CONTRACTS §0.3), so one database holds one run.
    for (const other of ctx.db.run.iter()) {
      if (other.run_id !== run_id) {
        reject('INVALID_TRANSITION', `run ${other.run_id} already exists; one run per database (call create_run with that id to reset it)`);
      }
    }
    const cleared = ctx.db.run.run_id.find(run_id) ? clearRun(ctx, run_id) : 0;

    // TODO(P1-3): swap for `buildPreset(preset_id, run_id, seed)` from @dcos/physics.
    const world = buildPresetStandIn(preset_id as PresetId, run_id, seed);
    const v = validatePayload('PhysicsWorld', world);
    if (!v.ok) throw new Error(`buildPreset produced an invalid PhysicsWorld: ${v.errors.slice(0, 5).join('; ')}`);

    const c = world.observable.clock;
    ctx.db.world_state.insert({
      run_id,
      preset_id,
      seed,
      world_json: JSON.stringify(world),
      version: 1,
      config_json: JSON.stringify(DEFAULT_CONFIG),
    });
    ctx.db.run.insert({
      run_id,
      seed,
      status: 'running',
      sim_time_ms: c.sim_time_ms,
      tick_index: c.tick_index,
      step_ms: c.step_ms,
      wall_tick_ms: c.wall_tick_ms,
      decision_epoch: c.decision_epoch,
      paused: c.paused,
      speed: DEFAULT_CONFIG.speed,
      profile_version: `${preset_id}@p2-standin`,
    });
    const writes = projectWorld(ctx, world);
    console.info(
      `create_run ${run_id} seed=${seed} preset=${preset_id}: ${cleared ? `reset (${cleared} rows cleared), ` : ''}${writes} public rows`
    );
  }
);

export const pause_run = spacetimedb.reducer(
  { run_id: t.string(), paused: t.bool() },
  (ctx, { run_id, paused }) => {
    requireRole(ctx, 'admin');
    const run = ctx.db.run.run_id.find(run_id);
    if (!run) reject('NOT_FOUND', `run ${run_id} does not exist`);
    if (run.paused === paused) return;
    const world = loadWorld(ctx, run_id);
    world.observable.clock.paused = paused;
    saveWorld(ctx, world);
    ctx.db.run.run_id.update({ ...run, paused, status: paused ? 'paused' : 'running' });
  }
);

/** configure_run(run_id, config_json): `{ speed?: 1..5, fan_drives_loop_a?: boolean }`, merged into the current config. */
export const configure_run = spacetimedb.reducer(
  { run_id: t.string(), config_json: t.string() },
  (ctx, { run_id, config_json }) => {
    requireRole(ctx, 'admin');
    const run = ctx.db.run.run_id.find(run_id);
    if (!run) reject('NOT_FOUND', `run ${run_id} does not exist`);

    let patch: unknown;
    try {
      patch = JSON.parse(config_json);
    } catch {
      reject('INVALID_PAYLOAD', 'config_json is not valid JSON');
    }
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      reject('INVALID_PAYLOAD', 'config_json must be a JSON object');
    }
    const p = patch as Record<string, unknown>;
    for (const k of Object.keys(p)) {
      if (!(k in DEFAULT_CONFIG)) reject('INVALID_PAYLOAD', `unknown config key ${k}`);
    }
    if ('speed' in p && !(Number.isInteger(p.speed) && (p.speed as number) >= 1 && (p.speed as number) <= 5)) {
      reject('INVALID_PAYLOAD', 'speed must be an integer 1..5');
    }
    if ('fan_drives_loop_a' in p && typeof p.fan_drives_loop_a !== 'boolean') {
      reject('INVALID_PAYLOAD', 'fan_drives_loop_a must be a boolean');
    }

    const next: Required<RunConfig> = { ...loadConfig(ctx, run_id), ...(p as RunConfig) };
    const ws = ctx.db.world_state.run_id.find(run_id)!;
    ctx.db.world_state.run_id.update({ ...ws, config_json: JSON.stringify(next) });
    if (next.speed !== run.speed) ctx.db.run.run_id.update({ ...run, speed: next.speed });
  }
);
