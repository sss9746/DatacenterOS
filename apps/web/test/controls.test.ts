import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMockClient } from '@dcos/db-client';
import { DashboardStore } from '../src/data/dashboard';
import { PresenterControls } from '../src/components/controls/Controls';
import { validatePayload, type ActionStatus } from '@dcos/contracts';
import type { ActionDetail } from '@dcos/db-client';
import { STEP_MS } from '@dcos/physics';
import { createLocalPhysicsClient } from '../src/data/local-physics';
import { buildFaultInjection, effectivePumpCapacity, FaultFormError, scheduleState } from '../src/components/controls/fault-form';
import { buildR6Probe, probeConflict, probeIds, probeVerdict, thermalEvidence, violationsOf } from '../src/components/controls/safety-probe';

const base = { runId: 'run-demo-1', simTimeMs: 600_000, faultId: 'judge-test' };

describe('buildFaultInjection', () => {
  it('encodes pump capacity loss as severity and starts on the next tick for delay 0', () => {
    const fault = buildFaultInjection({ ...base, kind: 'cooling_pump_degradation', targetId: 'pump-a', capacityLoss: 0.6, delayS: 0 });
    expect(fault).toMatchObject({ kind: 'cooling_pump_degradation', target_resource_id: 'pump-a', severity: 0.6, start_sim_time_ms: 600_000 + STEP_MS, duration_sim_ms: null, parameters: { capacity_factor: 0.4 } });
    expect(validatePayload('FaultInjection', fault).ok).toBe(true);
  });

  it('uses the selected positive delay and a fixed severity of 1 for Xid 79', () => {
    const fault = buildFaultInjection({ ...base, kind: 'gpu_xid_79', targetId: 'gpu-r3-n1-0', delayS: 30 });
    expect(fault).toMatchObject({ kind: 'gpu_xid_79', severity: 1, start_sim_time_ms: 630_000, duration_sim_ms: null, parameters: {} });
    expect(validatePayload('FaultInjection', fault).ok).toBe(true);
  });

  it('rejects the real GPU, unknown pumps and off-preset values', () => {
    expect(() => buildFaultInjection({ ...base, kind: 'gpu_xid_79', targetId: 'gpu-real-0', delayS: 0 })).toThrow(FaultFormError);
    expect(() => buildFaultInjection({ ...base, kind: 'cooling_pump_degradation', targetId: 'pump-c', capacityLoss: 0.6, delayS: 0 })).toThrow(FaultFormError);
    expect(() => buildFaultInjection({ ...base, kind: 'cooling_pump_degradation', targetId: 'pump-a', capacityLoss: 0.5 as 0.6, delayS: 0 })).toThrow(FaultFormError);
    expect(() => buildFaultInjection({ ...base, kind: 'gpu_xid_79', targetId: 'gpu-r3-n1-0', delayS: 5 as 10 })).toThrow(FaultFormError);
    expect(() => buildFaultInjection({ ...base, kind: 'gpu_xid_48' as 'gpu_xid_79', targetId: 'gpu-r3-n1-0', delayS: 0 })).toThrow(FaultFormError);
  });

  it('multiplies combined pump losses and reports pending until the start time', () => {
    expect(effectivePumpCapacity({ nominal_capacity_w: 1000, observed_capacity_estimate_w: 400 }, 0.6)?.after).toBeCloseTo(0.16);
    expect(effectivePumpCapacity({ nominal_capacity_w: 1000, observed_capacity_estimate_w: null }, 0.6)).toBeNull();
    expect(scheduleState({ start_sim_time_ms: 610_000 }, 600_000, true)).toBe('pending');
    expect(scheduleState({ start_sim_time_ms: 610_000 }, 610_000, true)).toBe('start_reached');
    expect(scheduleState({ start_sim_time_ms: 610_000 }, 600_000, false)).toBe('fixture');
  });

  it('applies a delay-0 pump fault in local physics on the next step and combines losses multiplicatively', async () => {
    const client = createLocalPhysicsClient();
    try {
      for (const id of ['a', 'b']) {
        const snapshot = await client.getObservedSnapshot();
        await client.injectFault(buildFaultInjection({ runId: snapshot.run_id, simTimeMs: snapshot.clock.sim_time_ms, faultId: `judge-${id}`, kind: 'cooling_pump_degradation', targetId: 'pump-a', capacityLoss: 0.6, delayS: 0 }));
        client.tick();
      }
      const after = await client.getObservedSnapshot();
      const pump = after.cooling.find((row) => row.resource_id === 'pump-a')!;
      expect(pump.operating_state).toBe('degraded');
      expect(pump.observed_capacity_estimate_w! / pump.nominal_capacity_w).toBeCloseTo(0.16, 1);
    } finally { client.close(); }
  });
});

describe('presenter r6 safety probe', () => {
  it('builds a migrate_restart of job-b onto r6 from a fresh snapshot', async () => {
    const client = createLocalPhysicsClient();
    try {
      const snapshot = await client.getObservedSnapshot();
      const build = buildR6Probe(snapshot, probeIds('u1'));
      if (!build.ok) throw new Error(build.reason);
      const { command } = build;
      expect(validatePayload('ActionCommand', command).ok).toBe(true);
      expect(command).toMatchObject({ operation: 'migrate_restart', job_id: 'job-b', target_resource_id: 'job-b', command_key: 'probe-r6-u1', action_id: 'probe-r6-u1', workflow_id: 'presenter-probe-u1', expected_decision_epoch: snapshot.clock.decision_epoch, requested_sim_time_ms: snapshot.clock.sim_time_ms });
      expect(command.arguments.destination_gpu_ids).toEqual(Array.from({ length: 8 }, (_, k) => `gpu-r6-n1-${k}`));
      expect(command.expected_resource_versions['job-b']).toBe(snapshot.job_states.find((j) => j.job_id === 'job-b')!.version);
      expect(command.expected_resource_versions['gpu-r6-n1-0']).toBe(snapshot.gpus.find((g) => g.resource_id === 'gpu-r6-n1-0')!.version);
    } finally { client.close(); }
  });

  it('gets a real BLOCKED from local physics safety with busy and thermal evidence recorded', async () => {
    const client = createLocalPhysicsClient();
    try {
      client.advance(5);
      const snapshot = await client.getObservedSnapshot();
      const build = buildR6Probe(snapshot, probeIds('u2'));
      if (!build.ok) throw new Error(build.reason);
      expect(probeConflict(snapshot, [], [])).toBeNull();
      const status = await client.requestAction(build.command);
      expect(probeVerdict(status)).toBe('blocked');
      let details: ActionDetail[] = [];
      client.onActionDetails((rows) => { details = rows; })();
      const detail = details.find((row) => row.command.command_key === 'probe-r6-u2')!;
      expect(detail.safety?.decision).toBe('deny');
      const violations = violationsOf(status, detail.safety);
      expect(violations).toEqual(expect.arrayContaining(['DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT', 'DEST_GPU_BUSY']));
      expect(violations).not.toContain('STALE_DECISION_EPOCH');
      expect(violations).not.toContain('STALE_RESOURCE_VERSION');
      const thermal = thermalEvidence(detail.safety);
      expect(thermal).toHaveLength(1);
      expect(thermal[0]).toMatchObject({ rackId: 'rack-r6', requiredC: 5 });
      // Evidence is what evaluateSafety recorded: r6's projected headroom is under the required 5 °C margin.
      expect(thermal[0]!.availableC).toBeLessThan(thermal[0]!.requiredC!);
    } finally { client.close(); }
  });

  it('stays thermally denied after pump-b loses capacity under r6', async () => {
    const client = createLocalPhysicsClient();
    try {
      const start = await client.getObservedSnapshot();
      await client.injectFault(buildFaultInjection({ runId: start.run_id, simTimeMs: start.clock.sim_time_ms, faultId: 'judge-b', kind: 'cooling_pump_degradation', targetId: 'pump-b', capacityLoss: 0.8, delayS: 0 }));
      client.advance(120);
      const snapshot = await client.getObservedSnapshot();
      const build = buildR6Probe(snapshot, probeIds('u3'));
      if (!build.ok) throw new Error(build.reason);
      const status = await client.requestAction(build.command);
      expect(probeVerdict(status)).toBe('blocked');
      expect(violationsOf(status, null)).toEqual(expect.arrayContaining(['DEST_GPU_BUSY', 'DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT']));
    } finally { client.close(); }
  });

  it('refuses to probe while an overlapping action is in flight', async () => {
    const client = createLocalPhysicsClient();
    try {
      const snapshot = await client.getObservedSnapshot();
      const running = { schema_version: '1.1.0', run_id: snapshot.run_id, action_id: 'a1', command_key: 'wf:checkpoint:job-b:1', status: 'running', attempt: 1, updated_sim_time_ms: 0, result: {}, reason_code: null, version: 3 } as ActionStatus;
      const detail = { status: running, command: { ...(buildR6Probe(snapshot, probeIds('x')) as { command: ActionDetail['command'] }).command, operation: 'checkpoint', command_key: 'wf:checkpoint:job-b:1', arguments: {} }, claimed_by: 'w', due_sim_time_ms: null, safety: null, start_safety: null, history: [] } as ActionDetail;
      expect(probeConflict(snapshot, [running], [detail])).toMatch(/checkpoint .* touches job-b/);
      expect(probeConflict(snapshot, [running], [])).toMatch(/targets have not loaded/);
      expect(probeConflict(snapshot, [{ ...running, status: 'succeeded' }], [])).toBeNull();
    } finally { client.close(); }
  });
});

describe('presenter controls markup', () => {
  const render = async (store: DashboardStore, canAdmin: boolean) => {
    await store.refresh();
    return renderToStaticMarkup(createElement(PresenterControls, { store, canAdmin, selectedGpuId: 'gpu-r3-n1-0', selectedPumpId: 'pump-a', onSelectGpu: () => {}, onSelectPump: () => {}, onReset: () => {} }));
  };

  it('offers exactly the two fault controls and the r6 probe in the local preview', async () => {
    const store = new DashboardStore(createLocalPhysicsClient());
    try {
      const html = await render(store, true);
      expect(html).toContain('Degrade pump'); expect(html).toContain('GPU inaccessible (Xid 79)');
      expect(html).toContain('Local preview'); expect(html).toContain('Advance 30 sim-s'); expect(html).toContain('Manual safety probe');
      expect(html).not.toMatch(/Xid 48|XID 48|network_link|node_crash|sensor_stale|Stop a pump/);
      expect(html).not.toContain('gpu-real-0');
      expect(html).toMatch(/<option value="0.6" selected="">60%<\/option>/);
    } finally { store.close(); }
  });

  it('hides the probe and disables faults when read-only, and labels the fixture mock', async () => {
    const readOnly = new DashboardStore(createMockClient());
    const fixture = new DashboardStore(createMockClient());
    try {
      const html = await render(readOnly, false);
      expect(html).toContain('Read-only'); expect(html).not.toContain('Manual safety probe'); expect(html).toContain('<fieldset class="presenter-fieldset" disabled="">');
      const preview = await render(fixture, true);
      expect(preview).toContain('Mock fixture preview'); expect(preview).not.toContain('Advance 30 sim-s');
    } finally { readOnly.close(); fixture.close(); }
  });
});
