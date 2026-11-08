import { describe, expect, it } from 'vitest';
import { validatePayload, type ActionCommand, type GpuCurrent, type TelemetryEvent } from '@dcos/contracts';
import { createMockClient, isDbError, isSafetyRejected, MOCK_FIXTURES, parseDbError, type DbChange } from '../src/index.js';

const manualClock = () => {
  let t = 1_794_091_200_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

const checkpointCmd = (over: Partial<ActionCommand> = {}): ActionCommand => ({
  schema_version: '1.1.0',
  run_id: 'run-demo-1',
  action_id: 'act-1',
  command_key: 'wf-1:ckpt:job-a',
  workflow_id: 'wf-1',
  plan_id: 'plan-1',
  incident_ids: ['inc-1'],
  operation: 'checkpoint',
  target_resource_id: 'job-a',
  job_id: 'job-a',
  arguments: {},
  depends_on_command_keys: [],
  expected_decision_epoch: 0,
  expected_resource_versions: {},
  requested_sim_time_ms: 0,
  ...over,
});

describe('createMockClient', () => {
  it('serves a contract-valid ObservedSnapshot of gpu_demo_8', async () => {
    const db = createMockClient();
    const snap = await db.getObservedSnapshot();
    expect(validatePayload('ObservedSnapshot', snap)).toEqual({ ok: true });
    expect(snap.gpus).toHaveLength(64);
    expect(snap.job_states.map((j) => j.job_id).sort()).toEqual(['job-a', 'job-b', 'job-c']);
    expect(validatePayload('ObservedSnapshot', MOCK_FIXTURES.pump_degraded)).toEqual({ ok: true });
    expect(validatePayload('SignalEvent', MOCK_FIXTURES.signal_xid79)).toEqual({ ok: true });
  });

  it('records calls', async () => {
    const db = createMockClient();
    await db.getActionStatus('nope');
    expect(db.calls).toEqual([{ method: 'getActionStatus', args: ['nope'] }]);
  });

  it('requestAction is idempotent by command_key and rejects a changed payload', async () => {
    const db = createMockClient();
    const statuses = await Promise.all(Array.from({ length: 10 }, () => db.requestAction(checkpointCmd())));
    expect(new Set(statuses.map((s) => s.action_id)).size).toBe(1);
    expect(statuses[0]!.status).toBe('requested');
    // requested_sim_time_ms is excluded from the payload hash (§0.11 #2)
    await expect(db.requestAction(checkpointCmd({ requested_sim_time_ms: 5000 }))).resolves.toMatchObject({ version: 1 });
    const err = await db.requestAction(checkpointCmd({ job_id: 'job-b' })).catch((e) => e);
    expect(isDbError(err, 'COMMAND_KEY_COLLISION')).toBe(true);
  });

  it('a stale decision epoch is persisted as SAFETY_REJECTED, not thrown', async () => {
    const db = createMockClient();
    const s = await db.requestAction(checkpointCmd({ expected_decision_epoch: 7 }));
    expect(isSafetyRejected(s)).toBe(true);
    expect(s.result).toEqual({ violations: ['STALE_DECISION_EPOCH'] });
  });

  it('uses a plugged-in evaluateSafety', async () => {
    const db = createMockClient({
      evaluateSafety: (_o, cmd) => ({
        schema_version: '1.1.0',
        run_id: cmd.run_id,
        plan_id: cmd.plan_id,
        action_id: cmd.action_id,
        decision: 'deny',
        checked_decision_epoch: 0,
        violations: ['DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT'],
        checked_resource_ids: ['rack-r6'],
        evidence: {},
      }),
    });
    const s = await db.requestAction(checkpointCmd());
    expect(isSafetyRejected(s)).toBe(true);
    expect(s.result).toEqual({ violations: ['DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT'] });
  });

  it('checkpoint lifecycle: requested -> claimed -> running -> succeeded over ticks; durable only at the end', async () => {
    const db = createMockClient();
    const changes: DbChange[] = [];
    db.onChange((c) => changes.push(c));
    await db.requestAction(checkpointCmd());
    const { fencing_token } = await db.claimAction('wf-1:ckpt:job-a', 1, 'worker-1');
    await db.startAction('wf-1:ckpt:job-a', fencing_token);
    const durableBefore = (await db.getObservedSnapshot()).job_states.find((j) => j.job_id === 'job-a')!.durable_work_units;
    for (let i = 0; i < 29; i++) db.tick();
    expect((await db.getActionStatus('wf-1:ckpt:job-a'))!.status).toBe('running');
    const mid = (await db.getObservedSnapshot()).job_states.find((j) => j.job_id === 'job-a')!;
    expect(mid.durable_work_units).toBe(durableBefore);
    db.tick();
    expect((await db.getActionStatus('wf-1:ckpt:job-a'))!.status).toBe('succeeded');
    const after = (await db.getObservedSnapshot()).job_states.find((j) => j.job_id === 'job-a')!;
    expect(after.durable_work_units).toBe(after.progress_work_units);
    expect(changes.filter((c) => c.kind === 'action_status').map((c) => (c.kind === 'action_status' ? c.status.status : '')))
      .toEqual(['requested', 'claimed', 'running', 'succeeded']);
  });

  it('rejects a stale fencing token and a wrong claim version', async () => {
    const db = createMockClient();
    await db.requestAction(checkpointCmd());
    expect(isDbError(await db.claimAction('wf-1:ckpt:job-a', 99, 'w').catch((e) => e), 'VERSION_CONFLICT')).toBe(true);
    const { fencing_token } = await db.claimAction('wf-1:ckpt:job-a', 1, 'w');
    expect(isDbError(await db.startAction('wf-1:ckpt:job-a', fencing_token + 1n).catch((e) => e), 'STALE_FENCING_TOKEN')).toBe(true);
  });

  it('running actions cannot be cancelled; requested ones can', async () => {
    const db = createMockClient();
    await db.requestAction(checkpointCmd());
    const { fencing_token } = await db.claimAction('wf-1:ckpt:job-a', 1, 'w');
    await db.startAction('wf-1:ckpt:job-a', fencing_token);
    expect(isDbError(await db.cancelAction('wf-1:ckpt:job-a', 'SUPERSEDED', fencing_token).catch((e) => e), 'INVALID_TRANSITION')).toBe(true);
  });

  it('workflow lease: two workers cannot both own it; heartbeat keeps version; expiry allows takeover', async () => {
    const clock = manualClock();
    const db = createMockClient({ now: clock.now });
    const a = await db.claimWorkflow('wf-1', 'worker-a', 0, 10_000);
    expect(isDbError(await db.claimWorkflow('wf-1', 'worker-b', 1, 10_000).catch((e) => e), 'LEASE_HELD')).toBe(true);
    const hb = await db.heartbeatWorkflow('wf-1', 'worker-a', a.fencing_token, 10_000);
    expect(hb.workflow.version).toBe(a.workflow.version);
    clock.advance(20_000);
    const b = await db.claimWorkflow('wf-1', 'worker-b', 1, 10_000);
    expect(b.fencing_token).toBeGreaterThan(a.fencing_token);
    const err = await db.updateWorkflow('wf-1', b.workflow.version, a.fencing_token, 'plan', {}).catch((e) => e);
    expect(isDbError(err, 'STALE_FENCING_TOKEN')).toBe(true);
    const updated = await db.updateWorkflow('wf-1', b.workflow.version, b.fencing_token, 'plan', { incident_ids: ['inc-1'] });
    expect(updated.version).toBe(b.workflow.version + 1);
    expect(updated.incident_ids).toEqual(['inc-1']);
  });

  it('subscriptions fire immediately and on change; injectFault xid79 fails job-a and emits a signal', async () => {
    const db = createMockClient();
    const gpuUpdates: GpuCurrent[][] = [];
    db.onGpu((g) => gpuUpdates.push(g));
    expect(gpuUpdates).toHaveLength(1);
    const changes: DbChange[] = [];
    db.onChange((c) => changes.push(c));
    await db.injectFault({
      schema_version: '1.1.0',
      fault_id: 'f-1',
      run_id: 'run-demo-1',
      target_resource_id: 'gpu-r3-n1-0',
      kind: 'gpu_xid_79',
      start_sim_time_ms: 0,
      duration_sim_ms: null,
      severity: 1,
      parameters: {},
      seed_offset: 0,
    });
    expect(gpuUpdates.at(-1)!.find((g) => g.resource_id === 'gpu-r3-n1-0')!.availability).toBe('unreachable');
    expect(changes.map((c) => c.kind)).toEqual(expect.arrayContaining(['signal', 'resource_version', 'decision_epoch']));
    const jobA = (await db.getObservedSnapshot()).job_states.find((j) => j.job_id === 'job-a')!;
    expect(jobA.status).toBe('failed');
    // private truth stays out of agent reads
    expect(JSON.stringify(await db.getEvidence([], 1e9))).not.toContain('f-1');
  });

  it('ingestObservations rejects duplicate event ids and old source_seq atomically', async () => {
    const db = createMockClient();
    const ev = (event_id: string, source_seq: number): TelemetryEvent => ({
      schema_version: '1.1.0',
      event_id,
      run_id: 'run-demo-1',
      resource_id: 'gpu-real-0',
      source_kind: 'hardware',
      source_id: 'nvsmi-1',
      source_seq,
      observed_unix_ms: 1,
      sim_time_ms: 0,
      metric: 'nvidia_smi.temperature_gpu',
      value: 55,
      unit: 'degC',
      quality: 'good',
      labels: { collector: 'nvidia-smi' },
    });
    await db.ingestObservations([ev('e1', 1), ev('e2', 2)]);
    expect(isDbError(await db.ingestObservations([ev('e1', 3)]).catch((e) => e), 'INVALID_PAYLOAD')).toBe(true);
    expect(isDbError(await db.ingestObservations([ev('e3', 2)]).catch((e) => e), 'INVALID_PAYLOAD')).toBe(true);
    expect((await db.getEvidence([], 1e9)).telemetry).toHaveLength(2);
  });

  it('two migrations onto the same destination GPUs cannot both be claimed', async () => {
    const db = createMockClient();
    const dest = ['gpu-r7-n1-0', 'gpu-r7-n1-1'];
    const mig = (key: string, job: string): ActionCommand =>
      checkpointCmd({ command_key: key, action_id: key, operation: 'migrate_restart', target_resource_id: job, job_id: job, arguments: { destination_gpu_ids: dest } });
    await db.requestAction(mig('m-a', 'job-a'));
    await db.requestAction(mig('m-b', 'job-b'));
    await db.claimAction('m-a', 1, 'w');
    expect(isDbError(await db.claimAction('m-b', 1, 'w').catch((e) => e), 'LEASE_HELD')).toBe(true);
  });

  it('a stale expected_resource_version is SAFETY_REJECTED', async () => {
    const db = createMockClient();
    const s = await db.requestAction(checkpointCmd({ expected_resource_versions: { 'gpu-r2-n1-0': 42 } }));
    expect(isSafetyRejected(s)).toBe(true);
    expect(s.result).toEqual({ violations: ['STALE_RESOURCE_VERSION'] });
  });

  it('claim records claimed_by; power cap emits resource_version; updateWorkflow clears nulls', async () => {
    const db = createMockClient();
    const changes: DbChange[] = [];
    db.onChange((c) => changes.push(c));
    await db.requestAction(checkpointCmd({ operation: 'power_cap', arguments: { power_limit_w: 500 }, command_key: 'cap', action_id: 'cap' }));
    const { status, fencing_token } = await db.claimAction('cap', 1, 'worker-1');
    expect(status.result.claimed_by).toBe('worker-1');
    await db.startAction('cap', fencing_token);
    db.tick();
    expect(changes.some((c) => c.kind === 'resource_version')).toBe(true);
    const l = await db.claimWorkflow('wf-9', 'w', 0, 10_000);
    const w1 = await db.updateWorkflow('wf-9', l.workflow.version, l.fencing_token, 'execute', { current_command_key: 'cap' });
    expect(w1.current_command_key).toBe('cap');
    const w2 = await db.updateWorkflow('wf-9', w1.version, l.fencing_token, 'verify', { current_command_key: null });
    expect(w2.current_command_key).toBeNull();
  });

  it('parseDbError turns reducer strings into coded errors', () => {
    const e = parseDbError(new Error('LEASE_HELD: wf-1 owned by worker-a'));
    expect(isDbError(e, 'LEASE_HELD')).toBe(true);
    expect(isDbError(parseDbError(new Error('boom')))).toBe(false);
  });
});
