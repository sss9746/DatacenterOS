#!/usr/bin/env tsx
// G3 live proof of ingest_observations over the real @dcos/db-client connect().
//
//   STDB_URI=ws://127.0.0.1:3000 STDB_SERVER=local pnpm --filter db exec tsx scripts/ingest-smoke.ts <db>
//
// The database argument is required and prod is refused. RESETS run-demo-1 at the start and end.
// Role tokens come from ~/.dcos-tokens/<db>[.<server>].env and are never printed.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GpuCurrent, TelemetryEvent } from '@dcos/contracts';
import { connect, isDbError, type DbClient, type DbErrorCode } from '@dcos/db-client';

const DB = process.argv[2];
if (!DB || DB === 'dcos') {
  console.error('usage: ingest-smoke.ts <db>  (a dev or local database; prod dcos is refused)');
  process.exit(2);
}
const URI = process.env.STDB_URI ?? 'wss://maincloud.spacetimedb.com';
const SERVER = process.env.STDB_SERVER ?? 'maincloud';
const RUN = 'run-demo-1';
const REAL = 'gpu-real-0';
const SOURCE = `ingest-smoke-${Date.now()}`;

const file = join(homedir(), '.dcos-tokens', SERVER === 'maincloud' ? `${DB}.env` : `${DB}.${SERVER}.env`);
const tokens = Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => /^STDB_[A-Z]+_TOKEN=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const client = (role: string): Promise<DbClient> => connect({ uri: URI, db: DB!, token: tokens[`STDB_${role}_TOKEN`]! });

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
async function expectCode(name: string, p: Promise<unknown>, code: DbErrorCode): Promise<void> {
  try {
    await p;
    check(name, false, 'accepted');
  } catch (e) {
    check(name, isDbError(e, code), String(e));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

let seq = Date.now();
const UNITS: Record<string, string> = { temperature_gpu: 'C', power_draw: 'W', utilization_gpu: 'ratio', clocks_sm: 'MHz', power_limit: 'W', clocks_event_reasons: 'bitmask' };
const ev = (name: string, value: number, over: Partial<TelemetryEvent> = {}): TelemetryEvent => {
  const s = ++seq;
  return {
    schema_version: '1.1.0', event_id: `hw.${s}.${REAL}.nvidia_smi.${name}`, run_id: RUN, resource_id: REAL, source_kind: 'hardware',
    source_id: SOURCE, source_seq: s, observed_unix_ms: Date.now(), sim_time_ms: 0, metric: `nvidia_smi.${name}`, value, unit: UNITS[name]!,
    quality: 'good', labels: { collector: 'nvidia-smi', gpu_name: 'test', host: 'test' }, ...over,
  } as TelemetryEvent;
};

async function main(): Promise<void> {
  console.log(`ingest smoke on ${DB} (resets ${RUN})`);
  const admin = await client('ADMIN');
  const gateway = await client('GATEWAY');
  const agent = await client('AGENT');
  const realRow = async (): Promise<GpuCurrent | undefined> => (await gateway.getObservedSnapshot()).gpus.find((g) => g.resource_id === REAL);

  await admin.createRun(RUN, 42, 'gpu_demo_8');
  await waitFor('first tick', async () => (await gateway.getObservedSnapshot()).clock.tick_index > 0);
  check('no real GPU row before ingest', (await realRow()) === undefined);

  const first = [ev('temperature_gpu', 61), ev('power_draw', 120), ev('utilization_gpu', 0.5), ev('clocks_sm', 1500), ev('power_limit', 150), ev('clocks_event_reasons', 32)];
  await gateway.ingestObservations(first);
  const row = await realRow();
  check('batch accepted; gpu_current filled from each metric', row?.temp_c === 61 && row.power_w === 120 && row.sm_clock_mhz === 1500 && row.power_limit_w === 150 && row.clocks_event_reasons === 32 && row.availability === 'ready' && row.node_id === 'node-real-0', JSON.stringify(row));

  const tickNow = (await gateway.getObservedSnapshot()).clock.tick_index;
  await waitFor('3 more ticks', async () => (await gateway.getObservedSnapshot()).clock.tick_index >= tickNow + 3);
  check('row survives the per-tick projection', (await realRow())?.temp_c === 61);
  const snap = await gateway.getObservedSnapshot();
  check('64 simulated GPUs plus the real one', snap.gpus.length === 65, `${snap.gpus.length}`);

  const stamped = (await gateway.getEvidence([], 1e9)).telemetry.filter((t) => t.source_id === SOURCE);
  check('telemetry stored, sim_time_ms stamped from the run clock', stamped.length === first.length && stamped.every((t) => t.sim_time_ms >= 600_000), `${stamped.length} rows, sim ${stamped[0]?.sim_time_ms}`);

  await expectCode('same batch again → INVALID_PAYLOAD', gateway.ingestObservations(first), 'INVALID_PAYLOAD');
  await expectCode('agent token → UNAUTHORIZED', agent.ingestObservations([ev('temperature_gpu', 62)]), 'UNAUTHORIZED');
  await expectCode('admin token → UNAUTHORIZED', admin.ingestObservations([ev('temperature_gpu', 62)]), 'UNAUTHORIZED');
  await expectCode('21 events → INVALID_PAYLOAD', gateway.ingestObservations(Array.from({ length: 21 }, () => ev('temperature_gpu', 62))), 'INVALID_PAYLOAD');
  await expectCode('other resource → INVALID_PAYLOAD', gateway.ingestObservations([ev('temperature_gpu', 62, { resource_id: 'gpu-r1-n1-0' })]), 'INVALID_PAYLOAD');
  await expectCode('other source_kind → INVALID_PAYLOAD', gateway.ingestObservations([ev('temperature_gpu', 62, { source_kind: 'simulator' })]), 'INVALID_PAYLOAD');

  const good = ev('temperature_gpu', 70);
  const stale = ev('power_draw', 999, { source_seq: 1 });
  await expectCode('old source_seq in a batch → INVALID_PAYLOAD', gateway.ingestObservations([good, stale]), 'INVALID_PAYLOAD');
  check('rejected batch wrote nothing', (await realRow())?.temp_c === 61);

  const versionBefore = (await realRow())!.version;
  await gateway.ingestObservations([ev('temperature_gpu', 65)]);
  const partial = await realRow();
  check('missing metric keeps its last value; version + 1', partial?.temp_c === 65 && partial.power_w === 120 && partial.version === versionBefore + 1, JSON.stringify(partial));

  const replay = ev('temperature_gpu', 99, { source_kind: 'replay' });
  await gateway.ingestObservations([replay]);
  check('replay stored as telemetry but never touches gpu_current', (await realRow())?.temp_c === 65 && (await gateway.getEvidence([], 1e9)).telemetry.some((t) => t.event_id === replay.event_id));

  await admin.createRun(RUN, 42, 'gpu_demo_8');
  await waitFor('real row cleared by reset', async () => (await realRow()) === undefined);
  check('reset clears the real GPU row', true);
  for (const c of [admin, gateway, agent]) c.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL ', e instanceof Error ? e.message : e);
  process.exit(1);
});
