import { describe, expect, it } from 'vitest';
import type { Incident, ObservedSnapshot } from '@dcos/contracts';
import type { ActionDetail, AgentEventInput, Evidence, WorkflowRecord } from '@dcos/db-client';
import { decisionFor, optionPhrase, recoveredFacts, statusNow, whatHappened, whyGrouped } from '../src/components/incidents/incident-view';

const incident = (id: string, patch: Partial<Incident> = {}): Incident => ({
  schema_version: '1.1.0', run_id: 'run', incident_id: id, state: 'investigating', severity: 'high', title: `Incident ${id}`, hypothesis: null, confidence: 0.85, opened_sim_time_ms: 600_000, updated_sim_time_ms: 600_000, version: 1, ...patch,
});
const link = (incident_id: string, linked_id: string) => ({ schema_version: '1.1.0' as const, run_id: 'run', incident_id, linked_id, link_kind: 'resource' as const, reason: 'test' });
const evidence = (links: Evidence['links']): Evidence => ({ run_id: 'run', incident_ids: [], window_sim_ms: 600_000, as_of_sim_time_ms: 700_000, incidents: [], links, symptoms: [], signals: [], telemetry: [] });
const gpu = (resource_id: string, temp_c: number, patch: Partial<ObservedSnapshot['gpus'][number]> = {}) => ({
  schema_version: '1.1.0' as const, run_id: 'run', resource_id, node_id: 'n', availability: 'ready' as const, temp_c, sm_clock_mhz: 1000, power_w: 300, power_limit_w: 700, clocks_event_reasons: 0, last_xid_code: null, last_seen_sim_ms: 0, version: 1, ...patch,
});
const snapshot = {
  cooling: [{ schema_version: '1.1.0', run_id: 'run', resource_id: 'pump-a', operating_state: 'degraded', nominal_capacity_w: 100_000, pump_power_w: 1, observed_capacity_estimate_w: 40_000, version: 1 }],
  gpus: [gpu('gpu-r2-n1-0', 71), gpu('gpu-r3-n1-0', 84.4), gpu('gpu-r4-n1-0', 79), gpu('gpu-r7-n1-0', 50, { availability: 'cordoned', last_xid_code: 79 })],
} as unknown as ObservedSnapshot;

let seq = 0;
const ev = (patch: Partial<AgentEventInput>): AgentEventInput => ({
  agent_event_id: `e${seq++}`, run_id: 'run', workflow_id: 'wf-inc', incident_id: 'inc', stage: 'plan', summary: 'Example: did a thing', evidence_ids: [], tool_calls: [], actor: 'code', sim_time_ms: 600_000 + seq * 1000, observed_unix_ms: 1_700_000_000_000 + seq, ...patch,
});
const wf = (patch: Partial<WorkflowRecord> = {}): WorkflowRecord => ({
  workflow_id: 'wf-inc', run_id: 'run', stage: 'execute', state: {}, incident_ids: ['inc'], plan_id: 'plan-1', current_command_key: null, last_processed_event_seq: 0, attempt: 1, lease_owner: 'agent-alpha-1', lease_expires_unix_ms: 0, fencing_token: 1n, updated_at_unix_ms: 0, version: 1, ...patch,
});
const action = (command_key: string, operation: string, job: string | null, target: string, status: 'succeeded' | 'failed', reason_code: string | null = null, violations: string[] = []): ActionDetail => ({
  status: { schema_version: '1.1.0', run_id: 'run', command_key, status, reason_code, attempt: 1, version: 2, updated_sim_time_ms: 650_000, result: { violations } } as unknown as ActionDetail['status'],
  command: { schema_version: '1.1.0', run_id: 'run', action_id: `a-${command_key}`, command_key, workflow_id: 'wf-inc', plan_id: 'plan-1', incident_ids: ['inc'], operation, target_resource_id: target, job_id: job, arguments: {}, depends_on_command_keys: [], expected_decision_epoch: 1, expected_resource_versions: {}, requested_sim_time_ms: 600_000 } as unknown as ActionDetail['command'],
  claimed_by: null, due_sim_time_ms: null, safety: null, start_safety: null, history: [],
});

describe('whatHappened', () => {
  it('names the pump loss and the heating racks from the snapshot', () => {
    const ev1 = evidence([link('inc', 'pump-a'), link('inc', 'rack-r2'), link('inc', 'rack-r3'), link('inc', 'rack-r4')]);
    expect(whatHappened(incident('inc'), ev1, snapshot)).toBe('Pump A lost 60 % of its cooling; racks r2–r4 are heating (hottest GPU 84 °C).');
  });
  it('describes a GPU fault from its availability and XID code', () => {
    expect(whatHappened(incident('xid'), evidence([link('xid', 'gpu-r7-n1-0')]), snapshot)).toBe('gpu-r7-n1-0 reported XID 79 and is cordoned.');
  });
  it('falls back to the title when nothing is linked', () => {
    expect(whatHappened(incident('inc', { title: 'Example: Something' }), null, snapshot)).toBe('Something');
  });
});

describe('whyGrouped', () => {
  it('explains a shared cooling cause and keeps the GPU fault independent', () => {
    const ev1 = evidence([link('inc', 'pump-a'), link('inc', 'rack-r2'), link('inc', 'rack-r3'), link('inc', 'rack-r4'), link('xid', 'gpu-r7-n1-0')]);
    expect(whyGrouped(incident('inc', { hypothesis: 'Example: Shared loop.' }), ev1, [incident('xid')])).toBe('Pump A and racks r2–r4 share one cooling loop, so their symptoms were grouped as one cause. Shared loop.');
    expect(whyGrouped(incident('xid'), ev1, [incident('inc')])).toBe('A single GPU fault, kept separate from the other incident.');
  });
  it('returns the hypothesis alone when no links exist, and null when neither exists', () => {
    expect(whyGrouped(incident('inc', { hypothesis: 'H' }), null, [])).toBe('H');
    expect(whyGrouped(incident('inc'), null, [])).toBeNull();
  });
});

describe('decisionFor', () => {
  it('reads the chosen option, the denied option and the replan reason from the plan round', () => {
    const events = [
      ev({ stage: 'replan', actor: 'nemotron', tool_calls: [{ tool: 'choose_options', args_summary: '{"jobs":1}', result_summary: 'job-b:cap', actor: 'nemotron' }] }),
      ev({ stage: 'plan', actor: 'code', tool_calls: [
        { tool: 'simulate_plan', args_summary: 'job-b: power_cap', result_summary: 'lost 0 wu · delay 40 s', actor: 'code' }, { tool: 'evaluate_safety', args_summary: '{"option_id":"job-b:cap"}', result_summary: 'allowed', actor: 'code' },
        { tool: 'simulate_plan', args_summary: 'job-b: move r6', result_summary: 'lost 0 wu · delay 120 s', actor: 'code' }, { tool: 'evaluate_safety', args_summary: '{"option_id":"job-b:move:r6"}', result_summary: 'denied: DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT', actor: 'code' },
      ] }),
    ];
    const d = decisionFor(wf({ state: { superseded: true, reason: 'destination gpu-r7-n1-0 reported XID 79 and the move was rejected' } }), events);
    expect(d).toEqual({ text: 'Chose to power cap job-b. 1 option denied by the safety check (move job-b to r6). Replanned because destination gpu-r7-n1-0 reported XID 79 and the move was rejected.', actor: 'NEMOTRON' });
  });
  it('prefers persisted candidates and tags the deciding actor', () => {
    const state = { candidates: [{ job_id: 'job-a', option: 'ckpt', safety: 'allow', chosen: true, decided_by: 'nemotron' }, { job_id: 'job-a', option: 'keep', safety: 'allow', chosen: false, decided_by: 'nemotron' }] };
    expect(decisionFor(wf({ state }), [])).toEqual({ text: 'Chose to checkpoint job-a.', actor: 'NEMOTRON' });
  });
  it('falls back to the ledger when the plan recorded no choice (deterministic plans)', () => {
    const cordon = action('k-cordon', 'cordon_gpu', null, 'gpu-r7-n1-0', 'succeeded');
    const events = [ev({ stage: 'plan', actor: 'code', tool_calls: [
      { tool: 'simulate_plan', args_summary: 'cordon', result_summary: 'lost 0 wu', actor: 'code' }, { tool: 'evaluate_safety', args_summary: '{"option_id":"gpu-r7-n1-0:cordon"}', result_summary: 'allowed', actor: 'code' },
      { tool: 'simulate_plan', args_summary: 'escalate', result_summary: 'lost 0 wu', actor: 'code' }, { tool: 'evaluate_safety', args_summary: '{"option_id":"gpu-r7-n1-0:escalate"}', result_summary: 'allowed', actor: 'code' },
    ] })];
    expect(decisionFor(wf(), events, [cordon])).toEqual({ text: 'Deterministic plan: cordon gpu gpu-r7-n1-0 (over 1 other option).', actor: 'CODE' });
  });
  it('is null without a workflow and falls back to the last summary without options', () => {
    expect(decisionFor(null, [])).toBeNull();
    expect(decisionFor(wf(), [ev({ stage: 'diagnose', actor: 'nemotron', summary: 'Example: keep the XID incident separate.' })])).toEqual({ text: 'keep the XID incident separate.', actor: 'NEMOTRON' });
  });
});

describe('statusNow', () => {
  it('reports verified, blocked and needs-a-human states', () => {
    expect(statusNow(incident('inc'), wf({ stage: 'done', state: { verification: { verified: true, unresolved_infrastructure: ['gpu-r7-n1-0 cordoned'] } } }), [])).toMatchObject({ badge: 'Verified', sentence: 'Done; recovery verified, but the hardware still needs service.', tone: 'agent' });
    const blocked = action('k1', 'migrate_restart', 'job-b', 'job-b', 'failed', 'SAFETY_REJECTED', ['STALE_DECISION_EPOCH']);
    expect(statusNow(incident('inc'), wf({ stage: 'execute' }), [blocked])).toMatchObject({ badge: 'Blocked', sentence: 'Executing; 1 action blocked by the safety check.', tone: 'warning' });
    expect(statusNow(incident('inc'), wf({ stage: 'escalated' }), [])).toMatchObject({ badge: 'Needs a human', tone: 'warning' });
    expect(statusNow(incident('inc'), null, [])).toMatchObject({ badge: 'No workflow', sentence: 'No agent workflow has picked this incident up yet.' });
    const ckpt = action('k2', 'checkpoint', 'job-a', 'job-a', 'succeeded');
    expect(statusNow(incident('inc'), wf({ stage: 'execute', current_command_key: 'k2' }), [ckpt]).sentence).toBe('Executing; waiting on checkpoint job-a.');
  });
});

describe('recoveredFacts', () => {
  it('derives takeover, skipped duplicate, verification and blocked facts', () => {
    const cordon = action('k-cordon', 'cordon_gpu', null, 'gpu-r7-n1-0', 'succeeded');
    const move = action('k-move', 'migrate_restart', 'job-b', 'job-b', 'failed', 'SAFETY_REJECTED', ['STALE_DECISION_EPOCH']);
    const events = [ev({ stage: 'execute', tool_calls: [{ tool: 'get_action_status', args_summary: 'k-cordon', result_summary: 'succeeded → skip', actor: 'code' }] })];
    const row = wf({ stage: 'done', lease_owner: 'agent-beta-2', state: {
      resumed: { by_worker: 'agent-beta-2', at_sim_time_ms: 250_000, action: 'resumed_verify', previous_owner: 'agent-alpha-1' }, resume_count: 1,
      verification: { verified: true, outcome: 'recovered', verification_interval_sim_ms: [240_000, 250_000], actions: { completed: ['k-cordon'], verified: ['k-cordon'], unverified: [], blocked: [], failed: [], not_run: [] }, unresolved_infrastructure: ['Example: gpu-r7-n1-0 cordoned after XID 79; needs hardware service.'] },
    } });
    const texts = recoveredFacts([row], events, [cordon, move]).map((f) => f.text);
    expect(texts).toEqual([
      'agent-beta took over from agent-alpha at sim 00:04:10, nothing re-run',
      'cordon gpu gpu-r7-n1-0 had already succeeded, so it was skipped rather than run twice',
      'Recovery verified over sim 00:04:00–00:04:10: recovered (1 of 1 completed action checked)',
      'Still needs a human: gpu-r7-n1-0 cordoned after XID 79; needs hardware service',
      'Blocked: migrate + restart job-b — The cluster changed after the plan was made. A fresh plan is needed.',
    ]);
  });
  it('is empty when nothing was recorded', () => {
    expect(recoveredFacts([wf()], [], [])).toEqual([]);
  });
});

describe('optionPhrase', () => {
  it('turns option ids into words', () => {
    expect(optionPhrase('job-b:move:r7')).toBe('move job-b to r7');
    expect(optionPhrase('gpu-r7-n1-0:cordon')).toBe('cordon gpu-r7-n1-0');
    expect(optionPhrase('weird')).toBe('weird');
  });
});
