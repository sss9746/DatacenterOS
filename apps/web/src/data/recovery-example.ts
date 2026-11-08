import type { AgentActor, AgentStage, MockDbClient, ToolCallSummary, WorkflowStage } from '@dcos/db-client';
import type { ActionCommand, Incident, PlanCandidate } from '@dcos/contracts';

/**
 * Scripted UI examples only. No model, planner, physics simulation or safety engine ran; never used by the live client
 * or evaluation. Every row is written through the real mock client APIs (workflow leases, plans, ledger, events), so
 * the dashboard derives the two workflows exactly as it would from the DB. Deterministic: the mock clock only moves
 * on the explicit `tick()` calls below.
 *
 * Story: a cooling workflow (checkpoint running, a move BLOCKED by a stale snapshot epoch, replanned to a power cap)
 * and an independent XID 79 workflow (cordon, agent lease lapse and resume, verified handoff with the GPU unrepaired).
 */
const V = '1.1.0' as const;
const LEASE_MS = 60 * 60 * 1000;
const EXAMPLE = '(example values)';

export async function loadRecoveryExample(client: MockDbClient) {
  client.loadSnapshot('pump_degraded');
  let snapshot = await client.getObservedSnapshot();
  const run = snapshot.run_id;
  let t = snapshot.clock.sim_time_ms;
  const epoch = async () => { snapshot = await client.getObservedSnapshot(); t = snapshot.clock.sim_time_ms; return snapshot.clock.decision_epoch; };
  const tick = async () => { client.tick(); await epoch(); };

  // ------------------------------------------------------------------ incidents
  const base = { schema_version: V, run_id: run, confidence: 0.85, opened_sim_time_ms: t, updated_sim_time_ms: t, version: 1 };
  const cooling: Incident = { ...base, incident_id: 'example-cooling', state: 'investigating', severity: 'high', title: 'Cooling degradation on loop A', hypothesis: 'Correlated heat across racks r2–r4 suggests a shared cooling problem.' };
  const xid: Incident = { ...base, incident_id: 'example-xid', state: 'investigating', severity: 'critical', title: 'Independent GPU fault on rack r7', hypothesis: 'XID 79 on a candidate destination requires a separate incident and a new placement.' };
  for (const [incident, ids] of [[cooling, ['pump-a', 'rack-r2', 'rack-r3', 'rack-r4']], [xid, ['gpu-r7-n1-0']]] as const) {
    await client.upsertIncident(incident, ids.map((id) => ({ schema_version: V, run_id: run, incident_id: incident.incident_id, linked_id: id, link_kind: 'resource' as const, reason: 'Scripted recovery example' })));
  }

  // ------------------------------------------------------------------ helpers over the real mock APIs
  let seq = 0;
  const publish = (workflowId: string | null, incidentId: string | null, stage: AgentStage, actor: AgentActor, summary: string, calls: ToolCallSummary[] = []) =>
    client.publishAgentEvent({ agent_event_id: `example-event-${String(seq++).padStart(2, '0')}`, run_id: run, workflow_id: workflowId, incident_id: incidentId, stage, actor, summary: `Example: ${summary}`, evidence_ids: [], tool_calls: calls, sim_time_ms: t, observed_unix_ms: Date.now() });
  const call = (tool: string, args: string, result: string, actor: AgentActor = 'code'): ToolCallSummary => ({ tool, args_summary: args, result_summary: result, actor });
  const option = (id: string, simulated: string, result: string, safety = 'allowed') => [call('simulate_plan', simulated, `${result} ${EXAMPLE}`), call('evaluate_safety', JSON.stringify({ option_id: id }), safety)];

  function workflow(id: string) {
    let version = 0;
    let token = 0n;
    let state: Record<string, unknown> = {};
    return {
      async claim(worker: string) { const lease = await client.claimWorkflow(id, worker, version, LEASE_MS); version = lease.workflow.version; token = lease.fencing_token; },
      async stage(stage: WorkflowStage, patch: Record<string, unknown>) { state = { ...state, ...patch }; version = (await client.updateWorkflow(id, version, token, stage, state)).version; },
      /** The owning agent stops heartbeating: its lease lapses now (no version bump, as in the DB). */
      async lapse(worker: string) { await client.heartbeatWorkflow(id, worker, token, 0); },
    };
  }
  const plan = (workflowId: string, planId: string, incidentId: string, keys: string[], lost: number, delay: number): PlanCandidate => ({
    schema_version: V, run_id: run, plan_id: planId, workflow_id: workflowId, incident_ids: [incidentId], based_on_decision_epoch: snapshot.clock.decision_epoch,
    assumptions: ['Example: scripted plan; no planner or physics simulation ran'], command_keys: keys as [string, ...string[]],
    expected_completion_delay_sim_s: delay, expected_lost_work_units: lost, expected_gpu_busy_waste_s: 0, failure_risk_estimate: 0, explanation: 'Example: scripted plan.',
  });
  const command = (workflowId: string, planId: string, incidentId: string, key: string, operation: ActionCommand['operation'], target: string, job: string | null, args: Record<string, unknown>, decisionEpoch: number): ActionCommand => ({
    schema_version: V, run_id: run, action_id: `act-${key}`, command_key: key, workflow_id: workflowId, plan_id: planId, incident_ids: [incidentId], operation, target_resource_id: target, job_id: job,
    arguments: args, depends_on_command_keys: [], expected_decision_epoch: decisionEpoch, expected_resource_versions: {}, requested_sim_time_ms: t,
  });
  const start = async (cmd: ActionCommand, worker: string) => {
    const requested = await client.requestAction(cmd);
    const claimed = await client.claimAction(cmd.command_key, requested.version, worker);
    await client.startAction(cmd.command_key, claimed.fencing_token);
    return [call('request_action', `${cmd.operation} ${cmd.job_id ?? cmd.target_resource_id}`, 'requested'), call('claim_action', cmd.command_key, 'claimed'), call('start_action', cmd.command_key, 'running')];
  };

  // ------------------------------------------------------------------ workflow 1: cooling (waiting, blocked, replanned)
  const coolWf = 'wf-example-cooling';
  const cool = workflow(coolWf);
  await publish(null, null, 'triage', 'code', '1 incident(s), 1 new: Cooling degradation on loop A');
  await cool.claim('example-agent-1');
  await cool.stage('diagnose', { incident_ids: [cooling.incident_id] });
  await publish(coolWf, cooling.incident_id, 'diagnose', 'nemotron', 'group the cooling symptoms on racks r2–r4 into one incident.', [call('get_incident_evidence', 'incident_ids: [example-cooling]', 'Example evidence: shared loop A and reduced pump capacity.', 'code')]);

  const plan1 = 'plan-example-cooling-1';
  const e0 = await epoch();
  const ckpt = command(coolWf, plan1, cooling.incident_id, 'example-cooling-1-ckpt-job-a', 'checkpoint', 'job-a', 'job-a', {}, e0);
  const r7 = snapshot.gpus.filter((g) => g.resource_id.startsWith('gpu-r7-')).map((g) => g.resource_id).slice(0, 8);
  const move = command(coolWf, plan1, cooling.incident_id, 'example-cooling-1-move-job-b', 'migrate_restart', 'job-b', 'job-b', { destination_gpu_ids: r7 }, e0);
  await cool.stage('plan', { plan_id: plan1, attempt: 1 });
  await client.submitPlan(plan(coolWf, plan1, cooling.incident_id, [ckpt.command_key, move.command_key], 0, 120));
  await publish(coolWf, cooling.incident_id, 'plan', 'nemotron', 'checkpoint job-a now, then move job-b to the cooler rack r7 (scripted choice).', [
    ...option('job-a:keep', 'job-a: keep_running', 'lost 410 wu · delay 0 s'),
    ...option('job-a:ckpt', 'job-a: checkpoint', 'lost 0 wu · delay 30 s'),
    ...option('job-a:cap', 'job-a: power_cap', 'lost 0 wu · delay 95 s'),
    ...option('job-b:move:r6', 'after job-a:ckpt→job-b: migrate_restart r6', 'lost 0 wu · delay 120 s · violations 1', 'denied: DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT'),
    ...option('job-b:move:r7', 'after job-a:ckpt→job-b: migrate_restart r7', 'lost 0 wu · delay 120 s'),
    call('choose_options', '{"jobs":2}', 'job-a:ckpt, job-b:move:r7', 'nemotron'),
    call('simulate_plan', 'job-a: checkpoint→job-b: migrate_restart', `lost 0 wu · delay 120 s ${EXAMPLE}`),
  ]);
  await publish(coolWf, cooling.incident_id, 'safety', 'code', 'BLOCKED by deterministic safety: job-b:move:r6 (DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT). Illustrative; no safety engine ran.', [call('evaluate_safety', 'job-b:move:r6', 'denied: DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT')]);
  await cool.stage('execute', { command_keys: [ckpt.command_key, move.command_key], current_command_key: ckpt.command_key });
  await publish(coolWf, cooling.incident_id, 'execute', 'code', 'job-a checkpoint running.', await start(ckpt, 'example-agent-1'));

  // An independent XID 79 lands on the planned destination: the snapshot epoch moves on.
  await client.injectFault({ schema_version: V, run_id: run, fault_id: 'example-fault-xid', target_resource_id: 'gpu-r7-n1-0', kind: 'gpu_xid_79', start_sim_time_ms: t, duration_sim_ms: null, severity: 1, parameters: {}, seed_offset: 0 });
  const e1 = await epoch();
  await publish(null, null, 'triage', 'code', '2 incident(s), 1 new: Independent GPU fault on rack r7');

  // The move was built on the old epoch: the mock ledger itself rejects it (failed + SAFETY_REJECTED).
  const blocked = await client.requestAction(move);
  await publish(coolWf, cooling.incident_id, 'execute', 'code', `job-b move to r7 ${blocked.status} (${blocked.reason_code ?? 'no reason'}): planned on an older snapshot epoch.`, [call('request_action', 'migrate_restart job-b', `${blocked.status}: ${blocked.reason_code ?? ''}`)]);

  const plan2 = 'plan-example-cooling-2';
  const cap = command(coolWf, plan2, cooling.incident_id, 'example-cooling-2-cap-job-b', 'power_cap', 'job-b', 'job-b', { power_limit_w: 500 }, e1);
  await cool.stage('replan', { previous_plan_id: plan1, superseded: true, plan_id: plan2, attempt: 2, kept_keys: [ckpt.command_key], reason: 'destination gpu-r7-n1-0 reported XID 79 and the move was rejected' });
  await publish(coolWf, cooling.incident_id, 'replan', 'code', `replanning ${plan1}: destination gpu-r7-n1-0 reported XID 79.`);
  await publish(coolWf, cooling.incident_id, 'replan', 'nemotron', 'keep the job-a checkpoint; cap job-b at 500 W instead of moving it (scripted choice).', [
    call('choose_options', '{"jobs":1}', 'job-b:cap', 'nemotron'),
    call('simulate_plan', 'job-b: power_cap', `lost 0 wu · delay 40 s ${EXAMPLE}`),
  ]);
  await client.submitPlan(plan(coolWf, plan2, cooling.incident_id, [cap.command_key], 0, 40));
  await publish(coolWf, cooling.incident_id, 'plan', 'code', `new plan ${plan2}: job-b -> power cap 500 W.`, [
    ...option('job-b:cap', 'after job-a:ckpt→job-b: power_cap', 'lost 0 wu · delay 40 s'),
    ...option('job-b:move:r8', 'after job-a:ckpt→job-b: migrate_restart r8', 'lost 0 wu · delay 120 s'),
    ...option('job-b:keep', 'after job-a:ckpt→job-b: keep_running', 'lost 180 wu · delay 0 s'),
  ]);
  await cool.stage('execute', { command_keys: [cap.command_key], current_command_key: cap.command_key });
  const capCalls = await start(cap, 'example-agent-1');
  await tick(); // the cap's due time (one step) passes; the 30 s checkpoint keeps running
  await cool.stage('execute', { current_command_key: ckpt.command_key });
  await publish(coolWf, cooling.incident_id, 'execute', 'code', 'job-b power_cap succeeded; waiting on the kept job-a checkpoint.', [...capCalls, call('get_action_status', cap.command_key, 'succeeded')]);

  // ------------------------------------------------------------------ workflow 2: XID 79 (cordon, resume, verified)
  const xidWf = 'wf-example-xid';
  const gpuWf = workflow(xidWf);
  await gpuWf.claim('example-agent-1');
  await gpuWf.stage('diagnose', { incident_ids: [xid.incident_id] });
  await publish(xidWf, xid.incident_id, 'diagnose', 'nemotron', 'keep the XID incident separate from the cooling incident.', [call('list_placement_candidates', 'job_id: job-b', 'Example: exclude gpu-r7-n1-0 from the next placement.')]);
  const plan3 = 'plan-example-xid-1';
  const cordon = command(xidWf, plan3, xid.incident_id, 'example-xid-1-cordon', 'cordon_gpu', 'gpu-r7-n1-0', null, {}, await epoch());
  await gpuWf.stage('plan', { plan_id: plan3, attempt: 1 });
  await client.submitPlan(plan(xidWf, plan3, xid.incident_id, [cordon.command_key], 0, 0));
  await publish(xidWf, xid.incident_id, 'plan', 'code', 'deterministic: gpu-r7-n1-0: cordon.', [
    ...option('gpu-r7-n1-0:cordon', 'gpu-r7-n1-0: cordon_gpu', 'lost 0 wu · delay 0 s'),
    ...option('gpu-r7-n1-0:escalate', 'gpu-r7-n1-0: escalate', 'lost 0 wu · delay 0 s'),
  ]);
  await gpuWf.stage('execute', { command_keys: [cordon.command_key], current_command_key: cordon.command_key });
  const cordonCalls = await start(cordon, 'example-agent-1');
  await tick();
  await publish(xidWf, xid.incident_id, 'execute', 'code', 'cordon_gpu gpu-r7-n1-0 succeeded.', [...cordonCalls, call('get_action_status', cordon.command_key, 'succeeded')]);

  // The first agent stops; a second one takes the lapsed lease and reconciles the ledger before continuing.
  await gpuWf.lapse('example-agent-1');
  await gpuWf.claim('example-agent-2');
  await publish(xidWf, xid.incident_id, 'execute', 'code', 'resumed after agent restart: cordon_gpu gpu-r7-n1-0 already succeeded (skipped), nothing left to run.', [call('get_action_status', cordon.command_key, 'succeeded → skip')]);
  const resumedAt = (await client.getObservedSnapshot()).clock.sim_time_ms;
  await gpuWf.stage('verify', { resumed: { by_worker: 'example-agent-2', at_sim_time_ms: resumedAt, action: 'resumed_verify', previous_owner: 'example-agent-1' }, resume_count: 1 });
  const note = 'gpu-r7-n1-0 still cordoned (not repaired), no jobs on it';
  await client.verifyAction(cordon.command_key, { verified: true, note: `Example: ${note}`, gpu_id: 'gpu-r7-n1-0', availability: 'cordoned', repaired: false });
  await publish(xidWf, xid.incident_id, 'verify', 'code', 'verified: 1/1 checks passed.', [call('verify_action', cordon.command_key, 'verified')]);
  const handoff = `Example: Recovery verified. ${note} [${cordon.command_key}]. Cordoned GPUs still need hardware service.`;
  // Same shape as the R3 verifier's OperatorHandoff (apps/agent/src/verify.ts), with scripted example values.
  await gpuWf.stage('done', { verification: {
    version: 1, source: 'code', verified: true, escalate: false, outcome: 'recovered', handoff, as_of_sim_time_ms: t,
    verification_interval_sim_ms: [Math.max(0, t - 10_000), t],
    evidence: { incident_ids: [xid.incident_id], hypotheses: [`${xid.incident_id}: ${xid.title} — ${xid.hypothesis}`], decision_epoch: (await client.getObservedSnapshot()).clock.decision_epoch, max_gpu_evidence_age_sim_ms: 0 },
    affected_jobs: [],
    actions: { completed: [cordon.command_key], verified: [cordon.command_key], unverified: [], blocked: [], failed: [], not_run: [] },
    checkpoint_outcome: [], placement_outcome: [],
    unresolved_infrastructure: ['Example: gpu-r7-n1-0 cordoned after XID 79; needs hardware service (not repaired)'],
    remaining_risk: 'Example: none for workloads; one fewer spare GPU until the cordoned GPU is serviced.',
    next_human_action: 'Example: service gpu-r7-n1-0, then uncordon it through the operator process.',
    checks: [{ command_key: cordon.command_key, operation: 'cordon_gpu', ok: true, note: `Example: ${note}` }],
  } });
  await publish(xidWf, xid.incident_id, 'verify', 'code', `handoff: ${handoff.replace(/^Example: /, '')}`);
  await client.upsertIncident({ ...xid, state: 'monitoring', version: 2, updated_sim_time_ms: t }, []);
}
