#!/usr/bin/env node
// Live integration test of the action ledger (P2-5) against a published database, via the
// `spacetime` CLI (the db-client's live connect() isn't wired yet; P2-7's gate2.ts will use it).
//
//   node apps/db/scripts/ledger-smoke.mjs [db]      (default db: dcos-dev; RESETS run-demo-1)
//
// The CLI identity must be admin (admin passes the agent role check).
import { spawnSync } from 'node:child_process';

const DB = process.argv[2] ?? 'dcos-dev';
const RUN = 'run-demo-1';
const SERVER = ['-s', 'maincloud'];
let failures = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (v) => JSON.stringify(v); // the CLI parses every argument as JSON
const jsonArg = (obj) => JSON.stringify(JSON.stringify(obj)); // a string reducer arg holding JSON

function call(reducer, args = [], { anonymous = false } = {}) {
  const r = spawnSync('spacetime', ['call', ...SERVER, ...(anonymous ? ['--anonymous'] : []), DB, reducer, ...args], { encoding: 'utf8' });
  const out = `${r.stdout}\n${r.stderr}`;
  const m = /Response text: (.*)/.exec(out);
  return { ok: r.status === 0 && !m, error: m ? m[1].trim() : r.status === 0 ? null : out.trim() };
}

function sql(query) {
  const r = spawnSync('spacetime', ['sql', ...SERVER, '--format', 'json', DB, query], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sql failed: ${query}\n${r.stderr}`);
  const [res] = JSON.parse(r.stdout);
  const cols = res.schema.elements.map((e) => e.name.some);
  const unopt = (v) => (Array.isArray(v) && v.length === 2 && (v[0] === 0 || v[0] === 1) ? (v[0] === 0 ? v[1] : null) : v);
  return res.rows.map((row) => Object.fromEntries(row.map((v, i) => [cols[i], unopt(v)])));
}

function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
}
const expectError = (name, res, code) => check(name, !res.ok && res.error?.startsWith(`${code}:`), res.error ?? 'no error');
const action = (key) => sql(`SELECT * FROM action WHERE command_key = '${key}'`)[0];
const run = () => sql(`SELECT * FROM run WHERE run_id = '${RUN}'`)[0];
const job = (id) => sql(`SELECT * FROM job_current WHERE job_id = '${id}'`)[0];

async function waitFor(name, fn, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${name}`);
}

function command(over) {
  const r = run();
  return {
    schema_version: '1.1.0',
    run_id: RUN,
    action_id: 'act-x',
    command_key: 'key-x',
    workflow_id: 'wf-smoke',
    plan_id: 'plan-smoke',
    incident_ids: ['inc-smoke'],
    operation: 'checkpoint',
    target_resource_id: 'job-a',
    job_id: 'job-a',
    arguments: {},
    depends_on_command_keys: [],
    expected_decision_epoch: r.decision_epoch,
    expected_resource_versions: {},
    requested_sim_time_ms: r.sim_time_ms,
    ...over,
  };
}

console.log(`ledger smoke test on ${DB} (resets ${RUN})`);
check('create_run', call('create_run', [arg(RUN), '42', arg('gpu_demo_8')]).ok);
await sleep(1500);

// --- request: validation, idempotency, collision -----------------------------------------------
const ck = command({ action_id: 'act-ck-1', command_key: 'ck-job-a-1', expected_resource_versions: { 'job-a': job('job-a').version } });
expectError('anonymous request → UNAUTHORIZED', call('request_action', [jsonArg(ck)], { anonymous: true }), 'UNAUTHORIZED');
expectError('bad payload → INVALID_PAYLOAD', call('request_action', [jsonArg({ ...ck, operation: 'reboot' })]), 'INVALID_PAYLOAD');
check('request checkpoint', call('request_action', [jsonArg(ck)]).ok);
let a = action('ck-job-a-1');
check('  status requested v1', a?.status === 'requested' && a.version === 1, `${a?.status} v${a?.version}`);
check('  payload_hash is sha256 hex', /^[0-9a-f]{64}$/.test(a?.payload_hash ?? ''));
for (let i = 0; i < 10; i++) call('request_action', [jsonArg({ ...ck, requested_sim_time_ms: ck.requested_sim_time_ms + i })]);
a = action('ck-job-a-1');
const evs = sql(`SELECT * FROM action_event WHERE command_key = 'ck-job-a-1'`);
check('10× retry (incl. new requested_sim_time_ms) → one row, v1, one event', a.version === 1 && evs.length === 1, `v${a.version}, ${evs.length} events`);
expectError('same key, different payload → COMMAND_KEY_COLLISION', call('request_action', [jsonArg({ ...ck, arguments: { x: 1 } })]), 'COMMAND_KEY_COLLISION');

// --- claim -----------------------------------------------------------------------------------
expectError('claim with wrong version → VERSION_CONFLICT', call('claim_action', [arg('ck-job-a-1'), '7', arg('worker-1')]), 'VERSION_CONFLICT');
check('claim v1 by worker-1', call('claim_action', [arg('ck-job-a-1'), '1', arg('worker-1')]).ok);
a = action('ck-job-a-1');
const token = Number(a.lease_token);
const leases = sql(`SELECT * FROM resource_lease WHERE action_id = 'act-ck-1'`);
check('  claimed v2, token > 0, claimed_by worker-1', a.status === 'claimed' && a.version === 2 && token > 0 && a.claimed_by === 'worker-1', `${a.status} v${a.version} token ${token}`);
check('  closure leased: job-a + its 16 GPUs', leases.length === 17 && leases.some((l) => l.resource_id === 'job-a'), `${leases.length} leases`);
expectError('second worker claim → LEASE_HELD', call('claim_action', [arg('ck-job-a-1'), '2', arg('worker-2')]), 'LEASE_HELD');

const pause = command({ action_id: 'act-pause-1', command_key: 'pause-job-a-1', operation: 'pause_job' });
call('request_action', [jsonArg(pause)]);
const p = action('pause-job-a-1');
check('overlapping pause_job on leased job → failed SAFETY_REJECTED (CONFLICTING_ACTION)', p.status === 'failed' && p.reason_code === 'SAFETY_REJECTED' && p.result_json.includes('CONFLICTING_ACTION'), `${p.status} ${p.reason_code}`);

// --- start + completion in the tick ------------------------------------------------------------
expectError('start with wrong token → STALE_FENCING_TOKEN', call('start_action', [arg('ck-job-a-1'), String(token + 99)]), 'STALE_FENCING_TOKEN');
check('start with token', call('start_action', [arg('ck-job-a-1'), String(token)]).ok);
a = action('ck-job-a-1');
check('  running v3', a.status === 'running' && a.version === 3, `${a.status} v${a.version}`);
expectError('cancel a running action → INVALID_TRANSITION', call('cancel_action', [arg('ck-job-a-1'), arg('SUPERSEDED'), String(token)]), 'INVALID_TRANSITION');
const durableBefore = job('job-a').durable_work_units;
a = await waitFor('due time', () => { const x = action('ck-job-a-1'); return x.due_sim_time_ms !== null ? x : null; });
check('  physics set due_sim_time_ms (start + 30 s)', a.due_sim_time_ms > 0, `due ${a.due_sim_time_ms}`);
const writing = sql(`SELECT * FROM checkpoint WHERE job_id = 'job-a'`).find((c) => c.status === 'writing');
check('  checkpoint row writing; durable work unchanged', !!writing && job('job-a').durable_work_units === durableBefore, writing?.checkpoint_id ?? 'none');
check('speed 5', call('configure_run', [arg(RUN), jsonArg({ speed: 5 })]).ok);
a = await waitFor('checkpoint success', () => { const x = action('ck-job-a-1'); return x.status !== 'running' ? x : null; });
check('  succeeded (no client needed for completion)', a.status === 'succeeded', `${a.status} ${a.reason_code ?? ''}`);
const jb = job('job-a');
check('  durable work advanced, latest checkpoint complete', jb.durable_work_units > durableBefore && sql(`SELECT * FROM checkpoint WHERE checkpoint_id = '${jb.latest_checkpoint_id}'`)[0]?.status === 'complete', `${durableBefore} → ${jb.durable_work_units}`);
check('  leases released', sql(`SELECT * FROM resource_lease WHERE action_id = 'act-ck-1'`).length === 0);
call('configure_run', [arg(RUN), jsonArg({ speed: 1 })]);

// Sequential flow (what P3 does): the completed checkpoint bumped decision_epoch, so a migrate
// stamped with the pre-checkpoint epoch is stale; re-reading the epoch makes it valid.
check('checkpoint completion bumped decision_epoch', run().decision_epoch > ck.expected_decision_epoch, `${ck.expected_decision_epoch} → ${run().decision_epoch}`);
const r8 = Array.from({ length: 8 }, (_, i) => `gpu-r8-n1-${i}`).concat(Array.from({ length: 8 }, (_, i) => `gpu-r1-n1-${i}`));
call('request_action', [jsonArg(command({ action_id: 'act-seq-old', command_key: 'seq-mv-old', operation: 'migrate_restart', arguments: { destination_gpu_ids: r8 }, expected_decision_epoch: ck.expected_decision_epoch }))]);
check('  migrate with the pre-checkpoint epoch → STALE_DECISION_EPOCH', action('seq-mv-old').result_json.includes('STALE_DECISION_EPOCH'));
call('request_action', [jsonArg(command({ action_id: 'act-seq-new', command_key: 'seq-mv-new', operation: 'migrate_restart', arguments: { destination_gpu_ids: r8 }, expected_resource_versions: { 'job-a': job('job-a').version } }))]);
const seq = action('seq-mv-new');
check('  migrate with the refreshed epoch → requested', seq.status === 'requested', `${seq.status} ${seq.result_json.slice(0, 160)}`);

// Node-scoped power_cap locks the node's GPUs: a GPU-scoped cap on one of them can't also claim.
call('request_action', [jsonArg(command({ action_id: 'act-pc-node', command_key: 'pc-node-r4', operation: 'power_cap', target_resource_id: 'node-r4-n1', job_id: null, arguments: { power_limit_w: 500 } }))]);
check('power_cap on node-r4-n1 claimed', call('claim_action', [arg('pc-node-r4'), '1', arg('worker-1')]).ok);
check('  node lease covers its 8 GPUs', sql(`SELECT * FROM resource_lease WHERE action_id = 'act-pc-node'`).length >= 9);
call('request_action', [jsonArg(command({ action_id: 'act-pc-gpu', command_key: 'pc-gpu-r4-0', operation: 'power_cap', target_resource_id: 'gpu-r4-n1-0', job_id: null, arguments: { power_limit_w: 500 } }))]);
const pcGpu = action('pc-gpu-r4-0');
const pcClaim = pcGpu.status === 'requested' ? call('claim_action', [arg('pc-gpu-r4-0'), '1', arg('worker-2')]) : { ok: false, error: `request ${pcGpu.status}` };
check('  GPU-scoped cap on gpu-r4-n1-0 is rejected (safety or LEASE_HELD)', !pcClaim.ok, pcClaim.error ?? 'claimed!');
call('cancel_action', [arg('pc-node-r4'), arg('TEST_DONE'), String(action('pc-node-r4').lease_token)]);
check('verify', call('verify_action', [arg('ck-job-a-1'), jsonArg({ checked: 'durable advanced' })]).ok);
check('  verification stored', action('ck-job-a-1').result_json.includes('durable advanced'));
expectError('verify a non-succeeded action → INVALID_TRANSITION', call('verify_action', [arg('pause-job-a-1'), jsonArg({})]), 'INVALID_TRANSITION');

// --- safety denials ----------------------------------------------------------------------------
const r6 = Array.from({ length: 8 }, (_, i) => `gpu-r6-n1-${i}`).concat(Array.from({ length: 8 }, (_, i) => `gpu-r5-n1-${i}`));
const mv = command({ action_id: 'act-mv-r6', command_key: 'mv-job-a-r6', operation: 'migrate_restart', arguments: { destination_gpu_ids: r6 } });
call('request_action', [jsonArg(mv)]);
const m = action('mv-job-a-r6');
check('move job-a onto r6 → failed with DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT', m.status === 'failed' && m.result_json.includes('DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT'), JSON.parse(m.result_json).violations?.join(','));
const stale = command({ action_id: 'act-stale', command_key: 'stale-1', operation: 'keep_running', expected_decision_epoch: run().decision_epoch + 5 });
call('request_action', [jsonArg(stale)]);
const s = action('stale-1');
check('stale epoch → failed with STALE_DECISION_EPOCH', s.status === 'failed' && s.result_json.includes('STALE_DECISION_EPOCH'), s.status);

// --- cancel ------------------------------------------------------------------------------------
const kr = command({ action_id: 'act-kr', command_key: 'kr-job-b', operation: 'keep_running', target_resource_id: 'job-b', job_id: 'job-b' });
call('request_action', [jsonArg(kr)]);
expectError('cancel requested action with token 0 → STALE_FENCING_TOKEN', call('cancel_action', [arg('kr-job-b'), arg('SUPERSEDED'), '0']), 'STALE_FENCING_TOKEN');
call('claim_action', [arg('kr-job-b'), '1', arg('worker-1')]);
const krTok = Number(action('kr-job-b').lease_token);
check('cancel claimed action with its token', call('cancel_action', [arg('kr-job-b'), arg('SUPERSEDED'), String(krTok)]).ok);
const k = action('kr-job-b');
check('  cancelled, reason kept, leases released', k.status === 'cancelled' && k.reason_code === 'SUPERSEDED' && sql(`SELECT * FROM resource_lease WHERE action_id = 'act-kr'`).length === 0, `${k.status} ${k.reason_code}`);
// --- claim lease expiry → re-claim fences out the old worker -----------------------------------
const kr2 = command({ action_id: 'act-kr2', command_key: 'kr2-job-b', operation: 'keep_running', target_resource_id: 'job-b', job_id: 'job-b' });
call('request_action', [jsonArg(kr2)]);
call('claim_action', [arg('kr2-job-b'), '1', arg('worker-1')]);
const oldTok = Number(action('kr2-job-b').lease_token);
console.log('      (waiting 16 s for the claim lease to expire)');
await sleep(16_000);
expectError('expired claim → start rejected LEASE_EXPIRED', call('start_action', [arg('kr2-job-b'), String(oldTok)]), 'LEASE_EXPIRED');
check('expired claim → another worker can claim', call('claim_action', [arg('kr2-job-b'), '2', arg('worker-2')]).ok);
const kr2Row = action('kr2-job-b');
check('  new token, attempt 2', Number(kr2Row.lease_token) > oldTok && kr2Row.attempt === 2, `token ${oldTok} → ${kr2Row.lease_token}`);
expectError('  old worker start → STALE_FENCING_TOKEN', call('start_action', [arg('kr2-job-b'), String(oldTok)]), 'STALE_FENCING_TOKEN');
call('cancel_action', [arg('kr2-job-b'), arg('TEST_DONE'), String(kr2Row.lease_token)]);

// --- checkpoint → migrate chain (dependency; job version bumped by the checkpoint) -------------
const dest = Array.from({ length: 8 }, (_, i) => `gpu-r5-n1-${i}`).concat(Array.from({ length: 8 }, (_, i) => `gpu-r7-n1-${i}`));
const ck2 = command({ action_id: 'act-ck-2', command_key: 'ck-job-a-2', expected_resource_versions: { 'job-a': job('job-a').version } });
const mv2 = command({
  action_id: 'act-mv-2', command_key: 'mv-job-a-r5r7', operation: 'migrate_restart',
  arguments: { destination_gpu_ids: dest }, depends_on_command_keys: ['ck-job-a-2'],
  expected_resource_versions: { 'job-a': job('job-a').version },
});
call('request_action', [jsonArg(ck2)]);
call('request_action', [jsonArg(mv2)]);
const mvReq = action('mv-job-a-r5r7');
check('migrate (depends on checkpoint) requested', mvReq.status === 'requested', `${mvReq.status} ${mvReq.result_json.slice(0, 120)}`);
check('  action_dependency row', sql(`SELECT * FROM action_dependency WHERE action_id = 'act-mv-2'`).length === 1);
call('claim_action', [arg('ck-job-a-2'), '1', arg('worker-1')]);
call('start_action', [arg('ck-job-a-2'), String(action('ck-job-a-2').lease_token)]);
expectError('  migrate claim while checkpoint runs → LEASE_HELD', call('claim_action', [arg('mv-job-a-r5r7'), '1', arg('worker-1')]), 'LEASE_HELD');
call('configure_run', [arg(RUN), jsonArg({ speed: 5 })]);
await waitFor('checkpoint 2', () => action('ck-job-a-2').status === 'succeeded');
check('  migrate claim after checkpoint', call('claim_action', [arg('mv-job-a-r5r7'), '1', arg('worker-1')]).ok);
const mvStart = call('start_action', [arg('mv-job-a-r5r7'), String(action('mv-job-a-r5r7').lease_token)]);
check('  migrate start (job version changed by its own dependency is tolerated)', mvStart.ok && action('mv-job-a-r5r7').status === 'running', mvStart.error ?? action('mv-job-a-r5r7').status);
const mvDone = await waitFor('migrate', () => { const x = action('mv-job-a-r5r7'); return x.status !== 'running' ? x : null; }, 90_000);
const alloc = sql(`SELECT * FROM job_gpu_allocation WHERE job_id = 'job-a'`).map((x) => x.gpu_id).sort();
check('  migrate succeeded; job-a now on r5 + r7', mvDone.status === 'succeeded' && alloc.join() === [...dest].sort().join(), `${mvDone.status} ${mvDone.reason_code ?? ''} ${alloc.length} gpus`);
call('configure_run', [arg(RUN), jsonArg({ speed: 1 })]);

const allEvents = sql(`SELECT * FROM action_event WHERE command_key = 'ck-job-a-1'`).map((e) => e.status);
check('action_event on every transition', allEvents.join('>') === 'requested>claimed>running>succeeded>succeeded', allEvents.join('>'));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
