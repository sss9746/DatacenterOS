import type { ActionCommand, ActionStatus, Checkpoint, Incident, IncidentLink, JobGpuAllocation, JobState } from '@dcos/contracts';
import type { ActionDetail, AgentEventInput, WorkflowRecord } from '@dcos/db-client';
import { describe, expect, it } from 'vitest';
import {
  allocationUniqueness,
  checkDestinationReplanned,
  checkFallbackAttributed,
  checkHardSafetyHeld,
  checkKeysReconciled,
  checkRecoveredOrEscalated,
  checkWorkflowReclaimed,
  checkpointOnce,
  diffCommandKeys,
  extractPlannedDestinations,
  finalMigrate,
  incidentsAreSeparate,
  intentOf,
} from '../../scripts/live/asserts.js';

const V = '1.1.0' as const;
const RUN = 'run-demo-1';
const gpu = (r: number, g: number) => `gpu-r${r}-n1-${g}`;
const rack = (r: number) => Array.from({ length: 8 }, (_, g) => gpu(r, g));

const alloc = (job: string, gpus: string[]): JobGpuAllocation[] => gpus.map((g) => ({ schema_version: V, run_id: RUN, job_id: job, gpu_id: g, since_sim_time_ms: 0 }));
const job = (id: string, gpus: string[], over: Partial<JobState> = {}): JobState => ({
  schema_version: V, run_id: RUN, job_id: id, status: 'running', allocated_gpu_ids: gpus, progress_work_units: 100, durable_work_units: 80, latest_checkpoint_id: null, version: 1, last_update_sim_time_ms: 0, ...over,
});
const ckpt = (id: string, jobId: string, key: string, status: Checkpoint['status']): Checkpoint => ({
  schema_version: V, run_id: RUN, checkpoint_id: id, job_id: jobId, storage_resource_id: 'ckpt-store-1', status, progress_work_units: 80, requested_sim_time_ms: 0, complete_sim_time_ms: status === 'complete' ? 1 : null, accessible: true, command_key: key,
});
function detail(key: string, op: ActionCommand['operation'], jobId: string, status: ActionStatus['status'], over: { args?: Record<string, unknown>; deps?: string[]; req?: number; safety?: ActionDetail['safety']; start_safety?: ActionDetail['start_safety']; reason?: string | null } = {}): ActionDetail {
  const command: ActionCommand = {
    schema_version: V, run_id: RUN, action_id: `act:${key}`, command_key: key, workflow_id: key.split(':')[0]!, plan_id: 'plan-1', incident_ids: ['inc-1'], operation: op, target_resource_id: jobId, job_id: jobId,
    arguments: over.args ?? {}, depends_on_command_keys: over.deps ?? [], expected_decision_epoch: 1, expected_resource_versions: {}, requested_sim_time_ms: over.req ?? 0,
  };
  return {
    status: { schema_version: V, run_id: RUN, action_id: command.action_id, command_key: key, status, attempt: 1, updated_sim_time_ms: 0, result: {}, reason_code: over.reason ?? null, version: 1 },
    command, claimed_by: null, due_sim_time_ms: null, safety: over.safety ?? null, start_safety: over.start_safety ?? null, history: [],
  };
}
const wf = (over: Partial<WorkflowRecord>): WorkflowRecord => ({
  workflow_id: 'wf-inc-1', run_id: RUN, stage: 'execute', state: {}, incident_ids: ['inc-1'], plan_id: 'plan-1', current_command_key: null, last_processed_event_seq: 0, attempt: 1, lease_owner: 'agent-host-100', lease_expires_unix_ms: 0, fencing_token: 5n, updated_at_unix_ms: 0, version: 3, ...over,
});

describe('allocationUniqueness', () => {
  it('passes when rows and job states agree and no GPU is shared', () => {
    const a = [...alloc('job-a', rack(2)), ...alloc('job-b', rack(5))];
    const r = allocationUniqueness(a, [job('job-a', rack(2)), job('job-b', rack(5))]);
    expect(r.ok).toBe(true);
    expect(r.doubled).toEqual({});
  });
  it('flags a GPU allocated to two jobs and row/state mismatches', () => {
    const shared = gpu(7, 0);
    const a = [...alloc('job-a', [shared, gpu(7, 1)]), ...alloc('job-b', [shared])];
    const r = allocationUniqueness(a, [job('job-a', [shared, gpu(7, 1)]), job('job-b', [shared])]);
    expect(r.ok).toBe(false);
    expect(r.doubled).toEqual({ [shared]: ['job-a', 'job-b'] });
    const r2 = allocationUniqueness(alloc('job-a', [gpu(1, 0)]), [job('job-a', [gpu(1, 0), gpu(1, 1)])]);
    expect(r2.ok).toBe(false);
    expect(r2.inconsistent[0]).toMatch(/job-a/);
  });
});

describe('checkpointOnce', () => {
  const key = 'wf-inc-1:checkpoint:job-a:1';
  it('exactly one complete row for the key and one new complete for the job', () => {
    const cps = [ckpt('c0', 'job-a', 'old', 'complete'), ckpt('c1', 'job-a', key, 'complete'), ckpt('cb', 'job-b', 'x', 'complete')];
    expect(checkpointOnce(cps, key, 'job-a', 1)).toMatchObject({ ok: true, completeForKey: 1, writingForKey: 0, newCompleteForJob: 1 });
  });
  it('fails on a duplicate write, a second writing row, or a missing completion', () => {
    expect(checkpointOnce([ckpt('c1', 'job-a', key, 'complete'), ckpt('c2', 'job-a', key, 'complete')], key, 'job-a', 0).ok).toBe(false);
    expect(checkpointOnce([ckpt('c1', 'job-a', key, 'complete'), ckpt('c2', 'job-a', key, 'writing')], key, 'job-a', 0).ok).toBe(false);
    expect(checkpointOnce([ckpt('c1', 'job-a', key, 'failed')], key, 'job-a', 0)).toMatchObject({ ok: false, completeForKey: 0, failedForKey: 1 });
  });
  it('L5 mode: zero new completes is the pass condition', () => {
    expect(checkpointOnce([ckpt('c1', 'job-a', key, 'failed')], key, 'job-a', 0, 0)).toMatchObject({ completeForKey: 0, newCompleteForJob: 0 });
  });
});

describe('extractPlannedDestinations', () => {
  const dest = [...rack(7), ...rack(8)];
  it('reads open migrate rows from the ledger, newest-first order preserved, skipping terminal ones', () => {
    const details = [
      detail('wf-inc-1:migrate_restart:job-a:1', 'migrate_restart', 'job-a', 'requested', { args: { destination_gpu_ids: dest } }),
      detail('wf-inc-1:migrate_restart:job-a:0', 'migrate_restart', 'job-a', 'cancelled', { args: { destination_gpu_ids: rack(6) } }),
      detail('wf-inc-1:migrate_restart:job-b:1', 'migrate_restart', 'job-b', 'requested', { args: { destination_gpu_ids: rack(5) } }),
      detail('wf-inc-1:checkpoint:job-a:1', 'checkpoint', 'job-a', 'running'),
    ];
    const out = extractPlannedDestinations(details, [], 'job-a');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ command_key: 'wf-inc-1:migrate_restart:job-a:1', gpu_ids: dest, source: 'ledger', status: 'requested' });
  });
  it('falls back to migrate commands persisted in workflow execute state that are not yet submitted or completed', () => {
    const commands = [
      { operation: 'checkpoint', job_id: 'job-a', command_key: 'wf-inc-1:checkpoint:job-a:1', arguments: {} },
      { operation: 'migrate_restart', job_id: 'job-a', command_key: 'wf-inc-1:migrate_restart:job-a:1', arguments: { destination_gpu_ids: dest } },
    ];
    const out = extractPlannedDestinations([], [wf({ state: { commands, completed_keys: [] } })], 'job-a');
    expect(out).toEqual([{ command_key: 'wf-inc-1:migrate_restart:job-a:1', job_id: 'job-a', gpu_ids: dest, source: 'workflow_state', status: 'planned' }]);
    expect(extractPlannedDestinations([], [wf({ state: { commands, completed_keys: ['wf-inc-1:migrate_restart:job-a:1'] } })], 'job-a')).toEqual([]);
  });
  it('never invents a destination: empty when nothing public names one', () => {
    expect(extractPlannedDestinations([detail('wf-inc-1:checkpoint:job-a:1', 'checkpoint', 'job-a', 'running')], [wf({ state: {} })], 'job-a')).toEqual([]);
    expect(extractPlannedDestinations([detail('wf-inc-1:migrate_restart:job-a:1', 'migrate_restart', 'job-a', 'requested', { args: { destination_gpu_ids: [] } })], [], 'job-a')).toEqual([]);
  });
});

describe('destination replanned (L2)', () => {
  const old = 'wf-inc-1:migrate_restart:job-a:1';
  const neu = 'wf-inc-1:migrate_restart:job-a:2';
  const failed = gpu(7, 0);
  it('passes when the old move is cancelled and the new succeeded move excludes the failed GPU', () => {
    const details = [
      detail(old, 'migrate_restart', 'job-a', 'cancelled', { args: { destination_gpu_ids: [...rack(7), ...rack(8)] }, reason: 'SUPERSEDED', req: 1 }),
      detail(neu, 'migrate_restart', 'job-a', 'succeeded', { args: { destination_gpu_ids: [...rack(5), ...rack(6)] }, req: 2 }),
    ];
    const checks = checkDestinationReplanned(details, 'job-a', old, failed);
    expect(checks.map((c) => c.ok)).toEqual([true, true]);
    expect(finalMigrate(details, 'job-a')?.command_key).toBe(neu);
  });
  it('fails when the old move ran anyway or the new destination still contains the failed GPU', () => {
    const ran = [detail(old, 'migrate_restart', 'job-a', 'succeeded', { args: { destination_gpu_ids: [...rack(7), ...rack(8)] } })];
    expect(checkDestinationReplanned(ran, 'job-a', old, failed).map((c) => c.ok)).toEqual([false, false]);
    const still = [
      detail(old, 'migrate_restart', 'job-a', 'cancelled', { args: { destination_gpu_ids: rack(7) }, req: 1 }),
      detail(neu, 'migrate_restart', 'job-a', 'running', { args: { destination_gpu_ids: [failed, ...rack(8)] }, req: 2 }),
    ];
    expect(checkDestinationReplanned(still, 'job-a', old, failed).map((c) => c.ok)).toEqual([true, false]);
  });
  it('treats an obsolete move that never reached the ledger as settled', () => {
    const details = [detail(neu, 'migrate_restart', 'job-a', 'succeeded', { args: { destination_gpu_ids: rack(8) } })];
    expect(checkDestinationReplanned(details, 'job-a', old, failed).map((c) => c.ok)).toEqual([true, true]);
  });
});

describe('command key reconciliation (L1)', () => {
  const ck = 'wf-inc-1:checkpoint:job-a:1';
  const mv = 'wf-inc-1:migrate_restart:job-a:1';
  const dest = { destination_gpu_ids: rack(7) };
  it('intentOf strips the ordinal', () => {
    expect(intentOf(mv)).toBe('wf-inc-1:migrate_restart:job-a');
    expect(intentOf('wf-x:escalate:pump-a:12')).toBe('wf-x:escalate:pump-a');
  });
  it('passes when every pre-kill key survives with the same payload and nothing was re-minted', () => {
    const before = [detail(ck, 'checkpoint', 'job-a', 'running'), detail(mv, 'migrate_restart', 'job-a', 'requested', { args: dest, deps: [ck] })];
    const after = [detail(ck, 'checkpoint', 'job-a', 'succeeded'), detail(mv, 'migrate_restart', 'job-a', 'succeeded', { args: dest, deps: [ck] })];
    expect(checkKeysReconciled(before, after).ok).toBe(true);
  });
  it('fails on a new key for an existing intent (duplicate retry) or a changed payload', () => {
    const before = [detail(ck, 'checkpoint', 'job-a', 'running'), detail(mv, 'migrate_restart', 'job-a', 'requested', { args: dest, deps: [ck] })];
    const dup = [...before, detail('wf-inc-1:checkpoint:job-a:2', 'checkpoint', 'job-a', 'requested')];
    const d = diffCommandKeys(before, dup);
    expect(d.newKeysForExistingIntent).toEqual(['wf-inc-1:checkpoint:job-a:2']);
    expect(checkKeysReconciled(before, dup).ok).toBe(false);
    expect(checkKeysReconciled(before, dup, { allowReplan: true }).ok).toBe(true);
    const mutated = [detail(ck, 'checkpoint', 'job-a', 'succeeded'), detail(mv, 'migrate_restart', 'job-a', 'succeeded', { args: { destination_gpu_ids: rack(8) }, deps: [ck] })];
    expect(checkKeysReconciled(before, mutated).detail).toMatch(/payload changed/);
  });
  it('fails when a pre-kill key disappears', () => {
    const before = [detail(ck, 'checkpoint', 'job-a', 'running')];
    expect(checkKeysReconciled(before, []).detail).toMatch(/lost/);
  });
});

describe('workflow reclaim / recovery', () => {
  it('reclaimed = new owner, higher token, higher attempt', () => {
    const before = wf({});
    expect(checkWorkflowReclaimed(before, wf({ lease_owner: 'agent-host-200', fencing_token: 9n, attempt: 2 })).ok).toBe(true);
    expect(checkWorkflowReclaimed(before, wf({ lease_owner: 'agent-host-100', fencing_token: 9n, attempt: 2 })).ok).toBe(false);
    expect(checkWorkflowReclaimed(before, wf({ lease_owner: 'agent-host-200', fencing_token: 5n, attempt: 2 })).ok).toBe(false);
    expect(checkWorkflowReclaimed(null, before).ok).toBe(false);
  });
  it('done passes; escalated needs a reason; anything else fails', () => {
    expect(checkRecoveredOrEscalated(wf({ stage: 'done' })).ok).toBe(true);
    expect(checkRecoveredOrEscalated(wf({ stage: 'escalated', state: { escalation_reason: 'no safe destination' } })).ok).toBe(true);
    expect(checkRecoveredOrEscalated(wf({ stage: 'escalated', state: {} })).ok).toBe(false);
    expect(checkRecoveredOrEscalated(wf({ stage: 'execute' })).ok).toBe(false);
  });
});

describe('incidentsAreSeparate (L2)', () => {
  const inc = (id: string): Incident => ({ schema_version: V, run_id: RUN, incident_id: id, state: 'investigating', severity: 'high', title: id, hypothesis: null, confidence: 0.8, opened_sim_time_ms: 0, updated_sim_time_ms: 0, version: 1 });
  const link = (incident: string, res: string): IncidentLink => ({ schema_version: V, run_id: RUN, incident_id: incident, linked_id: res, link_kind: 'resource', reason: 'r' });
  const cooling = ['pump-a', 'loop-a', 'rack-r2', 'rack-r3', 'rack-r4'];
  it('finds a cooling incident and a distinct GPU incident', () => {
    const r = incidentsAreSeparate([inc('inc-1'), inc('inc-2')], [link('inc-1', 'pump-a'), link('inc-1', 'rack-r3'), link('inc-2', gpu(7, 0))], cooling, [gpu(7, 0), 'node-r7-n1']);
    expect(r).toEqual({ ok: true, coolingIncidentId: 'inc-1', gpuIncidentId: 'inc-2' });
  });
  it('fails when the GPU fault was folded into the cooling incident or never opened', () => {
    expect(incidentsAreSeparate([inc('inc-1')], [link('inc-1', 'pump-a'), link('inc-1', gpu(7, 0))], cooling, [gpu(7, 0)]).ok).toBe(false);
    expect(incidentsAreSeparate([inc('inc-1')], [link('inc-1', 'pump-a')], cooling, [gpu(7, 0)]).ok).toBe(false);
  });
  it('ignores links to incidents that no longer exist', () => {
    expect(incidentsAreSeparate([inc('inc-1')], [link('inc-1', 'pump-a'), link('inc-ghost', gpu(7, 0))], cooling, [gpu(7, 0)]).ok).toBe(false);
  });
});

describe('L6 safety + attribution', () => {
  const viol = { decision: 'deny' as const, violations: ['DEST_BUSY'], checked_decision_epoch: 1, evidence: {} };
  it('hard safety held unless a violated action ran', () => {
    const okRows = [detail('wf:migrate_restart:job-a:1', 'migrate_restart', 'job-a', 'failed', { safety: viol, reason: 'SAFETY_REJECTED' }), detail('wf:checkpoint:job-a:1', 'checkpoint', 'job-a', 'succeeded', { safety: { ...viol, decision: 'allow', violations: [] } })];
    expect(checkHardSafetyHeld(okRows).ok).toBe(true);
    expect(checkHardSafetyHeld([detail('wf:migrate_restart:job-a:1', 'migrate_restart', 'job-a', 'running', { safety: viol })]).ok).toBe(false);
    expect(checkHardSafetyHeld([detail('wf:migrate_restart:job-a:1', 'migrate_restart', 'job-a', 'succeeded', { start_safety: viol })]).ok).toBe(false);
  });
  const ev = (actor: AgentEventInput['actor'], summary: string): AgentEventInput => ({ agent_event_id: summary, run_id: RUN, workflow_id: 'wf', incident_id: null, stage: 'plan', summary, evidence_ids: [], tool_calls: [], actor, sim_time_ms: 0, observed_unix_ms: 0 });
  it('attribution: code events present, none claim nemotron, none unattributed', () => {
    expect(checkFallbackAttributed([ev('code', 'LLM unavailable: executing deterministic plan'), ev('code', 'handoff')], { expectNoNemotron: true }).ok).toBe(true);
    expect(checkFallbackAttributed([ev('code', 'x'), ev('nemotron', 'chose option')], { expectNoNemotron: true }).ok).toBe(false);
    expect(checkFallbackAttributed([ev('code', 'x'), ev(undefined, 'y')], { expectNoNemotron: true }).ok).toBe(false);
    expect(checkFallbackAttributed([], { expectNoNemotron: true }).ok).toBe(false);
  });
});
