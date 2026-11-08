#!/usr/bin/env node
// Live integration test of workflows + incidents (P2-6) via the `spacetime` CLI.
//
//   node apps/db/scripts/workflow-smoke.mjs [db]      (default db: dcos-dev; RESETS run-demo-1)
//
// The CLI identity must be admin (admin passes the agent role check).
import { arg, connectCli, jsonArg, sleep } from './stdb.mjs';

const DB = process.argv[2] ?? 'dcos-dev';
const RUN = 'run-demo-1';
const { call, sql, check, expectError, done } = connectCli(DB);
const wf = (id) => sql(`SELECT * FROM workflow WHERE workflow_id = '${id}'`)[0];
const run = () => sql(`SELECT * FROM run WHERE run_id = '${RUN}'`)[0];

console.log(`workflow smoke test on ${DB} (resets ${RUN})`);
check('create_run', call('create_run', [arg(RUN), '42', arg('gpu_demo_8')]).ok);

// --- claim: create, two workers, CAS -----------------------------------------------------------
expectError('anonymous claim → UNAUTHORIZED', call('claim_workflow', [arg('wf-1'), arg('w1'), '0', '5000'], { anonymous: true }), 'UNAUTHORIZED');
expectError('claim missing workflow with version 3 → NOT_FOUND', call('claim_workflow', [arg('wf-1'), arg('w1'), '3', '5000']), 'NOT_FOUND');
check('worker w1 claims new wf-1 (expected v0, 8 s lease)', call('claim_workflow', [arg('wf-1'), arg('w1'), '0', '8000']).ok);
let w = wf('wf-1');
const tok1 = Number(w.fencing_token);
check('  v1, stage idle, owner w1, token > 0, attempt 1', w.version === 1 && w.stage === 'idle' && w.lease_owner === 'w1' && tok1 > 0 && w.attempt === 1, `v${w.version} ${w.stage} ${w.lease_owner} t${tok1}`);
expectError('worker w2 claims while w1 holds it → LEASE_HELD', call('claim_workflow', [arg('wf-1'), arg('w2'), '1', '8000']), 'LEASE_HELD');
expectError('stale expected version → VERSION_CONFLICT', call('claim_workflow', [arg('wf-1'), arg('w2'), '0', '8000']), 'VERSION_CONFLICT');

// --- heartbeat + update ------------------------------------------------------------------------
check('w1 heartbeat', call('heartbeat_workflow', [arg('wf-1'), arg('w1'), String(tok1), '8000']).ok);
check('  heartbeat does not bump version', wf('wf-1').version === 1);
expectError('heartbeat by w2 with w1 token → LEASE_HELD', call('heartbeat_workflow', [arg('wf-1'), arg('w2'), String(tok1), '8000']), 'LEASE_HELD');
expectError('heartbeat with wrong token → STALE_FENCING_TOKEN', call('heartbeat_workflow', [arg('wf-1'), arg('w1'), String(tok1 + 5), '8000']), 'STALE_FENCING_TOKEN');
check('w1 update → triage with incidents + plan', call('update_workflow', [arg('wf-1'), '1', String(tok1), arg('triage'), jsonArg({ incident_ids: ['inc-1', 'inc-2'], plan_id: 'plan-1', note: 'x' })]).ok);
w = wf('wf-1');
check('  v2, stage triage, plan_id set', w.version === 2 && w.stage === 'triage' && w.plan_id === 'plan-1', `v${w.version} ${w.stage} ${w.plan_id}`);
check('  workflow_incident rows = inc-1, inc-2', sql(`SELECT * FROM workflow_incident WHERE workflow_id = 'wf-1'`).map((l) => l.incident_id).sort().join() === 'inc-1,inc-2');
check('w1 update: plan_id null clears, incident list shrinks', call('update_workflow', [arg('wf-1'), '2', String(tok1), arg('plan'), jsonArg({ incident_ids: ['inc-1'], plan_id: null })]).ok);
w = wf('wf-1');
check('  plan cleared; workflow_incident = inc-1', w.plan_id === null && sql(`SELECT * FROM workflow_incident WHERE workflow_id = 'wf-1'`).map((l) => l.incident_id).join() === 'inc-1');
expectError('bad stage → INVALID_PAYLOAD', call('update_workflow', [arg('wf-1'), '3', String(tok1), arg('sleeping'), jsonArg({})]), 'INVALID_PAYLOAD');

// --- expiry → takeover → stale owner fenced out -------------------------------------------------
console.log('      (waiting 9 s for w1’s lease to expire)');
await sleep(9000);
expectError('expired lease: w1 heartbeat → LEASE_EXPIRED', call('heartbeat_workflow', [arg('wf-1'), arg('w1'), String(tok1), '8000']), 'LEASE_EXPIRED');
check('w2 takes over the expired lease', call('claim_workflow', [arg('wf-1'), arg('w2'), '3', '8000']).ok);
w = wf('wf-1');
const tok2 = Number(w.fencing_token);
check('  owner w2, newer token, attempt 2, v4', w.lease_owner === 'w2' && tok2 > tok1 && w.attempt === 2 && w.version === 4, `${w.lease_owner} t${tok1}→${tok2} a${w.attempt} v${w.version}`);
expectError('stale owner w1 update (current version, old token) → STALE_FENCING_TOKEN', call('update_workflow', [arg('wf-1'), '4', String(tok1), arg('execute'), jsonArg({})]), 'STALE_FENCING_TOKEN');
expectError('stale owner w1 update (old version) → VERSION_CONFLICT', call('update_workflow', [arg('wf-1'), '3', String(tok1), arg('execute'), jsonArg({})]), 'VERSION_CONFLICT');
check('w2 update works', call('update_workflow', [arg('wf-1'), '4', String(tok2), arg('execute'), jsonArg({ current_command_key: 'ck-1' })]).ok);
check('  current_command_key set', wf('wf-1').current_command_key === 'ck-1');

// --- cancel_action with the workflow token (§0.11 #13) -----------------------------------------
const r = run();
const cmd = {
  schema_version: '1.1.0', run_id: RUN, action_id: 'act-wf-kr', command_key: 'wf-kr-job-b', workflow_id: 'wf-1', plan_id: 'plan-1',
  incident_ids: ['inc-1'], operation: 'keep_running', target_resource_id: 'job-b', job_id: 'job-b', arguments: {},
  depends_on_command_keys: [], expected_decision_epoch: r.decision_epoch, expected_resource_versions: {}, requested_sim_time_ms: r.sim_time_ms,
};
call('request_action', [jsonArg(cmd)]);
expectError('cancel with the expired w1 token → STALE_FENCING_TOKEN', call('cancel_action', [arg('wf-kr-job-b'), arg('SUPERSEDED'), String(tok1)]), 'STALE_FENCING_TOKEN');
check('cancel a requested action with the live workflow token', call('cancel_action', [arg('wf-kr-job-b'), arg('SUPERSEDED'), String(tok2)]).ok);
check('  cancelled', sql(`SELECT * FROM action WHERE command_key = 'wf-kr-job-b'`)[0]?.status === 'cancelled');

// Tokens come from one global sequence: an action claimed now can't reuse w1's (stale) token, so
// w1's token can never pass cancel_action's "own action token" path.
call('request_action', [jsonArg({ ...cmd, action_id: 'act-wf-kr2', command_key: 'wf-kr2-job-b' })]);
call('claim_action', [arg('wf-kr2-job-b'), '1', arg('w2')]);
const actTok = Number(sql(`SELECT * FROM action WHERE command_key = 'wf-kr2-job-b'`)[0]?.lease_token);
check('action token is fresh in the shared sequence (≠ any workflow token)', actTok > tok2 && actTok !== tok1, `w1 ${tok1}, w2 ${tok2}, action ${actTok}`);
expectError('  stale w1 token can’t cancel it', call('cancel_action', [arg('wf-kr2-job-b'), arg('SUPERSEDED'), String(tok1)]), 'STALE_FENCING_TOKEN');
call('cancel_action', [arg('wf-kr2-job-b'), arg('TEST_DONE'), String(actTok)]);

// --- symptoms ----------------------------------------------------------------------------------
const sym = (over) => ({ symptom_id: 'sym-1', run_id: RUN, resource_id: 'gpu-r3-n1-0', first_seen_sim_ms: 1000, last_seen_sim_ms: 1000, kind: 'gpu_temp_high', severity: 'warning', evidence_event_ids: ['evt-1'], status: 'open', ...over });
check('upsert_symptoms', call('upsert_symptoms', [jsonArg([sym({}), sym({ symptom_id: 'sym-2', resource_id: 'gpu-r3-n1-1' })])]).ok);
check('repeat with later first_seen / last_seen', call('upsert_symptoms', [jsonArg([sym({ first_seen_sim_ms: 9000, last_seen_sim_ms: 9000, status: 'active' })])]).ok);
const s1 = sql(`SELECT * FROM symptom WHERE symptom_id = 'sym-1'`)[0];
check('  first_seen preserved, last_seen/status updated', s1.first_seen_sim_ms === 1000 && s1.last_seen_sim_ms === 9000 && s1.status === 'active');
expectError('bad severity → INVALID_PAYLOAD', call('upsert_symptoms', [jsonArg([sym({ severity: 'bad' })])]), 'INVALID_PAYLOAD');

// --- incidents + links -------------------------------------------------------------------------
const inc = { schema_version: '1.1.0', run_id: RUN, incident_id: 'inc-1', state: 'open', severity: 'high', title: 'Loop A cooling degraded', hypothesis: 'pump-a degraded', confidence: 0.8, opened_sim_time_ms: 1000, updated_sim_time_ms: 1000, version: 1 };
const link = (kind, id) => ({ schema_version: '1.1.0', run_id: RUN, incident_id: 'inc-1', linked_id: id, link_kind: kind, reason: `${kind} ${id}` });
const links = [link('symptom', 'sym-1'), link('symptom', 'sym-2'), link('resource', 'pump-a'), link('workflow', 'wf-1')];
check('upsert_incident with 4 links', call('upsert_incident', [jsonArg(inc), jsonArg(links)]).ok);
check('repeat upsert (same links) + state change', call('upsert_incident', [jsonArg({ ...inc, state: 'mitigating', version: 2 }), jsonArg(links)]).ok);
const counts = ['incident_symptom', 'incident_resource'].map((tb) => sql(`SELECT * FROM ${tb} WHERE incident_id = 'inc-1'`).length);
check('  links not duplicated (2 symptom, 1 resource)', counts.join() === '2,1', counts.join());
check('  incident updated', sql(`SELECT * FROM incident WHERE incident_id = 'inc-1'`)[0]?.state === 'mitigating');
expectError('link for another incident → INVALID_PAYLOAD', call('upsert_incident', [jsonArg(inc), jsonArg([{ ...link('resource', 'pump-b'), incident_id: 'inc-9' }])]), 'INVALID_PAYLOAD');
expectError('bad Incident → INVALID_PAYLOAD', call('upsert_incident', [jsonArg({ ...inc, severity: 'apocalyptic' }), jsonArg([])]), 'INVALID_PAYLOAD');

// --- plan --------------------------------------------------------------------------------------
const plan = { schema_version: '1.1.0', plan_id: 'plan-1', run_id: RUN, workflow_id: 'wf-1', incident_ids: ['inc-1'], based_on_decision_epoch: r.decision_epoch, assumptions: ['pump-a stays degraded'], command_keys: ['ck-1'], expected_completion_delay_sim_s: 150, expected_lost_work_units: 0, expected_gpu_busy_waste_s: 30, failure_risk_estimate: 0.1, explanation: 'checkpoint then move job-a' };
check('submit_plan', call('submit_plan', [jsonArg(plan)]).ok);
const pl = sql(`SELECT * FROM plan WHERE plan_id = 'plan-1'`)[0];
check('  stored as proposed, no action created', pl?.status === 'proposed' && sql(`SELECT * FROM action WHERE command_key = 'ck-1'`).length === 0);
expectError('bad PlanCandidate → INVALID_PAYLOAD', call('submit_plan', [jsonArg({ ...plan, command_keys: [] })]), 'INVALID_PAYLOAD');

// --- agent feed (F-NV1) ------------------------------------------------------------------------
const ev = { agent_event_id: 'ae-1', run_id: RUN, workflow_id: 'wf-1', incident_id: 'inc-1', stage: 'diagnose', summary: '24 GPUs on racks 2–4 + pump A low → one incident.', evidence_ids: ['evt-1'], tool_calls: [{ tool: 'get_evidence', args_summary: 'inc-1, 120 s', result_summary: '24 hot GPUs', actor: 'code' }], actor: 'nemotron', sim_time_ms: r.sim_time_ms, observed_unix_ms: Date.now() };
check('publish_agent_event', call('publish_agent_event', [jsonArg(ev)]).ok);
check('repeat publish is a no-op', call('publish_agent_event', [jsonArg({ ...ev, summary: 'changed' })]).ok);
const ae = sql(`SELECT * FROM agent_event WHERE agent_event_id = 'ae-1'`);
check('  one row, actor nemotron, tool_calls stored, first summary kept', ae.length === 1 && ae[0].actor === 'nemotron' && ae[0].tool_calls_json.includes('get_evidence') && ae[0].summary.startsWith('24 GPUs'));
expectError('unknown field (e.g. raw reasoning) → INVALID_PAYLOAD', call('publish_agent_event', [jsonArg({ ...ev, agent_event_id: 'ae-2', chain_of_thought: '…' })]), 'INVALID_PAYLOAD');
expectError('bad stage → INVALID_PAYLOAD', call('publish_agent_event', [jsonArg({ ...ev, agent_event_id: 'ae-3', stage: 'dream' })]), 'INVALID_PAYLOAD');
// `constructor` / `__proto__` are own keys after JSON.parse and must be rejected like any unknown field.
const sneaky = `{"agent_event_id":"ae-5","run_id":"${RUN}","workflow_id":null,"incident_id":null,"stage":"triage","summary":"s","evidence_ids":[],"tool_calls":[{"tool":"x","args_summary":"x","result_summary":"x","constructor":{"chain_of_thought":"private"}}],"sim_time_ms":1,"observed_unix_ms":1}`;
expectError('tool call with `constructor` field → INVALID_PAYLOAD', call('publish_agent_event', [JSON.stringify(sneaky)]), 'INVALID_PAYLOAD');
expectError('`__proto__` field → INVALID_PAYLOAD', call('publish_agent_event', [JSON.stringify(sneaky.replace('"constructor"', '"__proto__"'))]), 'INVALID_PAYLOAD');
check('  nothing stored for ae-5', sql(`SELECT * FROM agent_event WHERE agent_event_id = 'ae-5'`).length === 0);
check('event without actor defaults to code', call('publish_agent_event', [jsonArg({ ...ev, agent_event_id: 'ae-4', actor: undefined })]).ok && sql(`SELECT * FROM agent_event WHERE agent_event_id = 'ae-4'`)[0]?.actor === 'code');

done();
