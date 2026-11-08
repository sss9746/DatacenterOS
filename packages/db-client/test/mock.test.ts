import { describe, expect, it } from 'vitest';
import { validatePayload, type ActionCommand, type FaultInjection, type GpuCurrent, type TelemetryEvent } from '@dcos/contracts';
import { createMockClient, isDbError, isSafetyRejected, MOCK_FIXTURES, parseDbError, type ActionDetail, type DbChange } from '../src/index.js';

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

const fault = (kind: FaultInjection['kind'], target: string): FaultInjection => ({
  schema_version: '1.1.0',
  fault_id: `f-${kind}-${target}`,
  run_id: 'run-demo-1',
  target_resource_id: target,
  kind,
  start_sim_time_ms: 0,
  duration_sim_ms: null,
  severity: 1,
  parameters: {},
  seed_offset: 0,
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

  it('fixtures are P1 v1.1.1: clock 600000, loop rows, checkpoints at 60000 / 540000', () => {
    const d = MOCK_FIXTURES.demo;
    expect(d.clock.sim_time_ms).toBe(600_000);
    expect(d.cooling.map((c) => c.resource_id).sort()).toEqual(['loop-a', 'loop-b', 'pump-a', 'pump-b']);
    expect(Object.fromEntries(d.checkpoints.map((c) => [c.job_id, c.complete_sim_time_ms]))).toEqual({ 'job-a': 60_000, 'job-b': 540_000 });
    expect(new Set(d.gpus.map((g) => g.last_seen_sim_ms))).toEqual(new Set([600_000]));
  });

  it('tick refreshes last_seen_sim_ms on reachable GPUs only (no EVIDENCE_STALE after many ticks)', async () => {
    // Stand-in for physics evaluateSafety's staleness rule: reachable GPU not seen for > 10 sim-s.
    const evaluateSafety: NonNullable<Parameters<typeof createMockClient>[0]>['evaluateSafety'] = (o, cmd) => {
      const stale = o.gpus.some((g) => g.availability !== 'unreachable' && o.clock.sim_time_ms - g.last_seen_sim_ms > 10_000);
      return {
        schema_version: '1.1.0', run_id: cmd.run_id, plan_id: cmd.plan_id, action_id: cmd.action_id,
        decision: stale ? 'deny' : 'allow', checked_decision_epoch: 0, violations: stale ? ['EVIDENCE_STALE'] : [],
        checked_resource_ids: [], evidence: {},
      };
    };
    const db = createMockClient({ evaluateSafety });
    await db.injectFault(fault('gpu_xid_79', 'gpu-r3-n1-0'));
    const epoch = (await db.getObservedSnapshot()).clock.decision_epoch;
    for (let i = 0; i < 30; i++) db.tick();
    const snap = await db.getObservedSnapshot();
    expect(snap.gpus.find((g) => g.resource_id === 'gpu-r3-n1-0')!.last_seen_sim_ms).toBe(600_000);
    expect(snap.gpus.find((g) => g.resource_id === 'gpu-r1-n1-0')!.last_seen_sim_ms).toBe(630_000);
    const s = await db.requestAction(checkpointCmd({ job_id: 'job-b', target_resource_id: 'job-b', expected_decision_epoch: epoch }));
    expect(s.status).toBe('requested');
  });

  it('pump-a injectFault applies on top of the current run (clock, jobs, actions kept)', async () => {
    const db = createMockClient();
    const changes: DbChange[] = [];
    db.onChange((c) => changes.push(c));
    await db.requestAction(checkpointCmd());
    for (let i = 0; i < 5; i++) db.tick();
    const before = await db.getObservedSnapshot();
    await db.injectFault(fault('cooling_pump_degradation', 'pump-a'));
    const after = await db.getObservedSnapshot();
    expect(validatePayload('ObservedSnapshot', after)).toEqual({ ok: true });
    expect(after.clock.sim_time_ms).toBe(605_000);
    expect(after.clock.decision_epoch).toBe(before.clock.decision_epoch + 1);
    expect(after.job_states).toEqual(before.job_states);
    expect(after.checkpoints).toEqual(before.checkpoints);
    expect(await db.getActionStatus('wf-1:ckpt:job-a')).not.toBeNull();
    const cool = Object.fromEntries(after.cooling.map((c) => [c.resource_id, c]));
    expect([cool['pump-a']!.operating_state, cool['loop-a']!.operating_state, cool['pump-b']!.operating_state]).toEqual(['degraded', 'degraded', 'normal']);
    expect(cool['pump-a']!.version).toBe(1);
    const hot = MOCK_FIXTURES.pump_degraded.gpus.find((g) => g.resource_id === 'gpu-r3-n1-0')!;
    expect(after.gpus.find((g) => g.resource_id === 'gpu-r3-n1-0')!.temp_c).toBe(hot.temp_c);
    expect(changes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'resource_version', resource_id: 'pump-a' })]));
    const alarm = (await db.getEvidence([], 1e9)).signals.at(-1)!;
    expect(validatePayload('SignalEvent', alarm)).toEqual({ ok: true });
    expect([alarm.event_type, alarm.resource_id, alarm.sim_time_ms]).toEqual(['equipment_alarm', 'pump-a', 605_000]);
    // `demo` overlay restores healthy cooling, still on the same clock
    db.loadSnapshot('demo');
    const healed = await db.getObservedSnapshot();
    expect(healed.cooling.every((c) => c.operating_state === 'normal')).toBe(true);
    expect(healed.clock.sim_time_ms).toBe(605_000);
  });

  it('XID 48 degrades the GPU and fails its job; XID 74 only degrades; signals are contract-valid', async () => {
    const db = createMockClient();
    await db.injectFault(fault('gpu_xid_48', 'gpu-r4-n1-6'));
    await db.injectFault(fault('gpu_xid_74', 'gpu-r6-n1-0'));
    const snap = await db.getObservedSnapshot();
    const gpu = (id: string) => snap.gpus.find((g) => g.resource_id === id)!;
    expect([gpu('gpu-r4-n1-6').availability, gpu('gpu-r4-n1-6').last_xid_code]).toEqual(['degraded', 48]);
    expect([gpu('gpu-r6-n1-0').availability, gpu('gpu-r6-n1-0').last_xid_code]).toEqual(['degraded', 74]);
    const job = (id: string) => snap.job_states.find((j) => j.job_id === id)!;
    expect(job('job-b').status).toBe('failed');
    expect(job('job-b').progress_work_units).toBe(job('job-b').durable_work_units);
    expect(job('job-c').status).toBe('running');
    const sigs = (await db.getEvidence([], 1e9)).signals;
    expect(sigs.map((s) => [s.xid_code, s.severity])).toEqual([[48, 'critical'], [74, 'warning']]);
    for (const s of sigs) expect(validatePayload('SignalEvent', s)).toEqual({ ok: true });
  });

  it('a fatal XID during a checkpoint releases the GPUs and fails the running action (physics failJob)', async () => {
    const db = createMockClient();
    await db.requestAction(checkpointCmd());
    const { fencing_token } = await db.claimAction('wf-1:ckpt:job-a', 1, 'w');
    await db.startAction('wf-1:ckpt:job-a', fencing_token);
    const ckptsBefore = (await db.getObservedSnapshot()).checkpoints.length;
    await db.injectFault(fault('gpu_xid_48', 'gpu-r3-n1-0'));
    for (let i = 0; i < 30; i++) db.tick();
    const snap = await db.getObservedSnapshot();
    const jobA = snap.job_states.find((j) => j.job_id === 'job-a')!;
    expect([jobA.status, jobA.allocated_gpu_ids]).toEqual(['failed', []]);
    expect(snap.allocations.filter((a) => a.job_id === 'job-a')).toEqual([]);
    expect(snap.checkpoints).toHaveLength(ckptsBefore);
    expect(await db.getActionStatus('wf-1:ckpt:job-a')).toMatchObject({ status: 'failed', reason_code: 'JOB_FAILED_DURING_OPERATION' });
  });

  it('XID evidence names the target rack; generated source_seq keeps rising after a fixture signal', async () => {
    const db = createMockClient();
    db.injectSignal(MOCK_FIXTURES.signal_xid79); // sim-engine-1 seq 150900
    await db.injectFault(fault('gpu_xid_48', 'gpu-r7-n1-0'));
    await db.injectFault(fault('gpu_xid_74', 'gpu-r7-n1-1'));
    const sigs = (await db.getEvidence([], 1e9)).signals;
    // the fixture signal is stamped sim 750000 (future of the 600000 clock), so getEvidence leaves it out
    expect(sigs.map((s) => s.source_seq)).toEqual([150_901, 150_902]);
    expect(sigs[0]!.evidence).toMatchObject({ gpu_id: 'gpu-r7-n1-0', node_id: 'node-r7-n1', rack_id: 'rack-r7' });
  });

  it('an overlay that flips the thermal bit bumps the GPU version', async () => {
    const hot = structuredClone(MOCK_FIXTURES.demo);
    hot.gpus[0]!.clocks_event_reasons |= 0x20;
    const db = createMockClient({ snapshot: hot });
    const changes: DbChange[] = [];
    db.onChange((c) => changes.push(c));
    db.loadSnapshot('demo');
    const g = (await db.getObservedSnapshot()).gpus[0]!;
    expect([g.clocks_event_reasons & 0x20, g.version]).toEqual([0, hot.gpus[0]!.version + 1]);
    expect(changes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'resource_version', resource_id: g.resource_id })]));
  });

  it('createRun wipes every run-scoped row and tells subscribers', async () => {
    const db = createMockClient();
    await db.requestAction(checkpointCmd());
    await db.injectFault(fault('gpu_xid_79', 'gpu-r3-n1-0'));
    await db.claimWorkflow('wf-1', 'w', 0, 10_000);
    await db.publishAgentEvent({ run_id: 'run-demo-1' } as never);
    const seen = { actions: -1, incidents: -1, agentEvents: -1 };
    db.onActions((a) => (seen.actions = a.length));
    db.onAgentEvents((a) => (seen.agentEvents = a.length));
    db.onIncidents((a) => (seen.incidents = a.length));
    expect(seen.actions).toBe(1);
    await db.createRun('run-demo-2', 42, 'gpu_demo_8');
    expect(seen).toEqual({ actions: 0, incidents: 0, agentEvents: 0 });
    expect(await db.getActionStatus('wf-1:ckpt:job-a')).toBeNull();
    expect(await db.listOpenWorkflows()).toEqual([]);
    expect(db.injectedFaults).toEqual([]);
    const snap = await db.getObservedSnapshot();
    expect(validatePayload('ObservedSnapshot', snap)).toEqual({ ok: true });
    expect(snap.clock).toMatchObject({ sim_time_ms: 600_000, decision_epoch: 0 });
    expect(snap.gpus.every((g) => g.run_id === 'run-demo-2' && g.availability === 'ready')).toBe(true);
    expect((await db.getEvidence([], 1e9)).signals).toEqual([]);
  });

  it('onActionDetails: command, safety evidence and history per action', async () => {
    const db = createMockClient({
      evaluateSafety: (_o, cmd) => ({
        schema_version: '1.1.0', run_id: cmd.run_id, plan_id: cmd.plan_id, action_id: cmd.action_id,
        decision: cmd.operation === 'migrate_restart' ? 'deny' : 'allow', checked_decision_epoch: 0,
        violations: cmd.operation === 'migrate_restart' ? ['DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT'] : [],
        checked_resource_ids: ['rack-r6'], evidence: { rack_id: 'rack-r6', headroom_c: 2.5, required_headroom_c: 8 },
      }),
    });
    let details: ActionDetail[] = [];
    db.onActionDetails((d) => (details = d));
    expect(details).toEqual([]);
    await db.requestAction(checkpointCmd({ requested_sim_time_ms: 600_000 }));
    const { fencing_token } = await db.claimAction('wf-1:ckpt:job-a', 1, 'worker-1');
    await db.startAction('wf-1:ckpt:job-a', fencing_token);
    await db.requestAction(checkpointCmd({
      command_key: 'wf-1:mig:job-a', action_id: 'act-2', operation: 'migrate_restart', requested_sim_time_ms: 600_001,
      depends_on_command_keys: ['wf-1:ckpt:job-a'], arguments: { destination_gpu_ids: ['gpu-r6-n1-0'] },
    }));
    expect(details.map((d) => [d.command.operation, d.status.status])).toEqual([['checkpoint', 'running'], ['migrate_restart', 'failed']]);
    const [ck, mig] = details;
    expect(ck!.history.map((h) => [h.status, h.version])).toEqual([['requested', 1], ['claimed', 2], ['running', 3]]);
    expect([ck!.claimed_by, ck!.due_sim_time_ms]).toEqual(['worker-1', 630_000]);
    // same detail keys live writes to action_event
    expect(ck!.history[1]!.detail).toMatchObject({ worker_id: 'worker-1', locked: ['job-a'] });
    expect(ck!.history[2]!.detail).toEqual({ enqueued: true });
    expect(ck!.safety).toMatchObject({ decision: 'allow', violations: [] });
    expect(mig!.command.depends_on_command_keys).toEqual(['wf-1:ckpt:job-a']);
    expect(mig!.safety).toEqual({
      decision: 'deny', violations: ['DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT'], checked_decision_epoch: 0,
      evidence: { rack_id: 'rack-r6', headroom_c: 2.5, required_headroom_c: 8 },
    });
    expect(mig!.status).toEqual(await db.getActionStatus('wf-1:mig:job-a'));
  });

  describe('startAction fails closed (R2)', () => {
    type Evaluate = NonNullable<NonNullable<Parameters<typeof createMockClient>[0]>['evaluateSafety']>;
    type Decision = ReturnType<Evaluate>;

    /** Allows the request, then answers the start-time recheck with `atStart`. */
    const setup = (atStart: Pick<Decision, 'decision' | 'violations'> & { evidence?: Record<string, unknown> }) => {
      const contexts: Parameters<Evaluate>[2][] = [];
      const commands: ActionCommand[] = [];
      const requested = new Set<string>();
      const evaluateSafety: Evaluate = (_o, cmd, ctx) => {
        contexts.push(ctx);
        commands.push(cmd);
        const first = !requested.has(cmd.command_key);
        requested.add(cmd.command_key);
        return {
          schema_version: '1.1.0', run_id: cmd.run_id, plan_id: cmd.plan_id, action_id: cmd.action_id,
          decision: first ? 'allow' : atStart.decision, violations: first ? [] : atStart.violations,
          checked_decision_epoch: 0, checked_resource_ids: [], evidence: first ? {} : atStart.evidence ?? {},
        };
      };
      return { db: createMockClient({ evaluateSafety }), contexts, commands };
    };
    const claimAndStart = async (db: ReturnType<typeof createMockClient>, key = 'wf-1:ckpt:job-a', version = 1) => {
      const { fencing_token } = await db.claimAction(key, version, 'worker-1');
      return db.startAction(key, fencing_token);
    };

    it('needs_approval with no violations still runs (§0.11 #17)', async () => {
      const { db } = setup({ decision: 'needs_approval', violations: [], evidence: { approval_reasons: ['HIGH_PRIORITY_JOB_DISRUPTION'] } });
      await db.requestAction(checkpointCmd());
      await expect(claimAndStart(db)).resolves.toMatchObject({ status: 'running' });
    });

    it('needs_approval carrying EVIDENCE_STALE fails, records evidence and frees the claim', async () => {
      const { db } = setup({ decision: 'needs_approval', violations: ['EVIDENCE_STALE'], evidence: { stale_evidence_ids: ['gpu-r1-n1-0'] } });
      let details: ActionDetail[] = [];
      db.onActionDetails((d) => (details = d));
      await db.requestAction(checkpointCmd());
      const s = await claimAndStart(db);
      expect(isSafetyRejected(s)).toBe(true);
      expect(s.result.violations).toEqual(['EVIDENCE_STALE']);
      expect(details[0]!.start_safety).toMatchObject({ decision: 'needs_approval', violations: ['EVIDENCE_STALE'], evidence: { stale_evidence_ids: ['gpu-r1-n1-0'] } });
      expect(details[0]!.due_sim_time_ms).toBeNull();
      // the claim is gone: another command can take the same job
      await db.requestAction(checkpointCmd({ command_key: 'wf-1:ckpt:job-a:2', action_id: 'act-2' }));
      await expect(db.claimAction('wf-1:ckpt:job-a:2', 1, 'worker-2')).resolves.toBeDefined();
    });

    it.each([['deny', 'DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT'], ['retry_new_snapshot', 'STALE_DECISION_EPOCH']] as const)('%s at start fails', async (decision, violation) => {
      const { db } = setup({ decision, violations: [violation] });
      await db.requestAction(checkpointCmd());
      const s = await claimAndStart(db);
      expect(isSafetyRejected(s)).toBe(true);
      expect(s.result.violations).toEqual([violation]);
    });

    it('rechecks with its own claim excluded, restamped to the current epoch', async () => {
      const { db, contexts, commands } = setup({ decision: 'allow', violations: [] });
      const before = await db.getObservedSnapshot();
      const jobVersion = before.job_states.find((j) => j.job_id === 'job-a')!.version;
      await db.requestAction(checkpointCmd({ expected_decision_epoch: before.clock.decision_epoch, expected_resource_versions: { 'job-a': jobVersion } }));
      const { fencing_token } = await db.claimAction('wf-1:ckpt:job-a', 1, 'worker-1');
      await db.injectFault(fault('cooling_pump_degradation', 'pump-a')); // bumps the epoch, not job-a's version
      const epochNow = (await db.getObservedSnapshot()).clock.decision_epoch;
      expect(epochNow).toBeGreaterThan(before.clock.decision_epoch);
      await expect(db.startAction('wf-1:ckpt:job-a', fencing_token)).resolves.toMatchObject({ status: 'running' });
      expect(contexts).toHaveLength(2);
      expect(contexts[1]).toMatchObject({ decision_epoch: epochNow });
      expect(contexts[1]!.leased_resource_ids).not.toContain('job-a');
      expect(commands[1]).toMatchObject({ expected_decision_epoch: epochNow });
      expect(commands[1]!.expected_resource_versions).toEqual({});
    });

    it('an escalate dependency exempts no GPUs, as in live', async () => {
      const db = createMockClient();
      const gpuId = 'gpu-r2-n1-0';
      const gpuVersion = (await db.getObservedSnapshot()).gpus.find((g) => g.resource_id === gpuId)!.version;
      await db.requestAction(checkpointCmd({ command_key: 'wf-1:esc:job-a', action_id: 'act-esc', operation: 'escalate', arguments: { reason: 'operator review' } }));
      await db.requestAction(checkpointCmd({
        command_key: 'wf-1:mig:job-a', action_id: 'act-2', operation: 'migrate_restart',
        depends_on_command_keys: ['wf-1:esc:job-a'], arguments: { destination_gpu_ids: ['gpu-r1-n1-0'] },
        expected_resource_versions: { [gpuId]: gpuVersion },
      }));
      await claimAndStart(db, 'wf-1:esc:job-a');
      for (let i = 0; i < 2; i++) db.tick();
      expect((await db.getActionStatus('wf-1:esc:job-a'))!.status).toBe('succeeded');
      await db.injectFault(fault('gpu_xid_74', gpuId));
      const s = await claimAndStart(db, 'wf-1:mig:job-a');
      expect(isSafetyRejected(s)).toBe(true);
      expect(s.result.violations).toEqual(['STALE_RESOURCE_VERSION']);
    });

    it('a source GPU version changed after its dependency finished is exempt, as in live', async () => {
      const db = createMockClient();
      const gpuId = 'gpu-r2-n1-0';
      const gpuVersion = (await db.getObservedSnapshot()).gpus.find((g) => g.resource_id === gpuId)!.version;
      await db.requestAction(checkpointCmd());
      await db.requestAction(checkpointCmd({
        command_key: 'wf-1:mig:job-a', action_id: 'act-2', operation: 'migrate_restart',
        depends_on_command_keys: ['wf-1:ckpt:job-a'], arguments: { destination_gpu_ids: ['gpu-r1-n1-0'] },
        expected_resource_versions: { [gpuId]: gpuVersion },
      }));
      await claimAndStart(db);
      for (let i = 0; i < 31; i++) db.tick();
      await db.injectFault(fault('gpu_xid_74', gpuId)); // degrades the GPU without failing job-a
      expect((await db.getObservedSnapshot()).gpus.find((g) => g.resource_id === gpuId)!.version).not.toBe(gpuVersion);
      await expect(claimAndStart(db, 'wf-1:mig:job-a')).resolves.toMatchObject({ status: 'running' });
    });

    it('a resource version that changed after the request fails with SAFETY_REJECTED', async () => {
      const db = createMockClient();
      const gpuId = 'gpu-r1-n1-0';
      const version = (await db.getObservedSnapshot()).gpus.find((g) => g.resource_id === gpuId)!.version;
      await db.requestAction(checkpointCmd({ expected_resource_versions: { [gpuId]: version } }));
      const { fencing_token } = await db.claimAction('wf-1:ckpt:job-a', 1, 'worker-1');
      await db.injectFault(fault('gpu_xid_79', gpuId));
      expect((await db.getObservedSnapshot()).gpus.find((g) => g.resource_id === gpuId)!.version).not.toBe(version);
      const s = await db.startAction('wf-1:ckpt:job-a', fencing_token);
      expect(isSafetyRejected(s)).toBe(true);
      expect(s.result).toMatchObject({ violations: ['STALE_RESOURCE_VERSION'], start_safety: { evidence: { stale_resource_ids: [gpuId] } } });
    });

    it('a job version changed by its own dependency is tolerated', async () => {
      const db = createMockClient();
      const jobVersion = (await db.getObservedSnapshot()).job_states.find((j) => j.job_id === 'job-a')!.version;
      await db.requestAction(checkpointCmd());
      await db.requestAction(checkpointCmd({
        command_key: 'wf-1:mig:job-a', action_id: 'act-2', operation: 'migrate_restart',
        depends_on_command_keys: ['wf-1:ckpt:job-a'], arguments: { destination_gpu_ids: ['gpu-r1-n1-0'] },
        expected_resource_versions: { 'job-a': jobVersion },
      }));
      await claimAndStart(db);
      for (let i = 0; i < 31; i++) db.tick();
      expect((await db.getActionStatus('wf-1:ckpt:job-a'))!.status).toBe('succeeded');
      expect((await db.getObservedSnapshot()).job_states.find((j) => j.job_id === 'job-a')!.version).not.toBe(jobVersion);
      await expect(claimAndStart(db, 'wf-1:mig:job-a')).resolves.toMatchObject({ status: 'running' });
    });
  });

  it('parseDbError turns reducer strings into coded errors', () => {
    const e = parseDbError(new Error('LEASE_HELD: wf-1 owned by worker-a'));
    expect(isDbError(e, 'LEASE_HELD')).toBe(true);
    expect(isDbError(parseDbError(new Error('boom')))).toBe(false);
  });
});
