import type { ActionCommand, ActionStatus, Checkpoint, JobState, ObservedSnapshot } from '@dcos/contracts';
import type { ActionDetail, WorkflowRecord } from '@dcos/db-client';
import { describe, expect, it } from 'vitest';
import {
  checkFirstWaitPreserved,
  checkJobInOperatorHandoff,
  checkNoRestartDuringOutage,
  checkNotRestarted,
  checkpointBaseline,
  checkRecoveryWaiting,
  checkRestartFromCheckpoint,
  checkSinglePlacement,
  checkWorkAdvanced,
  nodeOutage,
  parseRecovery,
  recordRecoverySamples,
  waitingJobIds,
  type RecoverySample,
  type RecoveryView,
} from '../../scripts/live/asserts.js';

const V = '1.1.0' as const;
const RUN = 'run-demo-1';
const START = 700_000;
const END = 730_000;
const DEST = ['gpu-r5-n1-0', 'gpu-r5-n1-1'];

const job = (id: string, over: Partial<JobState> = {}): JobState => ({ schema_version: V, run_id: RUN, job_id: id, status: 'running', allocated_gpu_ids: DEST, progress_work_units: 40_100, durable_work_units: 40_000, latest_checkpoint_id: 'ckpt-job-b-1', version: 1, last_update_sim_time_ms: 0, ...over });
const ckpt = (over: Partial<Checkpoint> = {}): Checkpoint => ({ schema_version: V, run_id: RUN, checkpoint_id: 'ckpt-job-b-1', job_id: 'job-b', storage_resource_id: 'ckpt-store-1', status: 'complete', progress_work_units: 40_000, requested_sim_time_ms: 0, complete_sim_time_ms: 1, accessible: true, command_key: 'k', ...over });
function action(key: string, op: ActionCommand['operation'], jobId: string, status: ActionStatus['status'], req: number, args: Record<string, unknown> = { destination_gpu_ids: DEST }): ActionDetail {
  const command: ActionCommand = { schema_version: V, run_id: RUN, action_id: `act:${key}`, command_key: key, workflow_id: 'wf-1', plan_id: 'p', incident_ids: ['i'], operation: op, target_resource_id: jobId, job_id: jobId, arguments: args, depends_on_command_keys: [], expected_decision_epoch: 1, expected_resource_versions: {}, requested_sim_time_ms: req };
  return { status: { schema_version: V, run_id: RUN, action_id: command.action_id, command_key: key, status, attempt: 1, updated_sim_time_ms: req, result: {}, reason_code: null, version: 1 }, command, claimed_by: null, due_sim_time_ms: null, safety: null, start_safety: null, history: [] };
}
const recovery = (over: Partial<RecoveryView> = {}): RecoveryView => ({ status: 'waiting', job_ids: ['job-a', 'job-b'], blocked_reason: 'no capacity', first_wait_unix_ms: 1_000, attempts: 1, fingerprint: 'fp', ...over });
const wf = (id: string, state: Record<string, unknown>, over: Partial<WorkflowRecord> = {}): WorkflowRecord => ({ workflow_id: id, run_id: RUN, stage: 'plan', state, incident_ids: ['i'], plan_id: 'p', current_command_key: null, last_processed_event_seq: 0, attempt: 1, lease_owner: 'agent-1', lease_expires_unix_ms: 0, fencing_token: 1n, updated_at_unix_ms: 0, version: 1, ...over });
const baseline = { job_id: 'job-b', checkpoint_id: 'ckpt-job-b-1', durable_work_units: 40_000 };

describe('recovery waiting', () => {
  it('parses the frozen shape and rejects anything else', () => {
    expect(parseRecovery(recovery())).not.toBeNull();
    expect(parseRecovery({ ...recovery(), status: 'paused' })).toBeNull();
    expect(parseRecovery({ ...recovery(), first_wait_unix_ms: 'soon' })).toBeNull();
    expect(parseRecovery(undefined)).toBeNull();
  });

  it('collects waiting jobs across workflows, ignoring resumed ones', () => {
    const wfs = [wf('wf-1', { recovery: recovery({ job_ids: ['job-b'] }) }), wf('wf-2', { recovery: recovery({ job_ids: ['job-a'] }) }), wf('wf-3', { recovery: recovery({ status: 'resumed', job_ids: ['job-z'] }) })];
    expect(waitingJobIds(wfs)).toEqual(['job-a', 'job-b']);
  });

  it('requires the checkpoint-backed jobs and refuses a job with no checkpoint', () => {
    expect(checkRecoveryWaiting([wf('wf-1', { recovery: recovery() })], ['job-a', 'job-b'], ['job-c']).ok).toBe(true);
    expect(checkRecoveryWaiting([wf('wf-1', { recovery: recovery({ job_ids: ['job-a'] }) })], ['job-a', 'job-b'], ['job-c']).detail).toMatch(/missing=\[job-b\]/);
    expect(checkRecoveryWaiting([wf('wf-1', { recovery: recovery({ job_ids: ['job-a', 'job-b', 'job-c'] }) })], ['job-a', 'job-b'], ['job-c']).detail).toMatch(/must_not_wait=\[job-c\]/);
  });
});

describe('node outage from observed state', () => {
  const ids = ['node-r1-n1', 'node-r2-n1'];
  const snap = (a: string, b: string, gpu = 'ready') => ({
    nodes: [{ resource_id: ids[0], availability: a }, { resource_id: ids[1], availability: b }],
    gpus: [{ node_id: ids[0], availability: gpu }],
  }) as unknown as Pick<ObservedSnapshot, 'nodes' | 'gpus'>;

  it('all down only when every node is unreachable', () => {
    expect(nodeOutage(snap('unreachable', 'unreachable'), ids)).toMatchObject({ allDown: true, allUp: false });
    expect(nodeOutage(snap('unreachable', 'ready'), ids)).toMatchObject({ allDown: false, allUp: false, unreachable: [ids[0]] });
  });

  it('all up needs every node ready and no GPU still unreachable', () => {
    expect(nodeOutage(snap('ready', 'ready'), ids)).toMatchObject({ allDown: false, allUp: true });
    expect(nodeOutage(snap('ready', 'ready', 'unreachable'), ids).allUp).toBe(false);
    expect(nodeOutage(snap('ready', 'ready'), [...ids, 'node-missing']).allUp).toBe(false);
  });
});

describe('no restart during the outage', () => {
  it('fails on a request inside the window, even one the DB refused', () => {
    expect(checkNoRestartDuringOutage([action('m1', 'migrate_restart', 'job-a', 'failed', START + 5_000)], START, END).ok).toBe(false);
    expect(checkNoRestartDuringOutage([action('m1', 'migrate_restart', 'job-a', 'requested', START)], START, END).ok).toBe(false);
  });

  it('allows restarts at or after the true end, requests before the outage, and other operations', () => {
    expect(checkNoRestartDuringOutage([action('m1', 'migrate_restart', 'job-a', 'succeeded', END), action('m0', 'migrate_restart', 'job-a', 'succeeded', START - 1), action('e1', 'escalate', 'job-c', 'succeeded', START + 1)], START, END).ok).toBe(true);
  });
});

describe('restart from a completed checkpoint', () => {
  const moved = action('m1', 'migrate_restart', 'job-b', 'succeeded', END + 2_000);

  it('baseline needs a complete, accessible latest checkpoint', () => {
    expect(checkpointBaseline(job('job-b'), [ckpt()])).toEqual(baseline);
    expect(checkpointBaseline(job('job-c', { latest_checkpoint_id: null }), [ckpt()])).toBeNull();
    expect(checkpointBaseline(job('job-b'), [ckpt({ status: 'writing' })])).toBeNull();
    expect(checkpointBaseline(job('job-b'), [ckpt({ accessible: false })])).toBeNull();
    expect(checkpointBaseline(null, [ckpt()])).toBeNull();
  });

  it('passes for a succeeded move, on its destination, from the checkpoint', () => {
    expect(checkRestartFromCheckpoint([moved], job('job-b'), [ckpt()], baseline, END).ok).toBe(true);
  });

  it('fails without a post-outage move, off destination, on a lost checkpoint, or below the checkpoint', () => {
    const early = action('m0', 'migrate_restart', 'job-b', 'succeeded', START);
    expect(checkRestartFromCheckpoint([early], job('job-b'), [ckpt()], baseline, END).detail).toMatch(/no running\/succeeded/);
    expect(checkRestartFromCheckpoint([moved], job('job-b', { allocated_gpu_ids: ['gpu-r6-n1-0'] }), [ckpt()], baseline, END).detail).toMatch(/not on the migrate destination/);
    expect(checkRestartFromCheckpoint([moved], job('job-b'), [ckpt({ status: 'failed' })], baseline, END).detail).toMatch(/not complete and accessible/);
    expect(checkRestartFromCheckpoint([moved], job('job-b', { progress_work_units: 10 }), [ckpt()], baseline, END).detail).toMatch(/below the checkpoint/);
    expect(checkRestartFromCheckpoint([moved], job('job-b', { status: 'failed' }), [ckpt()], baseline, END).detail).toMatch(/job is failed/);
    expect(checkRestartFromCheckpoint([moved], null, [ckpt()], baseline, END).ok).toBe(false);
  });

  it('work must strictly advance', () => {
    expect(checkWorkAdvanced('job-a', 100, 101).ok).toBe(true);
    expect(checkWorkAdvanced('job-a', 100, 100).ok).toBe(false);
  });

  it('exactly one placement per job, counting only moves that ran', () => {
    const a = action('ma', 'migrate_restart', 'job-a', 'succeeded', END);
    const b = action('mb', 'migrate_restart', 'job-b', 'succeeded', END);
    const cancelled = action('mb0', 'migrate_restart', 'job-b', 'cancelled', END);
    expect(checkSinglePlacement([a, b, cancelled], ['job-a', 'job-b'], START).ok).toBe(true);
    expect(checkSinglePlacement([a], ['job-a', 'job-b'], START).detail).toMatch(/job-b: 0/);
    expect(checkSinglePlacement([a, b, action('mb2', 'migrate_restart', 'job-b', 'running', END + 1)], ['job-a', 'job-b'], START).ok).toBe(false);
  });
});

describe('job with no checkpoint', () => {
  const failed = job('job-c', { status: 'failed', allocated_gpu_ids: [], latest_checkpoint_id: null });

  it('stays failed with no restart request', () => {
    expect(checkNotRestarted([], failed, 'job-c', START).ok).toBe(true);
    expect(checkNotRestarted([action('m', 'migrate_restart', 'job-c', 'failed', END)], failed, 'job-c', START).ok).toBe(false);
    expect(checkNotRestarted([], job('job-c', { status: 'running' }), 'job-c', START).ok).toBe(false);
    expect(checkNotRestarted([], null, 'job-c', START).ok).toBe(false);
  });

  it('must be named in a persisted handoff or an escalation', () => {
    expect(checkJobInOperatorHandoff([wf('wf-1', { verification: { unresolved: ['job-c needs an operator'] } }, { stage: 'done' })], [], 'job-c').ok).toBe(true);
    expect(checkJobInOperatorHandoff([wf('wf-1', { escalation_reason: 'job-c has no checkpoint' }, { stage: 'escalated' })], [], 'job-c').ok).toBe(true);
    expect(checkJobInOperatorHandoff([], [action('e', 'escalate', 'job-c', 'succeeded', END, {})], 'job-c').ok).toBe(true);
  });

  it('does not accept a different job, a similar id, or a workflow with no handoff', () => {
    expect(checkJobInOperatorHandoff([wf('wf-1', { verification: { jobs: ['job-a'] } }, { stage: 'done' })], [], 'job-c').ok).toBe(false);
    expect(checkJobInOperatorHandoff([wf('wf-1', { verification: { jobs: ['job-cool', 'job-c-2'] } }, { stage: 'done' })], [], 'job-c').ok).toBe(false);
    expect(checkJobInOperatorHandoff([wf('wf-1', { note: 'job-c' }, { stage: 'done' })], [], 'job-c').ok).toBe(false);
  });
});

describe('first wait survives a restart (SBK)', () => {
  const before: RecoverySample = { workflow_id: 'wf-1', lease_owner: 'agent-1', attempt: 1, wall_unix_ms: 5, recovery: recovery() };
  const sample = (owner: string | null, firstWait: number): RecoverySample => ({ ...before, lease_owner: owner, recovery: recovery({ first_wait_unix_ms: firstWait }) });

  it('passes when the new owner keeps the value', () => {
    expect(checkFirstWaitPreserved(before, [before, sample('agent-2', 1_000)]).ok).toBe(true);
  });

  it('fails if the new owner restarts the wait clock', () => {
    expect(checkFirstWaitPreserved(before, [sample('agent-2', 9_999)]).detail).toMatch(/changed to 9999/);
  });

  it('fails when no new owner was ever observed: the old owner proves nothing', () => {
    expect(checkFirstWaitPreserved(before, [before]).ok).toBe(false);
    expect(checkFirstWaitPreserved(before, [sample(null, 1_000)]).ok).toBe(false);
  });

  it('samples only on a change of status, attempts, first wait or owner', () => {
    const samples: RecoverySample[] = [];
    const w = wf('wf-1', { recovery: recovery() });
    recordRecoverySamples(samples, [w], 1);
    recordRecoverySamples(samples, [w], 2);
    expect(samples).toHaveLength(1);
    recordRecoverySamples(samples, [wf('wf-1', { recovery: recovery() }, { lease_owner: 'agent-2' })], 3);
    recordRecoverySamples(samples, [wf('wf-1', { recovery: recovery({ status: 'resumed' }) }, { lease_owner: 'agent-2' })], 4);
    expect(samples.map((s) => [s.lease_owner, s.recovery.status])).toEqual([['agent-1', 'waiting'], ['agent-2', 'waiting'], ['agent-2', 'resumed']]);
  });
});
