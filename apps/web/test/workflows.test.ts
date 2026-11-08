import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkflowBoard } from '../src/components/workflows/WorkflowBoard';
import type { ActionDetail, AgentEventInput, WorkflowRecord } from '@dcos/db-client';
import type { ActionCommand, ActionStatus } from '@dcos/contracts';
import { openDashboard } from '../src/data/dashboard';
import {
  actorCounts,
  actorSummary,
  blockedStepReason,
  buildWorkflowViews,
  candidateRound,
  groupActions,
  resumedWithoutDuplicate,
  latestCandidateRound,
  persistedCandidateOptions,
  readVerification,
  resumeEvidence,
  trackStageOf,
  waitText,
  type WorkflowView,
} from '../src/components/workflows/workflow-view';

const wf = (patch: Partial<WorkflowRecord> = {}): WorkflowRecord => ({
  workflow_id: 'wf-1', run_id: 'run-1', stage: 'execute', state: {}, incident_ids: ['inc-1'], plan_id: 'plan-1', current_command_key: null,
  last_processed_event_seq: 0, attempt: 1, lease_owner: 'agent-1', lease_expires_unix_ms: 0, fencing_token: 1n, updated_at_unix_ms: 0, version: 1, ...patch,
});
let n = 0;
const ev = (patch: Partial<AgentEventInput>): AgentEventInput => ({
  agent_event_id: `e-${n++}`, run_id: 'run-1', workflow_id: 'wf-1', incident_id: 'inc-1', stage: 'plan', summary: 's', evidence_ids: [], tool_calls: [], actor: 'code', sim_time_ms: 1000, observed_unix_ms: 0, ...patch,
});
const action = (status: ActionStatus['status'], patch: { key?: string; op?: ActionCommand['operation']; due?: number | null; reason?: string | null; violations?: string[]; history?: ActionDetail['history']; plan?: string; wfId?: string } = {}): ActionDetail => {
  const key = patch.key ?? `k-${status}`;
  return {
    status: { schema_version: '1.1.0', run_id: 'run-1', action_id: `a-${key}`, command_key: key, status, attempt: 1, updated_sim_time_ms: 0, result: patch.violations ? { violations: patch.violations } : {}, reason_code: patch.reason ?? null, version: 1 },
    command: { schema_version: '1.1.0', run_id: 'run-1', action_id: `a-${key}`, command_key: key, workflow_id: patch.wfId ?? 'wf-1', plan_id: patch.plan ?? 'plan-1', incident_ids: ['inc-1'], operation: patch.op ?? 'checkpoint', target_resource_id: 'job-a', job_id: 'job-a', arguments: {}, depends_on_command_keys: [], expected_decision_epoch: 1, expected_resource_versions: {}, requested_sim_time_ms: 0 },
    claimed_by: null, due_sim_time_ms: patch.due ?? null, safety: null, start_safety: null, history: patch.history ?? [],
  };
};
const view = (w: WorkflowRecord, events: AgentEventInput[] = [], actions: ActionDetail[] = [], simNow = 10_000): WorkflowView =>
  buildWorkflowViews({ workflows: [w], events, actionDetails: actions, incidents: [], snapshot: { clock: { sim_time_ms: simNow }, cooling: [], gpus: [], checkpoints: [], job_states: [] } as never })[0]!;

describe('stage mapping', () => {
  it('maps agent stages onto the six display steps', () => {
    expect(trackStageOf('diagnose')).toBe('diagnosis');
    expect(trackStageOf('plan')).toBe('compare');
    expect(trackStageOf('replan')).toBe('compare');
    expect(trackStageOf('verify')).toBe('verify');
  });
  it('uses the persisted stage as current and never marks unrecorded earlier steps as passed', () => {
    const v = view(wf({ stage: 'execute' }), [ev({ stage: 'diagnose' })]);
    const byId = Object.fromEntries(v.steps.map((s) => [s.id, s.state]));
    expect(v.current).toBe('execute');
    expect(byId).toMatchObject({ diagnosis: 'recorded', compare: 'no_event', safety: 'no_event', execute: 'current', verify: 'not_reached' });
    expect(v.steps.filter((s) => s.id === v.current)).toHaveLength(1);
  });
  it('shows replanning as an explicit state on the Compare step', () => {
    const v = view(wf({ stage: 'replan', state: { reason: 'destination failed', previous_plan_id: 'plan-1' } }));
    expect(v.current).toBe('compare');
    expect(v.status.kind).toBe('replanning');
    expect(v.status.detail).toBe('destination failed');
  });
});

describe('waiting vs verified', () => {
  it('waits on the current command and labels remaining time as an estimate', () => {
    const v = view(wf({ current_command_key: 'ck' }), [], [action('running', { key: 'ck', due: 40_000 })], 10_000);
    expect(v.status.kind).toBe('waiting');
    expect(v.waiting?.remaining_ms).toBe(30_000);
    expect(waitText(v.waiting!)).toMatch(/estimate/);
  });
  it('elapsed time is not success: a running action past its due time is still waiting, not completed', () => {
    const v = view(wf({ current_command_key: 'ck' }), [], [action('running', { key: 'ck', due: 5_000 })], 10_000);
    expect(v.status.kind).toBe('waiting');
    expect(v.waiting?.overdue).toBe(true);
    expect(v.groups.completed).toHaveLength(0);
    expect(v.steps.some((s) => s.state === 'verified')).toBe(false);
    expect(waitText(v.waiting!)).toMatch(/not success/);
  });
  it('ledger success without a verify record is not verified', () => {
    const v = view(wf({ stage: 'verify' }), [], [action('succeeded')]);
    expect(v.groups.completed[0]!.verified).toBeNull();
    expect(v.status.kind).toBe('in_progress');
    expect(v.steps.find((s) => s.id === 'verify')!.state).toBe('current');
  });
  it('only a persisted verification marks the workflow verified', () => {
    const verified = view(wf({ stage: 'done', state: { verification: { verified: true, escalate: false, handoff: 'Recovery verified.', as_of_sim_time_ms: 9000 } } }));
    expect(verified.status.kind).toBe('verified');
    expect(verified.steps.find((s) => s.id === 'verify')!.state).toBe('verified');
    expect(verified.verification?.asOf).toEqual({ from: null, to: 9000 });
    const closed = view(wf({ stage: 'done', state: { note: 'no open incidents left after restart' } }), [ev({ stage: 'execute' })]);
    expect(closed.status.kind).toBe('closed_unverified');
    expect(closed.steps.some((s) => s.state === 'verified')).toBe(false);
  });
  it('groups SAFETY_REJECTED failures as BLOCKED, separately from other failures', () => {
    const v = view(wf(), [], [action('failed', { key: 'b', reason: 'SAFETY_REJECTED', violations: ['STALE_DECISION_EPOCH'] }), action('failed', { key: 'f', reason: 'WAIT_TIMEOUT' })]);
    expect(v.groups.blocked.map((l) => l.reason)).toEqual(['STALE_DECISION_EPOCH']);
    expect(v.groups.failed.map((l) => l.reason)).toEqual(['WAIT_TIMEOUT']);
  });
  it('a BLOCKED ledger action puts the Safety step in a blocked state with the real violation as its reason', () => {
    const v = view(wf({ stage: 'execute' }), [ev({ stage: 'safety' })], [action('failed', { key: 'b', reason: 'SAFETY_REJECTED', violations: ['STALE_DECISION_EPOCH', 'DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT'] })]);
    expect(v.blockedReason).toBe('stale decision epoch +1');
    expect(v.steps.find((s) => s.id === 'safety')).toMatchObject({ state: 'blocked', stateLabel: 'blocked: stale decision epoch +1' });
    expect(v.steps.find((s) => s.id === 'execute')!.state).toBe('current');
    // No violation codes: the ledger reason code is used, never an invented one.
    expect(blockedStepReason(groupActions([action('failed', { key: 'b', reason: 'SAFETY_REJECTED' })]))).toBe('safety rejected');
  });
  it('other failures and clean workflows leave the Safety step untouched', () => {
    expect(view(wf(), [ev({ stage: 'safety' })], [action('failed', { key: 'f', reason: 'WAIT_TIMEOUT' })]).steps.find((s) => s.id === 'safety')!.state).toBe('recorded');
    expect(view(wf(), [], []).blockedReason).toBeNull();
    // The current step keeps its position even when an action was blocked.
    const cur = view(wf({ stage: 'safety' }), [], [action('failed', { key: 'b', reason: 'SAFETY_REJECTED', violations: ['X'] })]);
    expect(cur.steps.find((s) => s.id === 'safety')!.state).toBe('current');
    expect(cur.blockedReason).toBe('x');
  });
});

describe('escalation', () => {
  it('shows the persisted escalation reason as status and next human step', () => {
    const v = view(wf({ stage: 'escalated', state: { escalation_reason: 'replan limit (2) reached' } }), [ev({ stage: 'replan' })]);
    expect(v.status.kind).toBe('escalated');
    expect(v.status.detail).toBe('replan limit (2) reached');
    expect(v.current).toBe('compare');
    expect(v.steps.find((s) => s.id === 'compare')!.state).toBe('escalated');
    expect(v.nextStep).toEqual({ text: 'replan limit (2) reached', source: 'escalation_reason' });
    expect(v.terminal).toBe(true);
  });
  it('the handoff card never hides an empty side: escalation without a persisted handoff says what is missing', () => {
    const v = view(wf({ stage: 'escalated', state: { escalation_reason: 'replan limit (2) reached' } }), [ev({ stage: 'replan' })]);
    const html = renderToStaticMarkup(createElement(WorkflowBoard, { workflows: [v.workflow], events: v.events, actionDetails: [], incidents: [], snapshot: null, example: false, mode: 'mock' }));
    expect(html).toContain('wf-handoff-card wf-handoff-unknown');
    expect(html).toContain('Verification not recorded');
    expect(html).toContain('No verified actions recorded');
    expect(html).toContain('No unresolved infrastructure reported');
    expect(html).toContain('replan limit (2) reached');
    expect(html).not.toContain('Recovered');
    const ok = view(wf({ stage: 'done', state: { verification: { verified: true, source: 'code', outcome: 'recovered', handoff: 'Done.', as_of_sim_time_ms: 1, actions: { verified: ['k-succeeded'] }, unresolved_infrastructure: ['pump-a degraded'], next_human_action: 'Service pump-a' } } }), [], [action('succeeded')]);
    const okHtml = renderToStaticMarkup(createElement(WorkflowBoard, { workflows: [ok.workflow], events: [], actionDetails: ok.actions, incidents: [], snapshot: null, example: false, mode: 'mock' }));
    expect(okHtml).toContain('wf-handoff-recovered');
    expect(okHtml).toContain('checkpoint job-a');
    expect(okHtml).toContain('pump-a degraded');
    expect(okHtml).toContain('Service pump-a');
  });
  it('a verifier escalation without a reason says verification did not confirm recovery; next step stays unrecorded', () => {
    const v = view(wf({ stage: 'escalated', state: { verification: { verified: false, escalate: true, handoff: 'Needs operator review.', as_of_sim_time_ms: 1 } } }), [ev({ stage: 'verify' })]);
    expect(v.status.detail).toMatch(/did not confirm/);
    expect(v.nextStep).toBeNull();
  });
  it('reads an explicit next step and verification interval when the agent persists them', () => {
    expect(readVerification({ verification: { verified: true, as_of_sim_time_ms: [1, 2], next_human_step: 'Service pump A' } })).toMatchObject({ asOf: { from: 1, to: 2 }, nextStep: 'Service pump A' });
    expect(readVerification({})).toBeNull();
  });
});

describe('resumed only with evidence', () => {
  it('detects the resume reconciliation tool calls', () => {
    const r = resumeEvidence([ev({ stage: 'execute', tool_calls: [{ tool: 'get_action_status', args_summary: 'k1', result_summary: 'succeeded → skip' }] })]);
    expect(r?.source).toBe('reconcile_tool_calls');
  });
  it('ignores ordinary status polls, error retries and lease re-claims', () => {
    const events = [
      ev({ stage: 'execute', tool_calls: [{ tool: 'get_action_status', args_summary: 'k1', result_summary: 'succeeded' }] }),
      ev({ stage: 'execute', summary: 'continuing wf-1 from stage execute (retry 1/3 after an agent error)' }),
    ];
    expect(resumeEvidence(events)).toBeNull();
    expect(view(wf({ attempt: 3 }), events).resumed).toBeNull();
  });
  it('falls back to the resume event summary', () => {
    expect(resumeEvidence([ev({ stage: 'execute', summary: 'continuing wf-1 from stage plan after agent restart' })])?.source).toBe('event_summary');
  });
  it('claims "no duplicate action" only with evidence: a skip reconcile and a ledger without repeats', () => {
    const skip = [ev({ stage: 'execute', tool_calls: [{ tool: 'get_action_status', args_summary: 'k1', result_summary: 'succeeded → skip' }] })];
    const marker = { resumed: { by_worker: 'w2', at_sim_time_ms: 5, action: 'resumed_verify', previous_owner: 'w1' } };
    const once = [action('succeeded', { key: 'k1', op: 'cordon_gpu' })];
    expect(view(wf({ state: marker }), skip, once).resumedWithoutDuplicate).toBe(true);
    // Marker only, no reconcile evidence: the claim is omitted (null), not asserted.
    expect(view(wf({ state: marker }), [], once).resumedWithoutDuplicate).toBeNull();
    expect(resumedWithoutDuplicate([], once, null)).toBeNull();
    // A second ledger action for the same plan + operation + subject, or a retried attempt, contradicts the claim.
    const twice = [action('succeeded', { key: 'k1', op: 'cordon_gpu' }), action('succeeded', { key: 'k1-again', op: 'cordon_gpu' })];
    expect(view(wf({ state: marker }), skip, twice).resumedWithoutDuplicate).toBe(false);
    const retried = [{ ...once[0]!, status: { ...once[0]!.status, attempt: 2 } }];
    expect(view(wf({ state: marker }), skip, retried).resumedWithoutDuplicate).toBe(false);
    // Rendered copy follows the evidence.
    const html = (v: WorkflowView) => renderToStaticMarkup(createElement(WorkflowBoard, { workflows: [v.workflow], events: v.events, actionDetails: v.actions, incidents: [], snapshot: null, example: false, mode: 'mock' }));
    expect(html(view(wf({ state: marker }), skip, once))).toContain('no duplicate action');
    expect(html(view(wf({ state: marker }), [], once))).not.toContain('no duplicate action');
  });
});

describe('actor counts and candidates', () => {
  it('counts actual actors instead of a blanket brand label', () => {
    const c = actorCounts([ev({ actor: 'nemotron' }), ev({ actor: 'code' }), ev({ actor: 'code' }), ev({ actor: undefined })]);
    expect(actorSummary(c)).toBe('1 Nemotron · 2 code · 1 unlabelled');
    expect(actorSummary(actorCounts([]))).toBe('No events');
  });
  it('pairs simulate_plan with evaluate_safety and marks the published choice; never invents values', () => {
    const round = latestCandidateRound([
      ev({ stage: 'diagnose' }),
      ev({ stage: 'plan', actor: 'nemotron', tool_calls: [
        { tool: 'simulate_plan', args_summary: 'job-a: checkpoint', result_summary: 'lost 0 wu · delay 30 s', actor: 'code' },
        { tool: 'evaluate_safety', args_summary: '{"option_id":"job-a:ckpt"}', result_summary: 'allowed', actor: 'code' },
        { tool: 'simulate_plan', args_summary: 'job-a: keep_running', result_summary: 'opaque', actor: 'code' },
        { tool: 'evaluate_safety', args_summary: '{"option_id":"job-a:keep"}', result_summary: 'allowed', actor: 'code' },
        { tool: 'choose_options', args_summary: '{"jobs":1}', result_summary: 'job-a:ckpt (approval)', actor: 'nemotron' },
        { tool: 'simulate_plan', args_summary: 'job-a: checkpoint', result_summary: 'lost 0 wu · delay 30 s', actor: 'code' },
      ] }),
      ev({ stage: 'safety', tool_calls: [{ tool: 'evaluate_safety', args_summary: 'job-a:move:r6', result_summary: 'denied: DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT', actor: 'code' }] }),
    ])!;
    expect(round.options.map((o) => [o.option_id, o.chosen, o.blocked])).toEqual([['job-a:ckpt', true, false], ['job-a:keep', false, false], ['job-a:move:r6', false, true]]);
    expect(round.options[0]).toMatchObject({ lost_wu: 0, delay_s: 30 });
    expect(round.options[1]).toMatchObject({ lost_wu: null, delay_s: null, reported: 'opaque' });
    expect(round.combined?.reported).toBe('lost 0 wu · delay 30 s');
  });
  it('leaves the choice unknown when no option-level choice was published (deterministic fallback)', () => {
    const round = latestCandidateRound([ev({ stage: 'plan', summary: 'deterministic: job-a: checkpoint', tool_calls: [
      { tool: 'simulate_plan', args_summary: 'x', result_summary: 'lost 1 wu', actor: 'code' },
      { tool: 'evaluate_safety', args_summary: '{"option_id":"job-a:ckpt"}', result_summary: 'allowed', actor: 'code' },
      { tool: 'choose_options', args_summary: '{"jobs":1}', result_summary: 'LLM unavailable: Error', actor: 'code' },
    ] })])!;
    expect(round.options[0]!.chosen).toBeNull();
  });
  it('merges a replan round (choice in the replan event, options in the following plan event)', () => {
    const round = latestCandidateRound([
      ev({ stage: 'plan', tool_calls: [{ tool: 'simulate_plan', args_summary: 'old', result_summary: 'lost 9 wu', actor: 'code' }, { tool: 'evaluate_safety', args_summary: '{"option_id":"old"}', result_summary: 'allowed' }] }),
      ev({ stage: 'execute' }),
      ev({ stage: 'replan', summary: 'replanning plan-1' }),
      ev({ stage: 'replan', actor: 'nemotron', tool_calls: [{ tool: 'choose_options', args_summary: '{}', result_summary: 'job-b:cap', actor: 'nemotron' }] }),
      ev({ stage: 'plan', tool_calls: [{ tool: 'simulate_plan', args_summary: 'cap', result_summary: 'lost 0 wu · delay 40 s', actor: 'code' }, { tool: 'evaluate_safety', args_summary: '{"option_id":"job-b:cap"}', result_summary: 'allowed' }] }),
    ])!;
    expect(round.options.map((o) => o.option_id)).toEqual(['job-b:cap']);
    expect(round.options[0]!.chosen).toBe(true);
    expect(round.narrative).toHaveLength(3);
    expect(round.pending).toBe(false);
  });
});

describe('scripted recovery example through the real mock APIs', () => {
  it('produces two separate workflows: one waiting after a replan, one resumed and verified', async () => {
    const store = await openDashboard('mock', 'recovery', { uri: '', db: '' });
    store.start();
    await new Promise((r) => setTimeout(r, 25));
    const { workflows, events, actionDetails, incidents, snapshot } = store.state;
    const views = buildWorkflowViews({ workflows, events, actionDetails, incidents, snapshot });
    store.close();
    expect(views.map((v) => v.workflow.workflow_id)).toEqual(['wf-example-cooling', 'wf-example-xid']);
    const [cool, xid] = views as [WorkflowView, WorkflowView];
    expect(cool.status.kind).toBe('waiting');
    expect(cool.waiting?.operation).toBe('checkpoint');
    expect(cool.groups.blocked.map((l) => l.reason)).toEqual(['STALE_DECISION_EPOCH']);
    expect(cool.attempt).toBe(2);
    // The fixture persists `state.candidates[]` in the planner's shape, so the persisted round wins over the plan-event round.
    expect(cool.candidates?.source).toBe('workflow_state');
    expect(cool.candidates?.options.find((o) => o.option_id === 'job-b:power_cap')?.chosen).toBe(true);
    expect(cool.candidates?.options.filter((o) => o.persisted?.job_id === 'job-b').map((o) => o.persisted?.safety)).toEqual(['allow', 'needs_approval', 'deny', 'not_checked']);
    expect(xid.status.kind).toBe('verified');
    expect(xid.resumed).toMatchObject({ source: 'workflow_state', previous_owner: 'example-agent-alpha-1', count: 1 });
    expect(xid.workflow.lease_owner).toBe('example-agent-beta-2');
    expect(xid.infra.relatedGpus.map((g) => g.resource_id)).toEqual(['gpu-r7-n1-0']);
    expect(events.every((e) => e.summary.startsWith('Example:'))).toBe(true);
  });
});

describe('R3 handoff and persisted resume marker', () => {
  it('reads the R3 OperatorHandoff fields by their exact names', () => {
    const v = readVerification({ verification: {
      version: 1, source: 'code', verified: false, escalate: true, outcome: 'escalated', handoff: 'h', as_of_sim_time_ms: 9,
      verification_interval_sim_ms: [3, 9], evidence: { hypotheses: ['inc-1: pump A — shared cooling'] },
      affected_jobs: [{ job_id: 'job-a', status: 'running', progress_work_units: 5, durable_work_units: 4, racks: ['r7'] }],
      actions: { completed: ['k1'], verified: [], unverified: ['k1'], blocked: [{ command_key: 'k2', violations: ['DEST_GPU_BUSY'] }], failed: [], not_run: ['k3'] },
      checkpoint_outcome: [{ job_id: 'job-a', checkpoint_id: 'c1', status: 'complete', accessible: true, progress_work_units: 4 }],
      placement_outcome: [{ job_id: 'job-a', gpu_ids: ['g1'], racks: ['r7'] }],
      unresolved_infrastructure: ['pump-a degraded'], remaining_risk: 'job-b unprotected', next_human_action: 'Service pump A',
    } })!;
    expect(v).toMatchObject({ outcome: 'escalated', asOf: { from: 3, to: 9 }, nextStep: 'Service pump A', unresolved: ['pump-a degraded'], remainingRisk: 'job-b unprotected', source: 'code' });
    expect(v.actions?.blocked).toEqual([{ command_key: 'k2', violations: ['DEST_GPU_BUSY'] }]);
    expect(v.actions?.not_run).toEqual(['k3']);
    expect(v.checkpointOutcome[0]).toMatchObject({ checkpoint_id: 'c1', accessible: true });
    expect(v.placementOutcome[0]?.racks).toEqual(['r7']);
    expect(v.affectedJobs[0]?.job_id).toBe('job-a');
    expect(v.hypotheses).toHaveLength(1);
  });
  it('treats missing R3 fields as not recorded, never invented', () => {
    const v = readVerification({ verification: { verified: true, handoff: 'old shape', as_of_sim_time_ms: 5 } })!;
    expect(v).toMatchObject({ outcome: null, remainingRisk: null, actions: null, nextStep: null, unresolved: [] });
  });
  it('prefers the persisted state.resumed marker over event heuristics', () => {
    const r = resumeEvidence([], { resumed: { by_worker: 'agent-2', at_sim_time_ms: 42_000, action: 'resumed_execute', previous_owner: null } });
    expect(r).toMatchObject({ source: 'workflow_state', sim_time_ms: 42_000, by_worker: 'agent-2', action: 'resumed_execute', previous_owner: null });
    expect(r?.detail).toContain('agent-2');
    expect(resumeEvidence([], { resumed: { by_worker: 'agent-2' } })).toBeNull();
    expect(resumeEvidence([], { resumed: { by_worker: 'a', at_sim_time_ms: 1, action: 'bogus', previous_owner: null } })).toBeNull();
  });
  it('reads previous_owner and resume_count from the persisted marker', () => {
    const r = resumeEvidence([], { resumed: { by_worker: 'agent-2', at_sim_time_ms: 1, action: 'resumed_execute', previous_owner: 'agent-1' }, resume_count: 2 });
    expect(r).toMatchObject({ count: 2, previous_owner: 'agent-1' });
    expect(r?.detail).toBe('resumed by agent-2 (was agent-1) · resumed execute');
    // resume_count lives at the top level of state, not inside the marker
    const inner = resumeEvidence([], { resumed: { by_worker: 'a', at_sim_time_ms: 1, action: 'took_over', previous_owner: null, resume_count: 9 } });
    expect(inner).toMatchObject({ count: null, previous_owner: null });
  });
  it('falls back to event evidence when state.resumed is malformed', () => {
    const events = [ev({ stage: 'execute', summary: 'continuing wf-1 from stage plan after agent restart' })];
    expect(resumeEvidence(events, { resumed: { at_sim_time_ms: 1 } })?.source).toBe('event_summary');
  });
});

describe('persisted candidates (workflow.state.candidates)', () => {
  const cand = (patch: Record<string, unknown>) => ({
    job_id: 'job-a', option: 'ckpt', commands_summary: 'checkpoint job-a', predicted_lost_work_units: 0, predicted_work_deficit_units: null,
    predicted_gpu_busy_waste_s: 30, safety: 'allow', violations: [], chosen: false, reason: 'r', decided_by: 'nemotron', snapshot_epoch: 7, as_of_sim_time_ms: 5000, ...patch,
  });
  it('reads chosen and rejected options with their persisted fields, chosen first per job', () => {
    const opts = persistedCandidateOptions({ candidates: [
      cand({ option: 'move:r6', safety: 'deny', violations: ['DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT'], decided_by: 'code', predicted_lost_work_units: null }),
      cand({ chosen: true }),
      cand({ job_id: 'job-b', option: 'job-b:cap', chosen: true }),
    ] })!;
    expect(opts.map((o) => [o.option_id, o.chosen, o.blocked, o.actor])).toEqual([
      ['job-a:ckpt', true, false, 'nemotron'], ['job-a:move:r6', false, true, 'code'], ['job-b:cap', true, false, 'nemotron'],
    ]);
    expect(opts[0]).toMatchObject({ lost_wu: 0, persisted: { deficit_wu: null, safety: 'allow', gpu_waste_s: 30, snapshot_epoch: 7, as_of_sim_time_ms: 5000, reason: 'r' } });
    expect(opts[1]!.lost_wu).toBeNull();
  });
  it('caps at 6 per job and ignores malformed rows', () => {
    const many = Array.from({ length: 8 }, (_, i) => cand({ option: `o${i}` }));
    expect(persistedCandidateOptions({ candidates: [...many, { option: 'no-job' }, 'junk'] })).toHaveLength(6);
    expect(persistedCandidateOptions({ candidates: [] })).toBeNull();
    expect(persistedCandidateOptions({})).toBeNull();
  });
  it('maps the 4-value safety enum and keeps the violations list', () => {
    const opts = persistedCandidateOptions({ candidates: [
      cand({ option: 'a', safety: 'deny', violations: ['DEST_GPU_BUSY', 'X'] }), cand({ option: 'b', safety: 'needs_approval' }), cand({ option: 'c', safety: 'not_checked' }),
    ] })!;
    expect(opts.map((o) => [o.safety, o.blocked])).toEqual([['denied', true], ['needs approval', false], ['not checked', false]]);
    expect(opts[0]!.persisted!.violations).toEqual(['DEST_GPU_BUSY', 'X']);
  });
  it('skips entries whose safety is not in the enum (no guessing from booleans or {allowed})', () => {
    const opts = persistedCandidateOptions({ candidates: [
      cand({ option: 'bool', safety: false }), cand({ option: 'obj', safety: { allowed: true } }), cand({ option: 'old', safety: 'allowed' }),
      cand({ option: 'badactor', decided_by: 'llm' }), cand({ option: 'ok', chosen: true }),
    ] })!;
    expect(opts.map((o) => o.persisted!.option)).toEqual(['ok']);
    expect(persistedCandidateOptions({ candidates: [cand({ safety: true })] })).toBeNull();
  });
  it('keeps null metrics null and hides the work-deficit column while it is null everywhere', () => {
    const state = { candidates: [cand({ chosen: true, predicted_lost_work_units: null, predicted_gpu_busy_waste_s: null })] };
    const [o] = persistedCandidateOptions(state)!;
    expect(o).toMatchObject({ lost_wu: null, persisted: { gpu_waste_s: null, deficit_wu: null } });
    expect(candidateRound([], state)!.showDeficit).toBe(false);
    expect(candidateRound([], { candidates: [cand({ predicted_work_deficit_units: 3 })] })!.showDeficit).toBe(true);
  });
  it('renders not simulated for null metrics and no deficit column', () => {
    const round = candidateRound([], { candidates: [cand({ chosen: true, predicted_lost_work_units: null, predicted_gpu_busy_waste_s: null, violations: ['V1'] })] })!;
    const html = renderToStaticMarkup(createElement(WorkflowBoard, { workflows: [wf({ state: { candidates: [cand({ chosen: true, predicted_lost_work_units: null, predicted_gpu_busy_waste_s: null, violations: ['V1'] })] } })], events: [], actionDetails: [], incidents: [], snapshot: null, example: false, mode: 'mock' } as never));
    expect(round.options).toHaveLength(1);
    expect(html).toContain('not simulated');
    expect(html).not.toContain('work deficit');
    expect(html).toContain('V1');
  });
  it('prefers persisted candidates and falls back to the plan-event round for older rows', () => {
    const events = [ev({ stage: 'plan', summary: 'plan summary', tool_calls: [
      { tool: 'simulate_plan', args_summary: 'x', result_summary: 'lost 1 wu', actor: 'code' },
      { tool: 'evaluate_safety', args_summary: '{"option_id":"job-a:keep"}', result_summary: 'allowed', actor: 'code' },
    ] })];
    const persisted = candidateRound(events, { candidates: [cand({ chosen: true })] })!;
    expect(persisted.source).toBe('workflow_state');
    expect(persisted.options.map((o) => o.option_id)).toEqual(['job-a:ckpt']);
    expect(persisted.narrative[0]?.summary).toBe('plan summary');
    expect(persisted.sim_time_ms).toBe(5000);
    const older = candidateRound(events, {})!;
    expect(older.source).toBe('events');
    expect(older.options.map((o) => o.option_id)).toEqual(['job-a:keep']);
    expect(view(wf({ state: { candidates: [cand({})] } }), events).candidates?.source).toBe('workflow_state');
  });
});


describe('persisted plans and workflows via onPlans / onWorkflows', () => {
  it('delivers every workflow (done ones included) and each selected plan from the DB subscriptions', async () => {
    const store = await openDashboard('mock', 'recovery', { uri: '', db: '' });
    store.start();
    await new Promise((r) => setTimeout(r, 50));
    const { workflows, plans } = store.state;
    expect(workflows.map((w) => w.workflow_id).sort()).toEqual(['wf-example-cooling', 'wf-example-xid']);
    expect(workflows.some((w) => w.stage === 'done')).toBe(true);
    const selected = workflows.map((w) => w.plan_id).filter((id): id is string => Boolean(id));
    expect(selected.length).toBeGreaterThan(0);
    for (const id of selected) expect(plans.find((p) => p.plan_id === id)?.assumptions.length).toBeGreaterThan(0);
    store.close();
  });
});
