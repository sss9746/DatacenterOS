import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validatePayload, type ActionCommand, type ObservedSnapshot } from '@dcos/contracts';
import { CLOCKS_EVENT_SW_POWER_CAP, CLOCKS_EVENT_SW_THERMAL, DbError, isDbError, isSafetyRejected, type DbChange } from '../src/ports.js';
import { FakeDb, FakeLlm, FakePhysics, FAKE_PHYSICS_BANNER, commandPayloadHash } from './fakes/index.js';
import { gpuId, loadPumpDegradedSnapshot, loadSignalXid79Dest, loadSignalXid79R7 } from './fixtures/index.js';

const rackGpus = (r: number) => Array.from({ length: 8 }, (_, g) => gpuId(r, g));

function cmd(obs: ObservedSnapshot, over: Partial<ActionCommand> = {}): ActionCommand {
  return {
    schema_version: '1.1.0',
    run_id: obs.run_id,
    action_id: 'act-1',
    command_key: 'wf-1:job-a:checkpoint:1',
    workflow_id: 'wf-1',
    plan_id: 'plan-1',
    incident_ids: ['inc-cooling-1'],
    operation: 'checkpoint',
    target_resource_id: 'job-a',
    job_id: 'job-a',
    arguments: {},
    depends_on_command_keys: [],
    expected_decision_epoch: obs.clock.decision_epoch,
    expected_resource_versions: {},
    requested_sim_time_ms: obs.clock.sim_time_ms,
    ...over,
  };
}

const migrateA = (obs: ObservedSnapshot, dest: string[], over: Partial<ActionCommand> = {}) =>
  cmd(obs, {
    action_id: 'act-2',
    command_key: 'wf-1:job-a:migrate:1',
    operation: 'migrate_restart',
    arguments: { destination_gpu_ids: dest },
    depends_on_command_keys: ['wf-1:job-a:checkpoint:1'],
    ...over,
  });

async function expectDbError(p: Promise<unknown>, code: DbError['code']): Promise<DbError> {
  try {
    await p;
  } catch (e) {
    expect(isDbError(e, code), String(e)).toBe(true);
    return e as DbError;
  }
  throw new Error(`expected DbError ${code}`);
}

describe('FakeDb actions (TEST-ONLY)', () => {
  it('requestAction is idempotent by command_key', async () => {
    const obs = loadPumpDegradedSnapshot();
    const db = new FakeDb({ snapshot: obs });
    const c = cmd(obs);
    const first = await db.requestAction(c);
    for (let i = 0; i < 9; i++) expect(await db.requestAction({ ...c, requested_sim_time_ms: c.requested_sim_time_ms + i })).toEqual(first);
    expect(db.listActions()).toHaveLength(1);
    expect(validatePayload('ActionStatus', first)).toEqual({ ok: true });
  });

  it('rejects a reused command_key with a different payload (COMMAND_KEY_COLLISION)', async () => {
    const obs = loadPumpDegradedSnapshot();
    const db = new FakeDb({ snapshot: obs });
    await db.requestAction(cmd(obs));
    await expectDbError(db.requestAction(cmd(obs, { arguments: { reason: 'changed' } })), 'COMMAND_KEY_COLLISION');
  });

  it('drives requested -> claimed -> running -> succeeded via tick, honoring fencing and dependencies', async () => {
    const obs = loadPumpDegradedSnapshot();
    const db = new FakeDb({ snapshot: obs });
    const changes: DbChange[] = [];
    db.onChange((c) => changes.push(c));
    const ck = await db.requestAction(cmd(obs));
    const mv = await db.requestAction(migrateA(obs, rackGpus(7).concat(rackGpus(8))));

    const { status: claimed, fencing_token } = await db.claimAction(ck.command_key, ck.version, 'worker-1');
    expect(claimed.status).toBe('claimed');
    await expectDbError(db.claimAction(ck.command_key, ck.version, 'worker-2'), 'VERSION_CONFLICT');
    await expectDbError(db.startAction(ck.command_key, fencing_token - 1n), 'STALE_FENCING_TOKEN');
    expect((await db.startAction(ck.command_key, fencing_token)).status).toBe('running');

    const mvClaim = await db.claimAction(mv.command_key, mv.version, 'worker-1');
    await expectDbError(db.startAction(mv.command_key, mvClaim.fencing_token), 'INVALID_TRANSITION'); // checkpoint not done

    db.tick(29_000);
    expect((await db.getActionStatus(ck.command_key))!.status).toBe('running');
    db.tick(1_000);
    const done = (await db.getActionStatus(ck.command_key))!;
    expect(done.status).toBe('succeeded');
    const snap = await db.getObservedSnapshot();
    const jobA = snap.job_states.find((j) => j.job_id === 'job-a')!;
    expect(jobA.durable_work_units).toBe(jobA.progress_work_units);
    expect(changes.filter((c) => c.kind === 'action_status').length).toBeGreaterThanOrEqual(4);

    await db.startAction(mv.command_key, mvClaim.fencing_token);
    db.tick(120_000);
    const after = await db.getObservedSnapshot();
    expect(after.job_states.find((j) => j.job_id === 'job-a')!.allocated_gpu_ids).toEqual(rackGpus(7).concat(rackGpus(8)));
    expect(validatePayload('ObservedSnapshot', after)).toEqual({ ok: true });
    expect(db.calls.filter((c) => c.method === 'requestAction')).toHaveLength(2);
  });

  it('cancels only safe-to-cancel actions', async () => {
    const obs = loadPumpDegradedSnapshot();
    const db = new FakeDb({ snapshot: obs });
    const a = await db.requestAction(cmd(obs));
    const { fencing_token } = await db.claimAction(a.command_key, a.version, 'w');
    await db.startAction(a.command_key, fencing_token);
    await expectDbError(db.cancelAction(a.command_key, 'SUPERSEDED', fencing_token), 'INVALID_TRANSITION');
    const b = await db.requestAction(cmd(obs, { command_key: 'k-b', action_id: 'act-b', job_id: 'job-b', target_resource_id: 'job-b' }));
    expect((await db.cancelAction(b.command_key, 'SUPERSEDED', 0n)).status).toBe('cancelled');
  });

  it('re-checks safety on request when given a PhysicsPort (STALE_DECISION_EPOCH, r6 headroom)', async () => {
    const obs = loadPumpDegradedSnapshot();
    const db = new FakeDb({ snapshot: obs, physics: new FakePhysics() });
    db.bumpDecisionEpoch();
    const stale = await db.requestAction(cmd(obs)); // no throw (§0.11 #3)
    expect(isSafetyRejected(stale)).toBe(true);
    expect(stale.result.violations).toContain('STALE_DECISION_EPOCH');
    const fresh = await db.getObservedSnapshot();
    const toR6 = await db.requestAction(migrateA(fresh, rackGpus(6).concat(rackGpus(7))));
    expect(isSafetyRejected(toR6)).toBe(true);
    expect(toR6.result.violations).toContain('DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT');
  });

  it('persists a safety deny as failed/SAFETY_REJECTED, logs an action event, and replays it idempotently (§0.11 #3)', async () => {
    const obs = loadPumpDegradedSnapshot();
    const db = new FakeDb({ snapshot: obs, physics: new FakePhysics() });
    const changes: DbChange[] = [];
    db.onChange((c) => changes.push(c));
    const c = migrateA(obs, rackGpus(6).concat(rackGpus(7)));
    const s = await db.requestAction(c);
    expect([s.status, s.reason_code]).toEqual(['failed', 'SAFETY_REJECTED']);
    expect(validatePayload('ActionStatus', s)).toEqual({ ok: true });
    expect(await db.getActionStatus(c.command_key)).toEqual(s);
    expect(db.listActions()).toHaveLength(1);
    expect(db.actionEvents).toEqual([expect.objectContaining({ command_key: c.command_key, status: 'failed', reason_code: 'SAFETY_REJECTED' })]);
    expect(changes.filter((x) => x.kind === 'action_status')).toHaveLength(1);
    expect(await db.requestAction({ ...c, requested_sim_time_ms: 1 })).toEqual(s); // idempotent
    await expectDbError(db.requestAction({ ...c, arguments: { destination_gpu_ids: rackGpus(7) } }), 'COMMAND_KEY_COLLISION');
    await expectDbError(db.claimAction(c.command_key, s.version, 'w'), 'INVALID_TRANSITION');
  });

  it('still throws and persists nothing for malformed payloads and key collisions (§0.11 #3)', async () => {
    const obs = loadPumpDegradedSnapshot();
    const db = new FakeDb({ snapshot: obs, physics: new FakePhysics() });
    await expectDbError(db.requestAction({ ...cmd(obs), operation: 'bogus' } as never), 'INVALID_PAYLOAD');
    expect(db.listActions()).toHaveLength(0);
    expect(db.actionEvents).toHaveLength(0);
  });

  it('payload hash excludes requested_sim_time_ms but not arguments (§0.11 #2)', () => {
    const obs = loadPumpDegradedSnapshot();
    expect(commandPayloadHash(cmd(obs, { requested_sim_time_ms: 1 }))).toBe(commandPayloadHash(cmd(obs, { requested_sim_time_ms: 999 })));
    expect(commandPayloadHash(cmd(obs))).not.toBe(commandPayloadHash(cmd(obs, { job_id: 'job-b' })));
  });

  it('injectSignal marks the GPU, bumps versions + decision_epoch and emits changes', async () => {
    const obs = loadPumpDegradedSnapshot();
    const db = new FakeDb({ snapshot: obs });
    const changes: DbChange[] = [];
    const off = db.onChange((c) => changes.push(c));
    db.injectSignal(loadSignalXid79Dest());
    off();
    db.injectSignal(loadSignalXid79R7());
    const snap = await db.getObservedSnapshot();
    const g = snap.gpus.find((x) => x.resource_id === 'gpu-r8-n1-0')!;
    expect([g.availability, g.last_xid_code]).toEqual(['unreachable', 79]);
    expect(snap.clock.decision_epoch).toBe(obs.clock.decision_epoch + 2);
    expect(changes.map((c) => c.kind)).toEqual(['signal', 'resource_version', 'decision_epoch']);
    db.tick(20_000); // signals are stamped 555 s / 560 s; the fixture clock is 540 s
    const ev = await db.getEvidence([], 60_000);
    expect(ev.signals.map((s) => s.resource_id).sort()).toEqual(['gpu-r7-n1-3', 'gpu-r8-n1-0']);
  });
});

describe('FakeDb workflows (TEST-ONLY)', () => {
  it('CAS: create on v0, reject stale versions, lease held by another worker, takeover after expiry', async () => {
    const db = new FakeDb({ snapshot: loadPumpDegradedSnapshot() });
    const l1 = await db.claimWorkflow('wf-1', 'worker-1', 0, 10_000);
    expect(l1.workflow.version).toBe(1);
    const wf = await db.updateWorkflow('wf-1', 1, l1.fencing_token, 'triage', { incident_ids: ['inc-1'] });
    expect([wf.version, wf.stage, wf.incident_ids]).toEqual([2, 'triage', ['inc-1']]);
    await expectDbError(db.updateWorkflow('wf-1', 1, l1.fencing_token, 'plan', {}), 'VERSION_CONFLICT');
    await expectDbError(db.claimWorkflow('wf-1', 'worker-2', 2, 10_000), 'LEASE_HELD');

    const hb = await db.heartbeatWorkflow('wf-1', 'worker-1', l1.fencing_token, 10_000);
    expect(hb.workflow.version).toBe(2); // heartbeat is not a material change

    db.advanceWallMs(10_001); // worker-1 "crashes"
    const l2 = await db.claimWorkflow('wf-1', 'worker-2', 2, 10_000);
    expect(l2.fencing_token).toBeGreaterThan(l1.fencing_token);
    await expectDbError(db.updateWorkflow('wf-1', 3, l1.fencing_token, 'plan', {}), 'STALE_FENCING_TOKEN');
    await db.updateWorkflow('wf-1', 3, l2.fencing_token, 'done', {});
    expect(await db.listOpenWorkflows()).toEqual([]);
  });

  it('validates incidents/plans and records agent events', async () => {
    const obs = loadPumpDegradedSnapshot();
    const db = new FakeDb({ snapshot: obs });
    await expectDbError(db.upsertIncident({ incident_id: 'x' } as never, []), 'INVALID_PAYLOAD');
    await db.upsertIncident(
      {
        schema_version: '1.1.0', run_id: obs.run_id, incident_id: 'inc-1', state: 'open', severity: 'high',
        title: 'pump-a degraded', hypothesis: null, confidence: 0.8, opened_sim_time_ms: 540_000,
        updated_sim_time_ms: 540_000, version: 1,
      },
      [{ schema_version: '1.1.0', run_id: obs.run_id, incident_id: 'inc-1', linked_id: 'pump-a', link_kind: 'resource', reason: 'degraded' }],
    );
    expect((await db.listIncidents()).map((i) => i.incident_id)).toEqual(['inc-1']);
    await db.publishAgentEvent({
      agent_event_id: 'ae-1', run_id: obs.run_id, workflow_id: 'wf-1', incident_id: 'inc-1', stage: 'triage',
      summary: '1 cooling incident', evidence_ids: ['sig-pump-a-alarm-1'],
      tool_calls: [{ tool: 'get_incident_evidence', args_summary: 'inc-1, 120s', result_summary: '24 GPUs hot' }],
      sim_time_ms: 540_000, observed_unix_ms: 0,
    });
    expect(db.agentEvents).toHaveLength(1);
  });
});

describe('FakePhysics (TEST-ONLY toy model)', () => {
  const physics = new FakePhysics();
  const obs = loadPumpDegradedSnapshot();
  const ctx = { decision_epoch: obs.clock.decision_epoch, leased_resource_ids: [] as string[] };

  it('scores checkpoint + move to cool r7/r8 below keep_running on lost work', () => {
    const keep = physics.simulatePlan(obs, { commands: [cmd(obs, { operation: 'keep_running' })] });
    const move = physics.simulatePlan(obs, { commands: [cmd(obs), migrateA(obs, rackGpus(7).concat(rackGpus(8)))] });
    expect(move.expected_lost_work_units).toBeLessThan(keep.expected_lost_work_units);
    expect(move.violations).toEqual([]);
    expect(move.assumptions).toContain(FAKE_PHYSICS_BANNER);
  });

  it('allows a cool destination, denies r6 (headroom), an XID GPU, a stale epoch and gpu-real-0', async () => {
    const coolDest = rackGpus(7).concat(rackGpus(8));
    const ok = physics.evaluateSafety(obs, migrateA(obs, coolDest), ctx);
    expect(ok.decision).toBe('allow');
    expect(validatePayload('SafetyDecision', ok)).toEqual({ ok: true });

    const r6 = physics.evaluateSafety(obs, migrateA(obs, rackGpus(6).concat(rackGpus(7))), ctx);
    expect(r6.decision).toBe('deny');
    expect(r6.violations).toContain('DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT');

    const db = new FakeDb({ snapshot: obs });
    db.injectSignal(loadSignalXid79Dest());
    const after = await db.getObservedSnapshot();
    const afterCtx = { decision_epoch: after.clock.decision_epoch, leased_resource_ids: [] as string[] };
    expect(physics.evaluateSafety(after, migrateA(after, coolDest), afterCtx).violations).toContain('DEST_GPU_UNHEALTHY');
    // plan built on the old epoch, checked against the new one
    expect(physics.evaluateSafety(after, migrateA(obs, rackGpus(7).concat(rackGpus(1))), afterCtx).violations).toContain(
      'STALE_DECISION_EPOCH',
    );

    const withReal = [...rackGpus(7), ...rackGpus(1).slice(1), 'gpu-real-0'];
    expect(physics.evaluateSafety(obs, migrateA(obs, withReal), ctx).violations).toContain('REAL_GPU_NOT_ALLOCATABLE');
  });

  it('accepts the frozen argument shapes and rejects others with UNSUPPORTED_OPERATION (§0.11 #1)', () => {
    const dest = rackGpus(7).concat(rackGpus(8));
    const viol = (c: ActionCommand) => physics.evaluateSafety(obs, c, ctx).violations;
    expect(viol(cmd(obs))).toEqual([]);
    expect(viol(migrateA(obs, dest))).not.toContain('UNSUPPORTED_OPERATION');
    expect(viol(cmd(obs, { operation: 'power_cap', arguments: { power_limit_w: 500 } }))).toEqual([]);
    expect(viol(cmd(obs, { operation: 'escalate', arguments: { reason: 'no safe destination' } }))).toEqual([]);
    expect(viol(cmd(obs, { operation: 'keep_running' }))).toEqual([]);
    const bad: Partial<ActionCommand>[] = [
      { operation: 'power_cap', arguments: {} },
      { operation: 'power_cap', arguments: { power_limit_w: '500' } },
      { operation: 'power_cap', arguments: { power_cap_w: 500 } },
      { operation: 'escalate', arguments: {} },
      { operation: 'escalate', arguments: { reason: 1 } },
      { operation: 'migrate_restart', arguments: { gpus: dest } },
      { operation: 'migrate_restart', arguments: { destination_gpu_ids: 'gpu-r7-n1-0' } },
      { operation: 'checkpoint', arguments: { reason: 'x' } },
    ];
    for (const b of bad) expect(viol(cmd(obs, b)), JSON.stringify(b)).toContain('UNSUPPORTED_OPERATION');
  });

  it('exports the DCGM clock-event bits (§0.11 #5)', () => {
    expect([CLOCKS_EVENT_SW_THERMAL, CLOCKS_EVENT_SW_POWER_CAP]).toEqual([0x20, 0x04]);
  });

  it('thresholdPolicy emits valid power_cap commands for hot jobs only', () => {
    const cmds = physics.thresholdPolicy(obs);
    expect(cmds.map((c) => c.job_id).sort()).toEqual(['job-a', 'job-b']);
    for (const c of cmds) expect(validatePayload('ActionCommand', c)).toEqual({ ok: true });
  });
});

describe('FakeLlm (TEST-ONLY)', () => {
  it('replays the script in order, records requests, and throws when exhausted', async () => {
    const llm = new FakeLlm([FakeLlm.toolCall('get_job_state', { job_ids: ['job-a'] }), new Error('NIM timeout'), FakeLlm.text('done')]);
    const r1 = await llm.chat({ messages: [{ role: 'user', content: 'hi' }], toolChoice: 'auto' });
    expect(r1.toolCalls[0]).toMatchObject({ name: 'get_job_state', argumentsJson: '{"job_ids":["job-a"]}' });
    await expect(llm.chat({ messages: [] })).rejects.toThrow('NIM timeout');
    expect((await llm.chat({ messages: [] })).content).toBe('done');
    await expect(llm.chat({ messages: [] })).rejects.toThrow(/exhausted/);
    expect(llm.requests).toHaveLength(4);
  });
});

describe('fakes stay out of production code', () => {
  it('no file under src/ imports test/fakes', () => {
    const srcDir = resolve(import.meta.dirname, '..', 'src');
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    for (const f of walk(srcDir).filter((p) => p.endsWith('.ts'))) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/(from|import)\s*\(?\s*['"][^'"]*fakes/);
    }
  });
});
