// nvidia-smi collector: real Brev GPU -> TelemetryEvents for gpu-real-0 (observation only; never mutates the GPU).
//   (no `--` after `start`: pnpm would hand it to parseArgs, which then ignores the flags)
//   pnpm --filter nvidia-smi-collector start --db dcos-r-local --fake         # invented numbers, local test DB only
//   pnpm --filter nvidia-smi-collector start --dry-run                        # print JSON, no DB
//   pnpm --filter nvidia-smi-collector start -- --db dcos-dev                 # live ingest (gateway token)
//   pnpm --filter nvidia-smi-collector start -- --dry-run --record ../recordings/brev-l4.jsonl
//   pnpm --filter nvidia-smi-collector start -- --db dcos-dev --replay ../recordings/brev-l4.jsonl
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validatePayload, type TelemetryEvent } from '@dcos/contracts';
import { connect } from '@dcos/db-client';
import {
  DEFAULT_SOURCE_ID,
  createMonotonicClock,
  createSeq,
  detectReasonField,
  parseCsvLine,
  queryFields,
  rowToEvents,
  type ParsedRow,
} from './mapping.js';
import { sshExec, sshStreamLines } from './ssh.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ALLOWED_DBS = ['dcos-dev', 'dcos', 'dcos-r-local'] as const;
const LOCAL_DB = 'dcos-r-local'; // private test DB: token file in ~/.dcos-tokens, and the only DB --fake may write to
const REPLAY_LABEL = 'REPLAY OF REAL RECORDING';
const REPLAY_MAX_GAP_MS = 5_000;

const log = (msg: string) => process.stderr.write(`[collector] ${msg}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Options {
  host: string;
  db: string | undefined;
  dryRun: boolean;
  record: string | undefined;
  replay: string | undefined;
  fake: boolean;
  runId: string;
  sourceId: string;
}

function readOptions(): Options {
  const { values } = parseArgs({
    options: {
      host: { type: 'string', default: 'dcos-gpu' },
      db: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      record: { type: 'string' },
      replay: { type: 'string' },
      fake: { type: 'boolean', default: false },
      'run-id': { type: 'string', default: process.env.DCOS_RUN_ID ?? 'run-demo-1' },
      'source-id': { type: 'string', default: DEFAULT_SOURCE_ID },
    },
    allowPositionals: false,
  });
  const opts: Options = {
    host: values.host!,
    db: values.db,
    dryRun: values['dry-run']!,
    record: values.record,
    replay: values.replay,
    fake: values.fake!,
    runId: values['run-id']!,
    sourceId: values['source-id']!,
  };
  if (opts.record && opts.replay) throw new Error('--record and --replay are mutually exclusive');
  if (opts.fake && opts.db !== LOCAL_DB) throw new Error(`--fake generates invented numbers and is only allowed with --db ${LOCAL_DB}`);
  if (opts.fake && (opts.record || opts.replay)) throw new Error('--fake cannot be combined with --record or --replay');
  if (!opts.dryRun && !opts.db) throw new Error('pass --dry-run, or --db dcos-dev|dcos for live ingest');
  if (opts.db && !(ALLOWED_DBS as readonly string[]).includes(opts.db)) {
    throw new Error(`--db must be one of ${ALLOWED_DBS.join(', ')}`);
  }
  return opts;
}

type Send = (batch: TelemetryEvent[]) => Promise<void>;

async function makeSink(opts: Options): Promise<Send> {
  if (opts.dryRun) {
    return async (batch) => {
      for (const ev of batch) process.stdout.write(`${JSON.stringify(ev)}\n`);
    };
  }
  // .env.local fills gaps; real env wins. Values are never logged.
  // The local DB is the exception: only its token file counts, so shell settings can't redirect it.
  const envFile = opts.db === LOCAL_DB ? resolve(homedir(), '.dcos-tokens/dcos-r-local.local.env') : resolve(REPO_ROOT, '.env.local');
  if (opts.db === LOCAL_DB) {
    if (!existsSync(envFile)) throw new Error(`missing token file ${envFile.replace(homedir(), '~')}`);
    delete process.env.STDB_URI;
    delete process.env.STDB_GATEWAY_TOKEN;
  }
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const uri = process.env.STDB_URI;
  const token = process.env.STDB_GATEWAY_TOKEN;
  const missing = [!uri && 'STDB_URI', !token && 'STDB_GATEWAY_TOKEN'].filter(Boolean);
  if (missing.length) throw new Error(`missing env in ${envFile.replace(homedir(), '~')}: ${missing.join(', ')}`);
  log(`connecting to ${opts.db} as gateway`);
  const db = await connect({ uri: uri!, db: opts.db!, token, runId: opts.runId });
  log('connected');
  return async (batch) => {
    try {
      await db.ingestObservations(batch);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      log(`ingest rejected: ${err.code ?? ''} ${err.message ?? String(e)}`);
    }
  };
}

/** Validate every event; drop (and report) any that fail the contract. */
function validOnly(batch: TelemetryEvent[]): TelemetryEvent[] {
  return batch.filter((ev) => {
    const res = validatePayload('TelemetryEvent', ev);
    if (!res.ok) log(`dropping invalid event ${ev.event_id}: ${res.errors.join('; ')}`);
    return res.ok;
  });
}

function summarize(batch: TelemetryEvent[]): string {
  const v = (m: string) => batch.find((e) => e.metric === `nvidia_smi.${m}`)?.value;
  const fmt = (n: number | undefined, unit: string, scale = 1) => (n === undefined ? 'n/a' : `${(n * scale).toFixed(0)}${unit}`);
  return `${fmt(v('temperature_gpu'), 'C')} ${fmt(v('power_draw'), 'W')} util ${fmt(v('utilization_gpu'), '%', 100)} sm ${fmt(v('clocks_sm'), 'MHz')} reasons 0x${(v('clocks_event_reasons') ?? 0).toString(16)}`;
}

async function runLive(opts: Options, send: Send): Promise<void> {
  log(`probing ${opts.host} (nvidia-smi --help-query-gpu)`);
  const reasonField = detectReasonField(await sshExec(opts.host, 'nvidia-smi --help-query-gpu'));
  log(`throttle-reason field: ${reasonField}`);
  const cmd = `nvidia-smi -i 0 --query-gpu=${queryFields(reasonField).join(',')} --format=csv,noheader,nounits -l 1`;
  const nextSeq = createSeq();
  const clock = createMonotonicClock();
  const handle = sshStreamLines(opts.host, cmd, (line) => {
    const row = parseCsvLine(line, reasonField);
    if (!row) {
      if (line.trim()) log(`unparsed line: ${line.trim()}`);
      return;
    }
    const batch = validOnly(
      rowToEvents(row, { runId: opts.runId, sourceId: opts.sourceId, sourceKind: 'hardware', observedUnixMs: clock(), nextSeq, host: 'brev' }),
    );
    if (opts.record) appendFileSync(opts.record, batch.map((e) => `${JSON.stringify(e)}\n`).join(''));
    log(`${summarize(batch)} -> ${batch.length} events${opts.dryRun ? ' (dry-run)' : ''}`);
    void send(batch);
  });
  const stop = () => {
    log('stopping');
    handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {}); // run until signalled
}

/** Group a recording into rows by original observed_unix_ms, in order. */
function loadRecording(file: string): Array<{ recordedMs: number; events: TelemetryEvent[] }> {
  const rows = new Map<number, TelemetryEvent[]>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const ev = JSON.parse(line) as TelemetryEvent;
    if (ev.source_kind !== 'hardware') throw new Error(`recording must contain hardware events only (got ${ev.source_kind})`);
    rows.set(ev.observed_unix_ms, [...(rows.get(ev.observed_unix_ms) ?? []), ev]);
  }
  return [...rows.entries()].sort(([a], [b]) => a - b).map(([recordedMs, events]) => ({ recordedMs, events }));
}

/** Re-send a recording as source_kind 'replay', with fresh seq/timestamps and an explicit REPLAY label. */
async function runReplay(opts: Options, send: Send): Promise<void> {
  const rows = loadRecording(opts.replay!);
  log(`${REPLAY_LABEL}: ${rows.length} rows from ${opts.replay}`);
  const nextSeq = createSeq();
  const clock = createMonotonicClock();
  for (let i = 0; i < rows.length; i++) {
    const { recordedMs, events } = rows[i]!;
    const parsed: ParsedRow = {
      gpuName: events[0]!.labels.gpu_name ?? 'unknown',
      values: new Map(events.map((e) => [e.metric, { value: e.value, unit: e.unit }])),
    };
    const batch = validOnly(
      rowToEvents(parsed, {
        runId: opts.runId,
        sourceId: `${opts.sourceId}-replay`,
        sourceKind: 'replay',
        observedUnixMs: clock(),
        nextSeq,
        host: events[0]!.labels.host ?? 'brev',
        extraLabels: { replay: REPLAY_LABEL, recorded_unix_ms: String(recordedMs) },
      }),
    );
    log(`[REPLAY] ${summarize(batch)} -> ${batch.length} events`);
    await send(batch);
    const next = rows[i + 1];
    if (next) await sleep(Math.min(Math.max(next.recordedMs - recordedMs, 0), REPLAY_MAX_GAP_MS));
  }
  log(`${REPLAY_LABEL}: done`);
}

/** Local-only test feed (guarded to dcos-r-local in readOptions). Invented numbers, labeled FAKE TEST GPU, never real. */
async function runFake(opts: Options, send: Send): Promise<void> {
  log('FAKE feed: invented numbers for the private local DB only');
  const nextSeq = createSeq();
  const clock = createMonotonicClock();
  for (let i = 0; ; i++) {
    const load = Math.min(1, Math.max(0, Math.sin(i / 20) * 0.5 + 0.5)); // smooth 0..1 so the tile visibly moves
    const parsed: ParsedRow = {
      gpuName: 'FAKE TEST GPU',
      values: new Map([
        ['nvidia_smi.temperature_gpu', { value: 35 + 40 * load, unit: 'C' }],
        ['nvidia_smi.power_draw', { value: 40 + 260 * load, unit: 'W' }],
        ['nvidia_smi.utilization_gpu', { value: load, unit: 'ratio' }],
        ['nvidia_smi.clocks_sm', { value: 1000 + 1000 * load, unit: 'MHz' }],
        ['nvidia_smi.power_limit', { value: 350, unit: 'W' }],
      ]),
    };
    const batch = validOnly(rowToEvents(parsed, { runId: opts.runId, sourceId: opts.sourceId, sourceKind: 'hardware', observedUnixMs: clock(), nextSeq, host: 'fake-local', extraLabels: { synthetic: 'FAKE TEST DATA' } }));
    log(`[FAKE] ${summarize(batch)} -> ${batch.length} events`);
    await send(batch);
    await sleep(1000);
  }
}

async function main(): Promise<void> {
  const opts = readOptions();
  const send = await makeSink(opts);
  if (opts.fake) await runFake(opts, send);
  else if (opts.replay) await runReplay(opts, send);
  else await runLive(opts, send);
  process.exit(0);
}

main().catch((e: unknown) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
