#!/usr/bin/env tsx
// Gate 2 (P2-7): the durable ledger end to end over the LIVE @dcos/db-client connect().
//
//   pnpm --filter db gate2 [db]          (default db: dcos-dev; RESETS run-demo-1; ~2 min)
//
// Token: STDB_ADMIN_TOKEN, else the spacetime CLI login token (~/.config/spacetime/cli.toml).
// Never printed. The identity must be admin (admin passes the agent role check).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePayload, type ActionCommand, type ActionStatus } from '@dcos/contracts';
import { connect, isDbError, type DbClient, type DbErrorCode } from '@dcos/db-client';

const DB = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) ?? 'dcos-dev';
if (DB === 'dcos') {
  console.error('gate2 resets the run; a check never resets prod dcos');
  process.exit(2);
}
const URI = process.env.STDB_URI ?? 'wss://maincloud.spacetimedb.com';
const RUN = 'run-demo-1';

function adminToken(): string {
  if (process.env.STDB_ADMIN_TOKEN) return process.env.STDB_ADMIN_TOKEN;
  const toml = readFileSync(join(homedir(), '.config', 'spacetime', 'cli.toml'), 'utf8');
  const m = /^spacetimedb_token\s*=\s*"([^"]+)"/m.exec(toml);
  if (!m) throw new Error('no STDB_ADMIN_TOKEN and no spacetime CLI login token');
  return m[1]!;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
async function expectCode(name: string, p: Promise<unknown>, code: DbErrorCode): Promise<void> {
  try {
    await p;
    check(name, false, 'no error');
  } catch (e) {
    check(name, isDbError(e, code), isDbError(e) ? `${e.code}` : String(e));
  }
}
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 90_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function command(c: DbClient, over: Partial<ActionCommand>): Promise<ActionCommand> {
  const snap = await c.getObservedSnapshot();
  return {
    schema_version: '1.1.0',
    run_id: RUN,
    action_id: 'act-x',
    command_key: 'key-x',
    workflow_id: 'wf-gate2',
    plan_id: 'plan-gate2',
    incident_ids: ['inc-gate2'],
    operation: 'checkpoint',
    target_resource_id: 'job-a',
    job_id: 'job-a',
    arguments: {},
    depends_on_command_keys: [],
    expected_decision_epoch: snap.clock.decision_epoch,
    expected_resource_versions: {},
    requested_sim_time_ms: snap.clock.sim_time_ms,
    ...over,
  };
}

const job = async (c: DbClient, id: string) => (await c.getObservedSnapshot()).job_states.find((j) => j.job_id === id)!;

// ---------------------------------------------------------------------------------------------
// --child: request + claim + start a checkpoint on job-b, report, then wait to be SIGKILLed.
// ---------------------------------------------------------------------------------------------
async function child(key: string): Promise<void> {
  const c = await connect({ uri: URI, db: DB, token: adminToken() });
  const cmd = await command(c, { action_id: `act-${key}`, command_key: key, target_resource_id: 'job-b', job_id: 'job-b' });
  const req = await c.requestAction(cmd);
  const { fencing_token } = await c.claimAction(key, req.version, 'crash-worker');
  await c.startAction(key, fencing_token);
  console.log('STARTED');
  await new Promise(() => {}); // hang until killed
}

// ---------------------------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log(`Gate 2 on ${DB} via live @dcos/db-client (resets ${RUN})`);
  const c = await connect({ uri: URI, db: DB, token: adminToken() });

  await c.createRun(RUN, 42, 'gpu_demo_8');
  await waitFor('run', async () => (await c.getObservedSnapshot()).clock.tick_index > 0);
  const snap0 = await c.getObservedSnapshot();
  check('live snapshot is a valid ObservedSnapshot', validatePayload('ObservedSnapshot', snap0).ok, `${snap0.gpus.length} gpus, ${snap0.job_states.length} jobs`);
  await c.configureRun(RUN, { speed: 5 });

  // 1 + 2: lifecycle, 10× retry → one action, one checkpoint
  const seen: ActionStatus['status'][] = [];
  const unsub = c.onChange((ch) => {
    if (ch.kind === 'action_status' && ch.status.command_key === 'gate2-ck-a' && seen.at(-1) !== ch.status.status) seen.push(ch.status.status);
  });
  const ckpts0 = (await c.getObservedSnapshot()).checkpoints.filter((k) => k.job_id === 'job-a').length;
  const ck = await command(c, { action_id: 'act-gate2-ck-a', command_key: 'gate2-ck-a' });
  const first = await c.requestAction(ck);
  for (let i = 1; i < 10; i++) await c.requestAction({ ...ck, requested_sim_time_ms: ck.requested_sim_time_ms + i });
  const again = await c.getActionStatus('gate2-ck-a');
  check('2. request ×10 → one action (same version, requested)', first.status === 'requested' && again?.version === first.version, `v${first.version} → v${again?.version}`);
  const durable0 = (await job(c, 'job-a')).durable_work_units;
  const epochBefore = (await c.getObservedSnapshot()).clock.decision_epoch;
  // Sample job-a on EVERY job update while the checkpoint is running (action status comes from
  // onChange, which the SDK fires during the transaction, before the coalesced onJobs callback).
  let runningSamples = 0;
  let durabilityViolation: string | null = null;
  const unJobs = c.onJobs((jobs) => {
    if (seen.at(-1) !== 'running') return;
    const a = jobs.find((j) => j.job_id === 'job-a');
    runningSamples++;
    if (a && a.durable_work_units !== durable0) durabilityViolation ??= `durable ${a.durable_work_units} while running`;
  });
  const claim = await c.claimAction('gate2-ck-a', first.version, 'gate2-worker');
  await c.startAction('gate2-ck-a', claim.fencing_token);
  const done = await waitFor('checkpoint', async () => {
    const st = await c.getActionStatus('gate2-ck-a');
    return st && ['succeeded', 'failed', 'cancelled', 'needs_reconciliation'].includes(st.status) ? st : null;
  });
  unJobs();
  unsub();
  const durable1 = (await job(c, 'job-a')).durable_work_units;
  check('1. checkpoint requested → claimed → running → succeeded', done.status === 'succeeded' && seen.join('>') === 'requested>claimed>running>succeeded', seen.join('>'));
  check(
    '1. durable_work_units only changes at succeeded',
    runningSamples > 0 && durabilityViolation === null && durable1 > durable0,
    `${runningSamples} samples while running at ${durable0}${durabilityViolation ? `; ${durabilityViolation}` : ''} → ${durable1}`
  );
  const ckpts1 = (await c.getObservedSnapshot()).checkpoints.filter((k) => k.job_id === 'job-a').length;
  check('2. exactly one new checkpoint for job-a', ckpts1 === ckpts0 + 1, `${ckpts0} → ${ckpts1}`);

  // 3: collision
  await expectCode('3. same key, different payload → COMMAND_KEY_COLLISION', c.requestAction({ ...ck, arguments: { x: 1 } }), 'COMMAND_KEY_COLLISION');

  // 4: move onto rack-r6 denied
  const r6 = [...Array(8).keys()].map((i) => `gpu-r6-n1-${i}`).concat([...Array(8).keys()].map((i) => `gpu-r5-n1-${i}`));
  const mv = await c.requestAction(await command(c, { action_id: 'act-gate2-mv-r6', command_key: 'gate2-mv-r6', operation: 'migrate_restart', arguments: { destination_gpu_ids: r6 } }));
  const mvViol = (mv.result.violations as string[] | undefined) ?? [];
  check('4. move job-a onto rack-r6 → DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT', mv.status === 'failed' && mv.reason_code === 'SAFETY_REJECTED' && mvViol.includes('DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT'), mvViol.join(','));

  // 5: stale epoch: the epoch captured before the checkpoint, which its completion advanced
  const epochNow = (await c.getObservedSnapshot()).clock.decision_epoch;
  const stale = await c.requestAction(await command(c, { action_id: 'act-gate2-stale', command_key: 'gate2-stale', operation: 'keep_running', expected_decision_epoch: epochBefore }));
  check(
    '5. old expected_decision_epoch → STALE_DECISION_EPOCH',
    epochNow > epochBefore && stale.status === 'failed' && ((stale.result.violations as string[]) ?? []).includes('STALE_DECISION_EPOCH'),
    `epoch ${epochBefore} → ${epochNow}, request with ${epochBefore}: ${stale.status}`
  );

  // 6: workflow ownership
  const l1 = await c.claimWorkflow('wf-gate2', 'w1', 0, 2000);
  await expectCode('6. second worker while lease is live → LEASE_HELD', c.claimWorkflow('wf-gate2', 'w2', l1.workflow.version, 2000), 'LEASE_HELD');
  await sleep(2500);
  const l2 = await c.claimWorkflow('wf-gate2', 'w2', l1.workflow.version, 10_000);
  check('6. after expiry the second worker takes over', l2.workflow.lease_owner === 'w2' && l2.fencing_token > l1.fencing_token);
  await expectCode('6. stale owner (old token) → STALE_FENCING_TOKEN', c.updateWorkflow('wf-gate2', l2.workflow.version, l1.fencing_token, 'execute', {}), 'STALE_FENCING_TOKEN');

  // 7: crash mid-checkpoint
  const key = 'gate2-crash-ck-b';
  const proc = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), DB, '--child', key], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    proc.stdout.on('data', (d: Buffer) => d.toString().includes('STARTED') && resolve());
    proc.on('exit', (code) => reject(new Error(`child exited early (${code})`)));
  });
  // The child's writes reach this client's cache asynchronously: wait until we see it running.
  const runningBeforeKill = await waitFor('crash checkpoint running', async () => (await c.getActionStatus(key))?.status === 'running', 15_000).catch(() => false);
  proc.kill('SIGKILL');
  await new Promise((r) => proc.once('exit', r));
  check('7. caller SIGKILLed while its checkpoint runs', runningBeforeKill === true && proc.signalCode === 'SIGKILL', `${proc.signalCode}`);
  const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'needs_reconciliation']);
  const crashDone = await waitFor('crash checkpoint', async () => {
    const st = await c.getActionStatus(key);
    return st && TERMINAL.has(st.status) ? st : null;
  });
  check('7. checkpoint still reaches succeeded', crashDone.status === 'succeeded', crashDone.status);
  try {
    // A fresh action on job-b can claim only if the crashed checkpoint's leases were released.
    const st = await c.requestAction(await command(c, { action_id: 'act-gate2-after', command_key: 'gate2-after', operation: 'keep_running', target_resource_id: 'job-b', job_id: 'job-b' }));
    const cl = await c.claimAction('gate2-after', st.version, 'gate2-worker');
    await c.cancelAction('gate2-after', 'GATE2_DONE', cl.fencing_token);
    check('7. leases released afterwards (job-b claimable again)', st.status === 'requested', st.status);
  } catch (e) {
    check('7. leases released afterwards (job-b claimable again)', false, String(e));
  }

  await c.configureRun(RUN, { speed: 1 });
  c.close();
  console.log(failures === 0 ? '\nGATE 2: ALL PASS' : `\nGATE 2: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

const childIdx = process.argv.indexOf('--child');
(childIdx >= 0 ? child(process.argv[childIdx + 1]!) : main()).catch((e) => {
  console.error('FAIL ', e instanceof Error ? e.message : e);
  process.exit(1);
});
