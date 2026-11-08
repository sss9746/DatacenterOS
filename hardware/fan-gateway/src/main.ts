// Fan gateway: the Pico prints SPINNING / STOPPED every ~100 ms. A sustained STOPPED (physical fan stall)
// injects the same admin fault the presenter's "fail pump" button sends: cooling_pump_degradation on pump-a,
// 60 % capacity loss, starting next tick. Honest label: physical fan stall (Pico 2 W) - demo rule. The
// fan is not wired to the twin's physics; this is a rule that maps a real stall to a simulated cooling fault.
//
//   pnpm --filter fan-gateway start -- --dry-run --stdin            # no DB, lines from stdin
//   pnpm --filter fan-gateway start -- --port COM7 --dry-run        # real serial, no DB
//   pnpm --filter fan-gateway start -- --port COM7 --db dcos-dev    # live (admin token)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { connect, type DbClient } from '@dcos/db-client';
import { buildStallFault, PUMP_LOSS, TARGET_PUMP } from './fault.js';
import { initialState, step, type DebounceState, type FanEvent } from './debounce.js';

const LABEL = 'physical fan stall (Pico 2 W) - demo rule';
const DEFAULT_ENV = 'C:\\Users\\suvan\\Desktop\\Desktop\\code\\hackathon\\datacenteros\\.env.local';
const ALLOWED_DB = 'dcos-dev';

const log = (msg: string) => process.stderr.write(`[fan] ${msg}\n`);

function parseOpts() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'), // pnpm passes a literal --
    options: {
      port: { type: 'string', default: 'COM7' },
      db: { type: 'string' },
      'run-id': { type: 'string', default: process.env.DCOS_RUN_ID ?? 'run-demo-1' },
      'dry-run': { type: 'boolean', default: false },
      stdin: { type: 'boolean', default: false },
      env: { type: 'string', default: DEFAULT_ENV },
    },
    allowPositionals: true,
  });
  const opts = { port: values.port!, db: values.db, runId: values['run-id']!, dryRun: values['dry-run']!, stdin: values.stdin!, env: values.env! };
  if (!opts.dryRun) {
    if (!opts.db) throw new Error(`pass --dry-run, or --db ${ALLOWED_DB} for live injection`);
    if (opts.db !== ALLOWED_DB) throw new Error(`refusing --db ${opts.db}: only ${ALLOWED_DB} is allowed`);
  }
  if (!/^COM\d+$/i.test(opts.port)) throw new Error(`--port must look like COM7, got ${opts.port}`);
  return opts;
}
type Opts = ReturnType<typeof parseOpts>;

async function connectAdmin(opts: Opts): Promise<DbClient> {
  if (existsSync(opts.env)) process.loadEnvFile(opts.env);
  else log(`env file not found: ${opts.env} (using process env)`);
  const uri = process.env.STDB_URI;
  const token = process.env.STDB_ADMIN_TOKEN;
  const missing = [!uri && 'STDB_URI', !token && 'STDB_ADMIN_TOKEN'].filter(Boolean);
  if (missing.length) throw new Error(`missing env: ${missing.join(', ')}`);
  log(`connecting to ${opts.db} as admin (run ${opts.runId})`);
  const db = await connect({ uri: uri!, db: opts.db!, token, runId: opts.runId });
  log('connected');
  return db;
}

async function onEvent(ev: FanEvent, opts: Opts, db: DbClient | null): Promise<void> {
  const held = `${(ev.heldMs / 1000).toFixed(1)}s/${ev.lines} lines`;
  if (ev.type === 'recover') {
    log(`SPINNING ${held} -> recover: no clear-fault API exists; recovery is up to the agent/dashboard`);
    return;
  }
  if (!db) {
    const fault = buildStallFault(opts.runId, 0, Date.now());
    log(`STOPPED ${held} -> stall: DRY RUN, would call db.injectFault(${JSON.stringify({ ...fault, start_sim_time_ms: '<sim_time_ms + 1000>' })})  // ${LABEL}`);
    return;
  }
  try {
    const snap = await db.getObservedSnapshot();
    const fault = buildStallFault(opts.runId, snap.clock.sim_time_ms, Date.now());
    await db.injectFault(fault);
    log(`STOPPED ${held} -> stall: injected ${fault.kind} (${PUMP_LOSS * 100}% loss) on ${fault.target_resource_id} id=${fault.fault_id} start=${fault.start_sim_time_ms}  // ${LABEL}`);
  } catch (error) {
    log(`STOPPED ${held} -> stall: injectFault FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function makeHandler(opts: Opts, db: DbClient | null) {
  let state: DebounceState = initialState;
  let chain = Promise.resolve();
  return (line: string) => {
    const r = step(state, line, Date.now());
    state = r.state;
    if (r.event) { const ev = r.event; chain = chain.then(() => onEvent(ev, opts, db)); }
  };
}

function serialScript(port: string): string {
  return [
    `$p = New-Object System.IO.Ports.SerialPort '${port}', 115200`,
    `$p.DtrEnable = $true; $p.RtsEnable = $true; $p.NewLine = "\`n"; $p.ReadTimeout = 5000`,
    `$p.Open()`,
    `[Console]::Out.WriteLine('#open'); [Console]::Out.Flush()`,
    `try { while ($true) { try { $l = $p.ReadLine() } catch [System.TimeoutException] { continue }; [Console]::Out.WriteLine($l.Trim()); [Console]::Out.Flush() } } finally { $p.Close() }`,
  ].join('; ');
}

async function readSerialForever(port: string, onLine: (line: string) => void): Promise<never> {
  let backoff = 1000;
  for (;;) {
    log(`opening ${port} via PowerShell SerialPort`);
    const code = await new Promise<number | null>((resolveExit) => {
      const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', serialScript(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
      const rl = createInterface({ input: ps.stdout });
      rl.on('line', (line) => {
        if (line === '#open') { log(`${port} open`); backoff = 1000; return; }
        onLine(line);
      });
      createInterface({ input: ps.stderr }).on('line', (l) => { if (l.trim()) log(`serial: ${l.trim()}`); });
      ps.on('error', (e) => { log(`spawn failed: ${e.message}`); resolveExit(null); });
      ps.on('exit', (c) => resolveExit(c));
    });
    log(`serial reader exited (code ${code}); reconnecting in ${backoff / 1000}s (is Thonny holding ${port}?)`);
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 10_000);
  }
}

async function main() {
  const opts = parseOpts();
  const db = opts.dryRun ? null : await connectAdmin(opts);
  log(`${opts.dryRun ? 'DRY RUN' : `live on ${opts.db}`}; stall -> cooling_pump_degradation on ${TARGET_PUMP}; source ${opts.stdin ? 'stdin' : opts.port}`);
  const onLine = makeHandler(opts, db);
  if (opts.stdin) {
    const rl = createInterface({ input: process.stdin });
    rl.on('line', onLine);
    await new Promise<void>((r) => rl.on('close', () => r()));
    await new Promise((r) => setTimeout(r, 200));
    db?.close();
    return;
  }
  await readSerialForever(opts.port, onLine);
}

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
