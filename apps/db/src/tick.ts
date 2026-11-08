// advance_tick: scheduled once per wall second per run by `tick_schedule` (rows inserted by
// create_run). Runs `run.speed` logical steps of `step_ms`; skips while paused. The interval
// schedule doesn't replay missed seconds.
//
// Order inside one tick (LANE-P2 design): faults due → physics step (which also completes due
// commands and bumps decision_epoch on material_change) → ledger updates (P2-5 plugs in here) →
// commit (world_state, projection, telemetry, signals).
import type { SignalEvent, TelemetryEvent } from '@dcos/contracts';
import { step } from '@dcos/physics';
import spacetimedb, { tick_schedule, type Ctx } from './schema';
import { reject } from './auth';
import { loadWorld, saveWorld } from './run';
import { pendingFaults, takeDueFaults } from './faults';
import { projectWorld } from './projection';

/** CONTRACTS §0.8: keep at most 2,000 telemetry rows. */
export const TELEMETRY_MAX_ROWS = 2000;

function appendTelemetry(ctx: Ctx, events: TelemetryEvent[], nowMs: number): number {
  let n = 0;
  for (const e of events) {
    if (ctx.db.telemetry_recent.event_id.find(e.event_id)) continue;
    ctx.db.telemetry_recent.insert({
      event_id: e.event_id,
      run_id: e.run_id,
      resource_id: e.resource_id,
      source_kind: e.source_kind,
      source_id: e.source_id,
      source_seq: e.source_seq,
      metric: e.metric,
      value: e.value,
      unit: e.unit,
      quality: e.quality,
      sim_time_ms: e.sim_time_ms,
      observed_unix_ms: e.observed_unix_ms || nowMs,
      labels_json: JSON.stringify(e.labels),
    });
    n++;
  }
  return n;
}

export function appendSignals(ctx: Ctx, events: SignalEvent[], nowMs: number): number {
  let n = 0;
  for (const s of events) {
    if (ctx.db.signal_event.event_id.find(s.event_id)) continue;
    ctx.db.signal_event.insert({
      event_id: s.event_id,
      run_id: s.run_id,
      resource_id: s.resource_id,
      event_type: s.event_type,
      xid_code: s.xid_code === null ? undefined : s.xid_code,
      severity: s.severity,
      source_kind: s.source_kind,
      source_id: s.source_id,
      source_seq: s.source_seq,
      sim_time_ms: s.sim_time_ms,
      observed_unix_ms: s.observed_unix_ms || nowMs,
      message: s.message,
      evidence_json: JSON.stringify(s.evidence),
    });
    n++;
  }
  return n;
}

/** Delete the oldest rows (by sim time, then source_seq) beyond TELEMETRY_MAX_ROWS. */
export function trimTelemetry(ctx: Ctx): number {
  const excess = Number(ctx.db.telemetry_recent.count()) - TELEMETRY_MAX_ROWS;
  if (excess <= 0) return 0;
  const oldest = [...ctx.db.telemetry_recent.iter()]
    .sort(
      (a, b) =>
        a.sim_time_ms - b.sim_time_ms ||
        a.source_seq - b.source_seq ||
        (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0)
    )
    .slice(0, excess);
  for (const r of oldest) ctx.db.telemetry_recent.event_id.delete(r.event_id);
  return oldest.length;
}

export const advance_tick = spacetimedb.reducer(
  { onSchedule: tick_schedule },
  { arg: tick_schedule.rowType },
  (ctx, { arg }) => {
    if (!ctx.senderAuth.isInternal) reject('UNAUTHORIZED', 'advance_tick is run by the scheduler only');

    const run = ctx.db.run.run_id.find(arg.run_id);
    if (!run) {
      ctx.db.tick_schedule.scheduled_id.delete(arg.scheduled_id); // orphaned schedule
      return;
    }
    if (run.paused) return;

    const nowMs = Number(ctx.timestamp.toMillis());
    let world = loadWorld(ctx, run.run_id);
    let telemetry: TelemetryEvent[] = [];
    const signals: SignalEvent[] = [];
    const pending = pendingFaults(ctx, run.run_id); // one scan per tick, not per step

    for (let i = 0; i < Math.max(1, run.speed); i++) {
      const stepMs = world.observable.clock.step_ms;
      const due = takeDueFaults(ctx, pending, world.observable.clock.sim_time_ms + stepMs);
      const result = step({
        schema_version: '1.1.0',
        run_id: run.run_id,
        step_ms: stepMs,
        seed: run.seed,
        world,
        due_faults_private: due,
        requested_action_ids: [], // P2-5: running actions' ids
      });
      world = result.world_after; // step bumps decision_epoch itself on material_change
      telemetry = result.telemetry; // only the last step's samples: ≤ 1 per metric per GPU per wall second
      signals.push(...result.signals); // every signal is kept
      // P2-5: result.completed_command_keys / failed_command_keys → action ledger (revalidated).
    }

    saveWorld(ctx, world);
    projectWorld(ctx, world);
    appendTelemetry(ctx, telemetry, nowMs);
    appendSignals(ctx, signals, nowMs);
    trimTelemetry(ctx);
  }
);
