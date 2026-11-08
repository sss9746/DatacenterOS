import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ActionDetail, AgentEventInput, Evidence, PlanRecord, WorkflowRecord } from '@dcos/db-client';
import type { ActionCommand, ActionStatus, Incident } from '@dcos/contracts';
import { buildWorkflowViews, type WorkflowView } from '../src/components/workflows/workflow-view';
import { decisionTrace, optionName, traceActors, type CostStep, type DecisionStep, type DetectStep, type ExecuteStep, type OptionsStep, type SafetyStep, type VerifyStep } from '../src/components/decision/decision-trace';
import { DecisionTrace } from '../src/components/decision/DecisionTrace';
import { openDashboard } from '../src/data/dashboard';

const wf = (patch: Partial<WorkflowRecord> = {}): WorkflowRecord => ({
  workflow_id: 'wf-1', run_id: 'run-1', stage: 'execute', state: {}, incident_ids: ['inc-1'], plan_id: 'plan-1', current_command_key: null,
  last_processed_event_seq: 0, attempt: 1, lease_owner: 'agent-1', lease_expires_unix_ms: 0, fencing_token: 1n, updated_at_unix_ms: 0, version: 1, ...patch,
});
let n = 0;
const ev = (patch: Partial<AgentEventInput>): AgentEventInput => ({
  agent_event_id: `e-${n++}`, run_id: 'run-1', workflow_id: 'wf-1', incident_id: 'inc-1', stage: 'plan', summary: 's', evidence_ids: [], tool_calls: [], actor: 'code', sim_time_ms: 1000, observed_unix_ms: 0, ...patch,
});
const action = (status: ActionStatus['status'], patch: { key?: string; op?: ActionCommand['operation']; job?: string; due?: number | null; reason?: string | null; violations?: string[]; history?: ActionDetail['history']; safety?: ActionDetail['safety']; start_safety?: ActionDetail['start_safety']; attempt?: number; requested?: number } = {}): ActionDetail => {
  const key = patch.key ?? `k-${status}`;
  return {
    status: { schema_version: '1.1.0', run_id: 'run-1', action_id: `a-${key}`, command_key: key, status, attempt: patch.attempt ?? 1, updated_sim_time_ms: 0, result: patch.violations ? { violations: patch.violations } : {}, reason_code: patch.reason ?? null, version: 1 },
    command: { schema_version: '1.1.0', run_id: 'run-1', action_id: `a-${key}`, command_key: key, workflow_id: 'wf-1', plan_id: 'plan-1', incident_ids: ['inc-1'], operation: patch.op ?? 'checkpoint', target_resource_id: patch.job ?? 'job-a', job_id: patch.job ?? 'job-a', arguments: {}, depends_on_command_keys: [], expected_decision_epoch: 1, expected_resource_versions: {}, requested_sim_time_ms: patch.requested ?? 0 },
    claimed_by: null, due_sim_time_ms: patch.due ?? null, safety: patch.safety ?? null, start_safety: patch.start_safety ?? null, history: patch.history ?? [],
  };
};
const cand = (job_id: string, option: string, lost: number | null, waste: number | null, safety: string, chosen: boolean, extra: Record<string, unknown> = {}) =>
  ({ job_id, option, commands_summary: `${job_id}: ${option}`, predicted_lost_work_units: lost, predicted_work_deficit_units: null, predicted_gpu_busy_waste_s: waste, safety, violations: [], chosen, reason: `${chosen ? 'chosen' : 'rejected'}: ${option}`, decided_by: 'nemotron', snapshot_epoch: 3, as_of_sim_time_ms: 2000, ...extra });
const view = (w: WorkflowRecord, events: AgentEventInput[] = [], actions: ActionDetail[] = [], incidents: Incident[] = []): WorkflowView =>
  buildWorkflowViews({ workflows: [w], events, actionDetails: actions, incidents, snapshot: { clock: { sim_time_ms: 10_000 }, cooling: [], gpus: [], checkpoints: [], job_states: [] } as never })[0]!;
const step = <T>(v: WorkflowView, id: string, ctx = {}): T => decisionTrace(v, ctx).steps.find((s) => s.id === id) as T;

describe('decision trace: seven numbered steps, nothing invented', () => {
  it('always yields the seven steps in order and marks missing data as not recorded', () => {
    const t = decisionTrace(view(wf({ stage: 'idle', state: {}, incident_ids: [] })));
    expect(t.steps.map((s) => [s.index, s.id])).toEqual([[1, 'detect'], [2, 'options'], [3, 'cost'], [4, 'safety'], [5, 'decision'], [6, 'execute'], [7, 'verify']]);
    expect(t.steps.every((s) => s.recorded === false)).toBe(true);
    const verify = t.steps.find((s): s is VerifyStep => s.id === 'verify')!;
    expect(verify.outcome).toBe('pending');
    expect(verify.checks).toEqual([]);
    expect(verify.next_human_action).toBeNull();
  });

  it('Detect: incident facts from the incident row plus resource/symptom links; triage lines keep their actor', () => {
    const inc: Incident = { schema_version: '1.1.0', run_id: 'run-1', incident_id: 'inc-1', state: 'investigating', severity: 'high', title: 'Cooling degradation', hypothesis: 'shared loop', confidence: 0.8, opened_sim_time_ms: 500, updated_sim_time_ms: 500, version: 1 };
    const evidence = { links: [{ schema_version: '1.1.0', run_id: 'run-1', incident_id: 'inc-1', linked_id: 'pump-a', link_kind: 'resource', reason: '' }, { schema_version: '1.1.0', run_id: 'run-1', incident_id: 'inc-1', linked_id: 'sym-1', link_kind: 'symptom', reason: '' }, { schema_version: '1.1.0', run_id: 'run-1', incident_id: 'other', linked_id: 'gpu-x', link_kind: 'resource', reason: '' }] } as unknown as Evidence;
    const d = step<DetectStep>(view(wf(), [ev({ stage: 'diagnose', actor: 'nemotron', summary: 'grouped', tool_calls: [{ tool: 'get_incident_evidence', args_summary: '', result_summary: '', actor: 'code' }] })], [], [inc]), 'detect', { incidents: [inc], evidence });
    expect(d.recorded).toBe(true);
    expect(d.incidents[0]).toMatchObject({ title: 'Cooling degradation', severity: 'high', hypothesis: 'shared loop', opened_sim_time_ms: 500, resources: ['pump-a'], symptoms: ['sym-1'] });
    expect(d.triage).toEqual([{ actor: 'nemotron', summary: 'grouped', sim_time_ms: 1000, stage: 'diagnose', tools: ['get_incident_evidence'] }]);
  });

  it('Options: every persisted candidate per job, plain-English names, null metrics stay null, lowest-cost rows flagged', () => {
    const w = wf({ state: { candidates: [
      cand('job-a', 'checkpoint', 0, 30, 'allow', true), cand('job-a', 'keep_running', 410, 0, 'not_checked', false), cand('job-a', 'power_cap', 0, 95, 'allow', false),
      cand('job-b', 'checkpoint_then_migrate', 12.5, 120, 'allow', true), cand('job-b', 'migrate_restart', null, null, 'deny', false, { violations: ['DEST_GPU_UNHEALTHY'] }),
    ] } });
    const o = step<OptionsStep>(view(w), 'options');
    expect(o.source).toBe('workflow_state');
    expect(o.show_deficit).toBe(false);
    expect(o.jobs.map((j) => j.job)).toEqual(['job-a', 'job-b']);
    const a = o.jobs[0]!.rows;
    expect(a.map((r) => r.name)).toEqual(['Checkpoint', 'Keep running', 'Power cap']);
    expect(a.map((r) => r.lowest_cost)).toEqual([true, false, true]);
    expect(a[1]).toMatchObject({ lost_wu: 410, gpu_waste_s: 0, keep_running: true, chosen: false, safety: 'not_checked', safety_label: 'Not checked' });
    const b = o.jobs[1]!.rows;
    expect(b[0]).toMatchObject({ name: 'Checkpoint, then migrate', lost_wu: 12.5, chosen: true });
    expect(b[1]).toMatchObject({ name: 'Migrate and restart', lost_wu: null, gpu_waste_s: null, lowest_cost: false, safety: 'deny', violations: [{ code: 'DEST_GPU_UNHEALTHY', text: 'A destination GPU is unhealthy.' }] });
  });

  it('Options: shows the work-deficit column only when some candidate carries a number', () => {
    const o = step<OptionsStep>(view(wf({ state: { candidates: [cand('job-a', 'checkpoint', 0, 1, 'allow', true, { predicted_work_deficit_units: 4 })] } })), 'options');
    expect(o.show_deficit).toBe(true);
    expect(o.jobs[0]!.rows[0]!.deficit_wu).toBe(4);
  });

  it('Options: two options of one job with the same kind get distinct keys and destination-qualified names', () => {
    const w = wf({ state: { candidates: [cand('job-b', 'power_cap', 0, 40, 'allow', true), cand('job-b', 'migrate_restart', 0, 120, 'allow', false, { commands_summary: 'job-b: migrate_restart r8' }), cand('job-b', 'migrate_restart', null, null, 'deny', false, { commands_summary: 'job-b: migrate_restart r7' })] } });
    const rows = step<OptionsStep>(view(w), 'options').jobs[0]!.rows;
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
    expect(rows.slice(1).map((r) => r.name)).toEqual(['Migrate and restart → r8', 'Migrate and restart → r7']);
  });

  it('Cost: bars scale to the costliest option; the saving vs keep running appears only when both numbers exist', () => {
    const w = wf({ state: { candidates: [cand('job-a', 'checkpoint', 10, 30, 'allow', true), cand('job-a', 'keep_running', 410, 0, 'not_checked', false), cand('job-b', 'power_cap', 0, 40, 'allow', true), cand('job-b', 'keep_running', null, null, 'not_checked', false)] } });
    const c = step<CostStep>(view(w), 'cost');
    expect(c.recorded).toBe(true);
    expect(c.jobs[0]!.bars.map((b) => b.width_pct)).toEqual([2, 100]);
    expect(c.jobs[0]!.saving).toEqual({ chosen: 'Checkpoint', chosen_wu: 10, keep_wu: 410, saved_wu: 400 });
    expect(c.jobs[1]!.bars[1]!.width_pct).toBeNull();
    expect(c.jobs[1]!.saving).toBeNull();
  });

  it('Safety: every option’s verdict with violations in plain English, plus the ledger’s request-time and start-time checks and BLOCKED', () => {
    const w = wf({ state: { candidates: [cand('job-b', 'migrate_restart', 0, 120, 'deny', false, { violations: ['DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT'] }), cand('job-b', 'power_cap', 0, 40, 'needs_approval', true, { violations: ['HIGH_PRIORITY_JOB_DISRUPTION'] })] } });
    const actions = [
      action('failed', { key: 'move', op: 'migrate_restart', job: 'job-b', reason: 'SAFETY_REJECTED', violations: ['STALE_DECISION_EPOCH'], safety: { decision: 'deny', violations: ['STALE_DECISION_EPOCH'], checked_decision_epoch: 2, evidence: {} } }),
      action('succeeded', { key: 'cap', op: 'power_cap', job: 'job-b', safety: { decision: 'allow', violations: [], checked_decision_epoch: 2, evidence: {} }, start_safety: { decision: 'allow', violations: [], checked_decision_epoch: null, evidence: {} } }),
    ];
    const s = step<SafetyStep>(view(w, [], actions), 'safety');
    expect(s.summary).toBe('1 denied · 1 need approval · 1 BLOCKED in the ledger');
    // Persisted options come chosen-first per job, so the denied migrate is second.
    expect(s.options.map((r) => r.safety)).toEqual(['needs_approval', 'deny']);
    expect(s.options[1]!.violations).toEqual([{ code: 'DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT', text: 'The destination rack has too little thermal headroom for this placement.' }]);
    expect(s.ledger[0]).toMatchObject({ blocked: true, reason_code: 'SAFETY_REJECTED', request: { decision: 'deny', checked_decision_epoch: 2, violations: [{ code: 'STALE_DECISION_EPOCH', text: 'The cluster changed after the plan was made. A fresh plan is needed.' }] }, start: null });
    expect(s.ledger[1]).toMatchObject({ blocked: false, request: { decision: 'allow' }, start: { decision: 'allow', checked_decision_epoch: null } });
  });

  it('Safety: parses event-only rounds ("denied: CODE") when no candidates were persisted', () => {
    const events = [ev({ stage: 'plan', tool_calls: [
      { tool: 'simulate_plan', args_summary: 'job-b: migrate_restart r6', result_summary: 'lost 0 wu · delay 120 s', actor: 'code' }, { tool: 'evaluate_safety', args_summary: '{"option_id":"job-b:move:r6"}', result_summary: 'denied: DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT', actor: 'code' },
      { tool: 'simulate_plan', args_summary: 'job-b: keep_running', result_summary: 'lost 180 wu · delay 0 s', actor: 'code' }, { tool: 'evaluate_safety', args_summary: '{"option_id":"job-b:keep"}', result_summary: 'allowed', actor: 'code' },
      { tool: 'choose_options', args_summary: '{}', result_summary: 'job-b:move:r6', actor: 'nemotron' },
    ] })];
    const s = step<SafetyStep>(view(wf(), events), 'safety');
    expect(s.options.map((r) => [r.name, r.safety, r.violations.map((v) => v.code)])).toEqual([['Move → r6', 'deny', ['DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT']], ['Keep running', 'allow', []]]);
    expect(step<OptionsStep>(view(wf(), events), 'options').source).toBe('events');
  });

  it('Decision: the chosen option per job with its recorded actor, bounded reason and snapshot epoch; the selected plan row; the replan', () => {
    const w = wf({ stage: 'execute', plan_id: 'plan-2', state: { attempt: 2, superseded: true, previous_plan_id: 'plan-1', reason: 'destination failed', candidates: [cand('job-a', 'checkpoint', 0, 30, 'allow', true), cand('job-b', 'power_cap', 0, 40, 'allow', true, { decided_by: 'code' }), cand('job-b', 'keep_running', 180, 0, 'not_checked', false)] } });
    const plan = { plan_id: 'plan-2', workflow_id: 'wf-1', based_on_decision_epoch: 3, explanation: 'cap in place', expected_lost_work_units: 0, expected_gpu_busy_waste_s: 40, command_keys: ['a', 'b'] } as unknown as PlanRecord;
    const d = step<DecisionStep>(view(w), 'decision', { plans: [plan] });
    expect(d.lines.map((l) => [l.job, l.name, l.actor, l.reason, l.snapshot_epoch, l.as_of_sim_time_ms])).toEqual([['job-a', 'Checkpoint', 'nemotron', 'chosen: checkpoint', 3, 2000], ['job-b', 'Power cap', 'code', 'chosen: power_cap', 3, 2000]]);
    expect(d.plan).toEqual({ plan_id: 'plan-2', explanation: 'cap in place', based_on_decision_epoch: 3, lost_wu: 0, gpu_waste_s: 40, commands: 2 });
    expect(d.replan).toEqual({ reason: 'destination failed', previous_plan_id: 'plan-1' });
    expect(d.attempt).toBe(2);
    expect(traceActors(decisionTrace(view(w)))).toEqual({ nemotron: 1, code: 1 });
  });

  it('Execute: commands in request order with lifecycle, start/due, retries and the resume reconcile marker', () => {
    const actions = [
      action('succeeded', { key: 'ckpt', requested: 100, due: 3000, history: [{ status: 'requested', version: 1, sim_time_ms: 100, observed_unix_ms: 0, reason_code: null, detail: {} }, { status: 'running', version: 2, sim_time_ms: 200, observed_unix_ms: 0, reason_code: null, detail: {} }, { status: 'succeeded', version: 3, sim_time_ms: 3000, observed_unix_ms: 0, reason_code: null, detail: {} }] }),
      action('failed', { key: 'move', op: 'migrate_restart', job: 'job-b', requested: 50, reason: 'SAFETY_REJECTED', attempt: 2 }),
    ];
    const events = [ev({ stage: 'execute', tool_calls: [{ tool: 'get_action_status', args_summary: 'ckpt', result_summary: 'succeeded → skip', actor: 'code' }] })];
    const e = step<ExecuteStep>(view(wf({ state: { resumed: { by_worker: 'agent-2', at_sim_time_ms: 2500, action: 'resumed_execute', previous_owner: 'agent-1' } } }), events, actions), 'execute');
    expect(e.lines.map((l) => l.command_key)).toEqual(['move', 'ckpt']);
    expect(e.lines[0]).toMatchObject({ status: 'BLOCKED', blocked: true, attempt: 2, started_sim_time_ms: null, due_sim_time_ms: null, reconciled: null });
    expect(e.lines[1]).toMatchObject({ status: 'succeeded', started_sim_time_ms: 200, due_sim_time_ms: 3000, reconciled: 'succeeded → skip', lifecycle: [{ status: 'requested', sim_time_ms: 100 }, { status: 'running', sim_time_ms: 200 }, { status: 'succeeded', sim_time_ms: 3000 }] });
    expect(e.resumed).toEqual({ by: 'agent-2', from: 'agent-1', sim_time_ms: 2500 });
  });

  it('Verify: persisted checks with ledger evidence, window, jobs, placements, unresolved items and the next human step', () => {
    const verification = {
      version: 1, source: 'code', verified: false, escalate: true, outcome: 'operator_review', handoff: 'Not verified.', as_of_sim_time_ms: 9000, verification_interval_sim_ms: [4000, 9000],
      evidence: { incident_ids: ['inc-1'], hypotheses: [], decision_epoch: 3, max_gpu_evidence_age_sim_ms: 0 },
      affected_jobs: [{ job_id: 'job-b', status: 'running', progress_work_units: 120, durable_work_units: 100, racks: ['r8'] }],
      actions: { completed: ['move'], verified: [], unverified: ['move'], blocked: [], failed: [], not_run: [] },
      checkpoint_outcome: [], placement_outcome: [{ job_id: 'job-b', gpu_ids: ['gpu-r8-n1-0'], racks: ['r8'] }],
      unresolved_infrastructure: ['pump-a degraded'], remaining_risk: 'loop A still warm', next_human_action: 'service pump-a',
      checks: [{ command_key: 'move', operation: 'migrate_restart', ok: false, note: 'migrate_restart job-b unverified (progress not increasing)' }],
    };
    const actions = [action('succeeded', { key: 'move', op: 'migrate_restart', job: 'job-b', history: [{ status: 'succeeded', version: 2, sim_time_ms: 5000, observed_unix_ms: 0, reason_code: null, detail: { verification: { verified: false, note: 'x', problems: ['progress not increasing'], progress: '100→100 wu', destination_racks: ['r8'] } } }] })];
    const v = step<VerifyStep>(view(wf({ stage: 'escalated', state: { verification } }), [], actions), 'verify');
    expect(v).toMatchObject({ outcome: 'escalated', outcome_label: 'Escalated', persisted_outcome: 'operator_review', window: { from: 4000, to: 9000 }, unresolved: ['pump-a degraded'], next_human_action: 'service pump-a', remaining_risk: 'loop A still warm' });
    expect(v.checks[0]).toMatchObject({ command_key: 'move', ok: false, label: 'migrate restart job-b', evidence: [{ key: 'progress', value: '100→100 wu' }, { key: 'destination racks', value: 'r8' }] });
    expect(v.jobs).toEqual([{ job: 'job-b', status: 'running', progress_wu: 120, durable_wu: 100, racks: ['r8'] }]);
    expect(v.placements).toEqual([{ job: 'job-b', gpus: ['gpu-r8-n1-0'], racks: ['r8'] }]);
    expect(v.summary).toBe('Escalated · 0/1 checks passed');
  });

  it('Verify: a verified handoff reads Recovered; a closed row without one is not recorded', () => {
    const ok = step<VerifyStep>(view(wf({ stage: 'done', state: { verification: { verified: true, escalate: false, outcome: 'recovered', handoff: 'ok', as_of_sim_time_ms: 9000, checks: [{ command_key: 'c', operation: 'cordon_gpu', ok: true, note: 'cordoned' }] } } })), 'verify');
    expect(ok.outcome).toBe('recovered');
    expect(ok.checks[0]).toMatchObject({ ok: true, label: 'cordon gpu', evidence: [] });
    expect(step<VerifyStep>(view(wf({ stage: 'done' })), 'verify').outcome).toBe('not_recorded');
  });

  it('names options from persisted kinds and event ids alike', () => {
    const base = { simulated: '', reported: '', lost_wu: null, delay_s: null, actor: null, safety: null, blocked: false, chosen: null } as const;
    expect(optionName({ ...base, option_id: 'job-b:move:r7' })).toBe('Move → r7');
    expect(optionName({ ...base, option_id: 'gpu-r7-n1-0:cordon' })).toBe('Cordon GPU');
    expect(optionName({ ...base, option_id: 'job-a:ckpt', persisted: { job_id: 'job-a', option: 'checkpoint+power_cap', deficit_wu: null, gpu_waste_s: null, safety: 'allow', violations: [], reason: null, snapshot_epoch: null, as_of_sim_time_ms: null } })).toBe('Checkpoint + Power cap');
  });
});

describe('DecisionTrace component over the scripted recovery example', () => {
  it('renders all seven steps open, the deny and BLOCKED verdicts, the saving line, and the verified check', async () => {
    const store = await openDashboard('mock', 'recovery', { uri: '', db: '' });
    store.start();
    await new Promise((r) => setTimeout(r, 25));
    const { workflows, events, actionDetails, incidents, snapshot, plans, evidence } = store.state;
    store.close();
    const [cool, xid] = buildWorkflowViews({ workflows, events, actionDetails, incidents, snapshot }) as [WorkflowView, WorkflowView];
    const html = renderToStaticMarkup(createElement(DecisionTrace, { view: cool, plans, incidents, evidence, example: true }));
    expect(html.match(/<details open=""/g)).toHaveLength(7);
    for (const title of ['Detect', 'Options considered', 'Cost comparison', 'Safety check', 'Decision', 'Execute', 'Verify']) expect(html).toContain(title);
    expect(html).toContain('Denied');
    expect(html).toContain('Needs approval');
    expect(html).toContain('BLOCKED');
    // The replan replaced job-b's plan-1 entries (as the planner's mergeCandidates does), so the surviving deny is the r7 one.
    expect(html).toContain('A destination GPU is unhealthy.');
    expect(html).toContain('The cluster changed after the plan was made. A fresh plan is needed.');
    expect(html).toContain('saves <strong>410 wu</strong> vs keep running');
    expect(html).toContain('not simulated');
    expect(html).toContain('NEMOTRON (scripted)');
    expect(html).toContain('Not yet verified');
    const xidHtml = renderToStaticMarkup(createElement(DecisionTrace, { view: xid, plans, incidents, evidence, example: true }));
    expect(xidHtml).toContain('Recovered');
    expect(xidHtml).toContain('1/1 checks passed');
    expect(xidHtml).toContain('reconciled after restart');
    expect(xidHtml).toContain('service gpu-r7-n1-0');
  });
});
