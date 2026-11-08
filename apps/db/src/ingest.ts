// ingest_observations(batch_json) (P2-9 / G3): real nvidia-smi telemetry for gpu-real-0.
//
// Gateway role only; admin is refused too, unlike requireRole. A batch is all-or-nothing: any bad
// event throws and the whole reducer rolls back. `source_cursor` holds the last source_seq per
// source, so retransmits stay rejected after their rows age out of telemetry_recent.
//
// Observation only. Replay events reach telemetry but never gpu_current, and the physics, safety and
// allocation paths read the private world, where this GPU does not exist.
import { t } from 'spacetimedb/server';
import { validatePayload, type TelemetryEvent } from '@dcos/contracts';
import spacetimedb, { type Ctx } from './schema';
import { reject, roleOf } from './auth';
import { trimTelemetry } from './tick';

export const MAX_INGEST_EVENTS = 20;
const REAL_GPU_ID = 'gpu-real-0';
const REAL_NODE_ID = 'node-real-0';
const INGEST_SOURCE_KINDS: readonly string[] = ['hardware', 'replay'];

type GpuRow = NonNullable<ReturnType<Ctx['db']['gpu_current']['resource_id']['find']>>;

/** Applies one hardware metric to the row; a metric not listed here changes nothing. */
function applyMetric(row: GpuRow, metric: string, value: number): void {
  switch (metric) {
    case 'nvidia_smi.temperature_gpu': row.temp_c = value; break;
    case 'nvidia_smi.power_draw': row.power_w = value; break;
    case 'nvidia_smi.clocks_sm': row.sm_clock_mhz = value; break;
    case 'nvidia_smi.power_limit': row.power_limit_w = value; break;
    case 'nvidia_smi.clocks_event_reasons': row.clocks_event_reasons = value >>> 0; break;
  }
}

export const ingest_observations = spacetimedb.reducer({ batch_json: t.string() }, (ctx, { batch_json }) => {
  if (roleOf(ctx) !== 'gateway') reject('UNAUTHORIZED', 'ingest_observations is gateway-only');

  let batch: unknown;
  try {
    batch = JSON.parse(batch_json);
  } catch {
    reject('INVALID_PAYLOAD', 'batch_json is not valid JSON');
  }
  if (!Array.isArray(batch)) reject('INVALID_PAYLOAD', 'batch_json must be an array');
  if (batch.length > MAX_INGEST_EVENTS) reject('INVALID_PAYLOAD', `at most ${MAX_INGEST_EVENTS} events per call, got ${batch.length}`);

  // Check everything before the first write.
  const events: TelemetryEvent[] = [];
  const ids = new Set<string>();
  const cursors = new Map<string, number>();
  for (const raw of batch) {
    const v = validatePayload('TelemetryEvent', raw);
    if (!v.ok) reject('INVALID_PAYLOAD', `TelemetryEvent: ${v.errors.slice(0, 5).join('; ')}`);
    const ev = raw as TelemetryEvent;
    if (ev.resource_id !== REAL_GPU_ID) reject('INVALID_PAYLOAD', `only ${REAL_GPU_ID} is accepted, got ${ev.resource_id}`);
    if (!INGEST_SOURCE_KINDS.includes(ev.source_kind)) reject('INVALID_PAYLOAD', `source_kind ${ev.source_kind} is not accepted`);
    if (ids.has(ev.event_id) || ctx.db.telemetry_recent.event_id.find(ev.event_id)) reject('INVALID_PAYLOAD', `duplicate event_id ${ev.event_id}`);
    const last = cursors.get(ev.source_id) ?? ctx.db.source_cursor.source_id.find(ev.source_id)?.last_seq ?? -1;
    if (ev.source_seq <= last) reject('INVALID_PAYLOAD', `non-monotonic source_seq ${ev.source_seq} for ${ev.source_id}`);
    if (!ctx.db.run.run_id.find(ev.run_id)) reject('NOT_FOUND', `run ${ev.run_id} does not exist`);
    ids.add(ev.event_id);
    cursors.set(ev.source_id, ev.source_seq);
    events.push(ev);
  }
  if (events.length === 0) return;

  let gpu: GpuRow | undefined;
  for (const ev of events) {
    const simMs = ctx.db.run.run_id.find(ev.run_id)!.sim_time_ms; // the collector can't know the run clock
    ctx.db.telemetry_recent.insert({
      event_id: ev.event_id,
      run_id: ev.run_id,
      resource_id: ev.resource_id,
      source_kind: ev.source_kind,
      source_id: ev.source_id,
      source_seq: ev.source_seq,
      metric: ev.metric,
      value: ev.value,
      unit: ev.unit,
      quality: ev.quality,
      sim_time_ms: simMs,
      observed_unix_ms: ev.observed_unix_ms,
      labels_json: JSON.stringify(ev.labels),
    });
    if (ev.source_kind !== 'hardware') continue;
    gpu ??= { ...(ctx.db.gpu_current.resource_id.find(REAL_GPU_ID) ?? {
      resource_id: REAL_GPU_ID, run_id: ev.run_id, node_id: REAL_NODE_ID, availability: 'ready', temp_c: 0, sm_clock_mhz: 0,
      power_w: 0, power_limit_w: 0, clocks_event_reasons: 0, last_xid_code: undefined, last_seen_sim_ms: simMs, version: 0,
    }) };
    applyMetric(gpu, ev.metric, ev.value);
    gpu.last_seen_sim_ms = simMs;
    gpu.availability = 'ready';
  }

  if (gpu) {
    const next = { ...gpu, version: gpu.version + 1 };
    if (ctx.db.gpu_current.resource_id.find(REAL_GPU_ID)) ctx.db.gpu_current.resource_id.update(next);
    else ctx.db.gpu_current.insert(next);
  }
  for (const [source_id, last_seq] of cursors) {
    if (ctx.db.source_cursor.source_id.find(source_id)) ctx.db.source_cursor.source_id.update({ source_id, last_seq });
    else ctx.db.source_cursor.insert({ source_id, last_seq });
  }
  trimTelemetry(ctx); // the tick also trims, but not while the run is paused
});
