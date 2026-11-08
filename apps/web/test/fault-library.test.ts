import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { contractsSchema, validatePayload, type FaultInjection, type ObservedSnapshot } from '@dcos/contracts';
import { createMockClient } from '@dcos/db-client';
import { STEP_MS } from '@dcos/physics';
import { DashboardStore } from '../src/data/dashboard';
import { createLocalPhysicsClient, type LocalPhysicsClient } from '../src/data/local-physics';
import { FaultLibrary } from '../src/components/controls/FaultLibrary';
import {
  buildFaultInjection, catalogEntry, describeFault, ENGINE_KINDS, FAULT_CATALOG, FaultFormError, nodeOfGpu, scheduleState, targetOptions, targetProblem,
  type FaultCatalogId, type TargetType,
} from '../src/components/controls/fault-form';
import { gpuFaultText, staleReadingMs } from '../src/components/simulation/situation';
import { checkpointStorageDown } from '../src/components/jobs/job-view';

/** The wire enum of FaultInjection.kind, straight from the contracts schema: what the engine can be asked for. */
const WIRE_KINDS = ((contractsSchema.$defs.FaultInjection as { properties: { kind: { enum: string[] } } }).properties.kind.enum).sort();
const SAMPLE_TARGET: Record<TargetType, string> = { pump: 'pump-a', gpu: 'gpu-r3-n1-0', node: 'node-r3-n1', checkpoint_store: 'ckpt-store-1', network_link: 'link-r3' };

const gpuRow = (snapshot: ObservedSnapshot, id: string) => snapshot.gpus.find((row) => row.resource_id === id)!;
const jobOn = (snapshot: ObservedSnapshot, gpuId: string) => snapshot.allocations.find((row) => row.gpu_id === gpuId)!.job_id;
const jobRow = (snapshot: ObservedSnapshot, jobId: string) => snapshot.job_states.find((row) => row.job_id === jobId)!;

async function injectNow(client: LocalPhysicsClient, fault: FaultCatalogId, targetId: string, extra: { severity?: number; durationS?: 30 | 60 | 120 | null } = {}) {
  const fresh = await client.getObservedSnapshot();
  const payload = buildFaultInjection({ fault, runId: fresh.run_id, simTimeMs: fresh.clock.sim_time_ms, faultId: `judge-${fault}-${targetId}`, targetId, delayS: 0, snapshot: fresh, ...extra });
  await client.injectFault(payload);
  return payload;
}

describe('fault catalog ↔ physics engine coverage', () => {
  it('names every wire kind at least once, and no kind the engine does not have', () => {
    expect([...new Set(FAULT_CATALOG.map((entry) => entry.kind))].sort()).toEqual(WIRE_KINDS);
    expect(Object.keys(ENGINE_KINDS).sort()).toEqual(WIRE_KINDS);
    for (const [kind, ids] of Object.entries(ENGINE_KINDS)) {
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(catalogEntry(id).kind).toBe(kind);
    }
    const listed = new Set(Object.values(ENGINE_KINDS).flat());
    for (const entry of FAULT_CATALOG) expect(listed.has(entry.id)).toBe(true);
    expect(new Set(FAULT_CATALOG.map((entry) => entry.id)).size).toBe(FAULT_CATALOG.length);
  });

  it('labels the storage encodings honestly and marks the link alarm as alarm-only', () => {
    expect(catalogEntry('storage_link_down')).toMatchObject({ kind: 'network_link_down', target: 'checkpoint_store', name: 'Checkpoint storage unavailable' });
    expect(catalogEntry('storage_link_down').note).toMatch(/not switch emulation/);
    expect(catalogEntry('storage_node_crash')).toMatchObject({ kind: 'node_crash', target: 'checkpoint_store' });
    expect(catalogEntry('link_down_alarm').note).toMatch(/Alarm only, no workload effect/);
    for (const id of ['gpu_xid_79', 'gpu_xid_48', 'gpu_xid_74'] as const) { expect(catalogEntry(id).expires).toBe(false); expect(catalogEntry(id).note).toMatch(/Expiry never repairs/); }
    expect(catalogEntry('sensor_stale_gpu').target).toBe('gpu');
  });
});

describe('buildFaultInjection over the whole catalog', () => {
  it('builds a valid payload for every entry that the local physics client accepts', async () => {
    const client = createLocalPhysicsClient();
    try {
      const snapshot = await client.getObservedSnapshot();
      for (const entry of FAULT_CATALOG) {
        const persistent = buildFaultInjection({ fault: entry.id, runId: snapshot.run_id, simTimeMs: snapshot.clock.sim_time_ms, faultId: `p-${entry.id}`, targetId: SAMPLE_TARGET[entry.target], delayS: 10, snapshot });
        expect(validatePayload('FaultInjection', persistent), entry.id).toEqual({ ok: true });
        expect(persistent).toMatchObject({ kind: entry.kind, target_resource_id: SAMPLE_TARGET[entry.target], start_sim_time_ms: snapshot.clock.sim_time_ms + 10_000, duration_sim_ms: null });
        expect(persistent.severity).toBe(entry.severity ? entry.severity.default : 1);
        await client.injectFault(persistent);
        if (entry.expires) {
          const finite = buildFaultInjection({ fault: entry.id, runId: snapshot.run_id, simTimeMs: snapshot.clock.sim_time_ms, faultId: `f-${entry.id}`, targetId: SAMPLE_TARGET[entry.target], delayS: 0, durationS: 60, snapshot });
          expect(validatePayload('FaultInjection', finite), entry.id).toEqual({ ok: true });
          expect(finite).toMatchObject({ start_sim_time_ms: snapshot.clock.sim_time_ms + STEP_MS, duration_sim_ms: 60_000 });
          await client.injectFault(finite);
        }
      }
    } finally { client.close(); }
  });

  it('encodes the presets physics reads (severity) plus the descriptive parameters', () => {
    const base = { runId: 'run-demo-1', simTimeMs: 600_000, faultId: 'judge-test', delayS: 0 as const };
    expect(buildFaultInjection({ ...base, fault: 'pump_degradation', targetId: 'pump-b', severity: 0.8 })).toMatchObject({ kind: 'cooling_pump_degradation', severity: 0.8, parameters: { capacity_factor: 0.2 } });
    expect(buildFaultInjection({ ...base, fault: 'gpu_thermal_load', targetId: 'gpu-r5-n1-1', severity: 0.25, durationS: 30 })).toMatchObject({ kind: 'gpu_thermal_load', severity: 0.25, parameters: { extra_temp_c: 5 }, duration_sim_ms: 30_000 });
    expect(buildFaultInjection({ ...base, fault: 'pump_outage', targetId: 'pump-a' })).toMatchObject({ kind: 'cooling_pump_outage', severity: 1, parameters: {} });
    expect(buildFaultInjection({ ...base, fault: 'node_crash', targetId: 'node-r3-n1', durationS: 120 })).toMatchObject({ kind: 'node_crash', duration_sim_ms: 120_000 });
  });

  it('rejects unsupported target/kind combinations, durations on latching Xids and off-preset values', async () => {
    const client = createLocalPhysicsClient();
    try {
      const snapshot = await client.getObservedSnapshot();
      const base = { runId: snapshot.run_id, simTimeMs: snapshot.clock.sim_time_ms, faultId: 'judge-test', delayS: 0 as const, snapshot };
      const bad = (input: Parameters<typeof buildFaultInjection>[0]) => expect(() => buildFaultInjection(input)).toThrow(FaultFormError);
      bad({ ...base, fault: 'gpu_xid_79', targetId: 'gpu-real-0' });
      bad({ ...base, fault: 'node_crash', targetId: 'node-real-0' });
      bad({ ...base, fault: 'node_crash', targetId: 'gpu-r3-n1-0' });
      bad({ ...base, fault: 'sensor_stale_gpu', targetId: 'pump-a' });
      bad({ ...base, fault: 'sensor_stale_gpu', targetId: 'rack-r3' });
      bad({ ...base, fault: 'link_down_alarm', targetId: 'ckpt-store-1' });
      bad({ ...base, fault: 'storage_link_down', targetId: 'link-r3' });
      bad({ ...base, fault: 'pump_degradation', targetId: 'pump-c' });
      bad({ ...base, fault: 'pump_degradation', targetId: 'pump-a', severity: 0.5 });
      bad({ ...base, fault: 'gpu_thermal_load', targetId: 'gpu-r3-n1-0', severity: 2 });
      bad({ ...base, fault: 'gpu_xid_79', targetId: 'gpu-r3-n1-0', durationS: 30 });
      bad({ ...base, fault: 'gpu_xid_48', targetId: 'gpu-r3-n1-0', durationS: 60 });
      bad({ ...base, fault: 'gpu_xid_74', targetId: 'gpu-r3-n1-0', delayS: 5 as 10 });
      bad({ ...base, fault: 'node_crash', targetId: 'node-r3-n1', durationS: 45 as 30 });
      expect(targetProblem(catalogEntry('gpu_xid_79'), 'gpu-r3-n1-0', snapshot)).toBeNull();
      expect(targetProblem(catalogEntry('gpu_xid_79'), 'node-r3-n1', snapshot)).toMatch(/needs a simulated GPU/);
      expect(targetProblem(catalogEntry('gpu_xid_79'), 'gpu-r9-n1-0', snapshot)).toMatch(/not in this run/);
      expect(targetProblem(catalogEntry('gpu_xid_79'), '', snapshot)).toMatch(/Choose/);
      // without a snapshot the id family is still checked
      expect(targetProblem(catalogEntry('storage_link_down'), 'ckpt-store-1')).toBeNull();
      expect(targetProblem(catalogEntry('storage_link_down'), 'link-r3')).toMatch(/not a checkpoint store/);
    } finally { client.close(); }
  });

  it('derives target pickers from the snapshot and never offers the real GPU or node', async () => {
    const client = createLocalPhysicsClient();
    try {
      const snapshot = await client.getObservedSnapshot();
      expect(targetOptions('pump', snapshot).map((o) => o.id)).toEqual(['pump-a', 'pump-b']);
      const gpus = targetOptions('gpu', snapshot).map((o) => o.id);
      expect(gpus).toHaveLength(64); expect(gpus).not.toContain('gpu-real-0');
      const nodes = targetOptions('node', snapshot);
      expect(nodes.map((o) => o.id)).toHaveLength(8); expect(nodes.map((o) => o.id)).not.toContain('node-real-0');
      expect(nodes[2]).toMatchObject({ id: 'node-r3-n1', label: 'node-r3-n1 (rack-r3)' });
      expect(targetOptions('checkpoint_store', snapshot).map((o) => o.id)).toEqual(['ckpt-store-1']);
      expect(targetOptions('network_link', snapshot).map((o) => o.id)).toEqual(Array.from({ length: 8 }, (_, i) => `link-r${i + 1}`));
      expect(nodeOfGpu('gpu-r5-n1-3', snapshot)).toBe('node-r5-n1');
      await injectNow(client, 'gpu_xid_79', 'gpu-r7-n1-0'); client.tick();
      expect(targetOptions('gpu', await client.getObservedSnapshot()).find((o) => o.id === 'gpu-r7-n1-0')?.disabledReason).toMatch(/already failed \(Xid 79\)/);
    } finally { client.close(); }
  });

  it('tracks pending, active and ended schedules and describes faults by catalog name', () => {
    const fault = { start_sim_time_ms: 610_000, duration_sim_ms: 30_000 };
    expect(scheduleState(fault, 600_000, true)).toBe('pending');
    expect(scheduleState(fault, 610_000, true)).toBe('start_reached');
    expect(scheduleState(fault, 640_000, true)).toBe('ended');
    expect(scheduleState({ start_sim_time_ms: 610_000, duration_sim_ms: null }, 9_999_999, true)).toBe('start_reached');
    expect(scheduleState(fault, 600_000, false)).toBe('fixture');
    const built = buildFaultInjection({ fault: 'storage_link_down', runId: 'run-demo-1', simTimeMs: 600_000, faultId: 'x', targetId: 'ckpt-store-1', delayS: 0 });
    expect(describeFault(built)).toBe('Checkpoint storage unavailable · ckpt-store-1');
    expect(describeFault({ ...built, kind: 'network_link_down', target_resource_id: 'link-r2' } as FaultInjection)).toBe('Rack link-down alarm · link-r2');
    expect(describeFault(buildFaultInjection({ fault: 'pump_degradation', runId: 'r', simTimeMs: 0, faultId: 'y', targetId: 'pump-a', delayS: 0, severity: 0.3 }))).toBe('Degrade pump · pump-a · 30%');
  });
});

describe('local physics effects, one per catalog group', () => {
  it('cooling: a pump outage zeroes the pump, and a finite one restores it', async () => {
    const client = createLocalPhysicsClient();
    try {
      await injectNow(client, 'pump_outage', 'pump-b', { durationS: 30 });
      client.tick();
      const during = (await client.getObservedSnapshot()).cooling.find((row) => row.resource_id === 'pump-b')!;
      expect(during.operating_state).toBe('failed'); expect(during.observed_capacity_estimate_w).toBe(0);
      client.advance(31);
      const after = (await client.getObservedSnapshot()).cooling.find((row) => row.resource_id === 'pump-b')!;
      expect(after.operating_state).toBe('normal'); expect(after.observed_capacity_estimate_w).toBe(after.nominal_capacity_w);
    } finally { client.close(); }
  });

  it('GPU errors: thermal load heats and throttles one GPU; Xid 48 degrades and fails the job; Xid 74 only degrades', async () => {
    const client = createLocalPhysicsClient();
    try {
      const before = await client.getObservedSnapshot();
      const hot = 'gpu-r3-n1-0', ecc = 'gpu-r4-n1-0', nvlink = 'gpu-r6-n1-0'; // job-a (racks 2+3), job-b (rack 4), job-c (rack 6)
      const eccJob = jobOn(before, ecc); const nvlinkJob = jobOn(before, nvlink);
      await injectNow(client, 'gpu_thermal_load', hot, { severity: 1 });
      await injectNow(client, 'gpu_xid_48', ecc);
      await injectNow(client, 'gpu_xid_74', nvlink);
      client.tick();
      const after = await client.getObservedSnapshot();
      expect(gpuRow(after, hot).temp_c).toBeGreaterThan(gpuRow(before, hot).temp_c + 15);
      expect(gpuRow(after, hot).clocks_event_reasons & 0x20).toBe(0x20);
      expect(gpuRow(after, hot).availability).toBe('ready');
      expect(gpuRow(after, ecc)).toMatchObject({ availability: 'degraded', last_xid_code: 48 });
      expect(jobRow(after, eccJob).status).toBe('failed');
      expect(gpuRow(after, nvlink)).toMatchObject({ availability: 'degraded', last_xid_code: 74 });
      expect(jobRow(after, nvlinkJob).status).toBe('running');
      expect(gpuFaultText(gpuRow(after, ecc))).toBe('Degraded · Xid 48');
      expect(gpuFaultText(gpuRow(after, nvlink))).toBe('Degraded · Xid 74');
    } finally { client.close(); }
  });

  it('node: a crash takes all 8 GPUs and the node unreachable and fails the job; expiry reboots the GPUs, not the job', async () => {
    const client = createLocalPhysicsClient();
    try {
      const before = await client.getObservedSnapshot();
      const job = jobOn(before, 'gpu-r3-n1-0');
      await injectNow(client, 'node_crash', 'node-r3-n1', { durationS: 30 });
      client.tick();
      const during = await client.getObservedSnapshot();
      const rack3 = during.gpus.filter((row) => row.node_id === 'node-r3-n1');
      expect(rack3).toHaveLength(8); expect(rack3.every((row) => row.availability === 'unreachable')).toBe(true);
      expect(during.nodes.find((row) => row.resource_id === 'node-r3-n1')?.availability).toBe('unreachable');
      expect(jobRow(during, job).status).toBe('failed');
      client.advance(31);
      const after = await client.getObservedSnapshot();
      expect(after.gpus.filter((row) => row.node_id === 'node-r3-n1').every((row) => row.availability === 'ready')).toBe(true);
      expect(after.nodes.find((row) => row.resource_id === 'node-r3-n1')?.availability).toBe('ready');
      expect(jobRow(after, job).status).toBe('failed');
    } finally { client.close(); }
  });

  it('storage: both encodings make every checkpoint inaccessible (jobs keep training), raise the storage alarm, and clear on expiry', async () => {
    for (const encoding of ['storage_link_down', 'storage_node_crash'] as const) {
      const client = createLocalPhysicsClient();
      const store = new DashboardStore(client);
      try {
        const before = await client.getObservedSnapshot();
        expect(before.checkpoints.length).toBeGreaterThan(0);
        expect(before.checkpoints.every((row) => row.accessible)).toBe(true);
        await injectNow(client, encoding, 'ckpt-store-1', { durationS: 30 });
        client.tick();
        await store.refresh();
        const during = await client.getObservedSnapshot();
        expect(during.checkpoints.every((row) => !row.accessible)).toBe(true);
        expect(during.job_states.filter((row) => row.status === 'running').length).toBe(before.job_states.filter((row) => row.status === 'running').length);
        for (const job of during.job_states) if (job.latest_checkpoint_id) expect(checkpointStorageDown(during, job.job_id)).toBe(true);
        expect(store.state.signals.some((s) => s.resource_id === 'ckpt-store-1' && s.event_type === 'equipment_alarm' && /checkpoints on it cannot be read or written/.test(s.message))).toBe(true);
        client.advance(31);
        const after = await client.getObservedSnapshot();
        expect(after.checkpoints.filter((row) => row.status !== 'failed').every((row) => row.accessible)).toBe(true);
      } finally { store.close(); }
    }
  });

  it('telemetry: stale readings freeze last_seen while peers advance; a rack link alarm changes no GPU', async () => {
    const client = createLocalPhysicsClient();
    const store = new DashboardStore(client);
    try {
      const target = 'gpu-r4-n1-2';
      await injectNow(client, 'sensor_stale_gpu', target, { durationS: 30 });
      await injectNow(client, 'link_down_alarm', 'link-r4');
      client.tick();
      const frozen = gpuRow(await client.getObservedSnapshot(), target);
      client.advance(10);
      await store.refresh();
      const during = await client.getObservedSnapshot();
      expect(gpuRow(during, target).last_seen_sim_ms).toBe(frozen.last_seen_sim_ms);
      expect(gpuRow(during, target).temp_c).toBe(frozen.temp_c);
      expect(gpuRow(during, 'gpu-r4-n1-3').last_seen_sim_ms).toBe(during.clock.sim_time_ms);
      expect(staleReadingMs(gpuRow(during, target), during.gpus)).toBe(11_000); // frozen on the tick before the fault applied, then 1 + 10 ticks
      expect(staleReadingMs(gpuRow(during, 'gpu-r4-n1-3'), during.gpus)).toBe(0);
      expect(gpuRow(during, target).availability).toBe('ready');
      expect(during.gpus.filter((row) => row.node_id === 'node-r4-n1').every((row) => row.availability === 'ready' && row.last_xid_code === null)).toBe(true);
      expect(store.state.signals.some((s) => s.resource_id === 'link-r4' && s.event_type === 'equipment_alarm' && /link down/.test(s.message))).toBe(true);
      client.advance(25);
      const after = await client.getObservedSnapshot();
      expect(gpuRow(after, target).last_seen_sim_ms).toBe(after.clock.sim_time_ms);
      expect(staleReadingMs(gpuRow(after, target), after.gpus)).toBe(0);
    } finally { store.close(); }
  });

  it('never calls an unreachable GPU stale, and ignores snapshots whose producer does not update last_seen', () => {
    const rows = [
      { resource_id: 'gpu-r1-n1-0', availability: 'ready', last_seen_sim_ms: 1000 },
      { resource_id: 'gpu-r1-n1-1', availability: 'unreachable', last_seen_sim_ms: 0 },
      { resource_id: 'gpu-real-0', availability: 'ready', last_seen_sim_ms: 99_000 },
    ] as const;
    expect(staleReadingMs(rows[1], rows)).toBe(0);
    expect(staleReadingMs(rows[0], rows)).toBe(0);
  });
});

describe('fault library markup', () => {
  const render = async (store: DashboardStore, canAdmin: boolean) => {
    await store.refresh();
    return renderToStaticMarkup(createElement(FaultLibrary, { store, canAdmin, selectedGpuId: 'gpu-r3-n1-0', selectedPumpId: 'pump-a', onSelectGpu: () => {}, onSelectPump: () => {} }));
  };

  it('lists every catalog entry under its group with the shared target pickers in the local preview', async () => {
    const store = new DashboardStore(createLocalPhysicsClient());
    try {
      const html = await render(store, true);
      for (const group of ['Cooling', 'GPU errors', 'Node', 'Storage', 'Telemetry']) expect(html).toContain(`</svg>${group}</h3>`);
      for (const entry of FAULT_CATALOG) { expect(html).toContain(`data-fault="${entry.id}"`); expect(html).toContain(entry.name); }
      expect(html).toContain('>Fail gpu-r3-n1-0 (Xid 79)<'); expect(html).toContain('>Degrade pump-a by 60%<'); expect(html).toContain('>Crash node-r3-n1<');
      expect(html).toContain('>Make ckpt-store-1 unreachable<'); expect(html).toContain('>Freeze readings of gpu-r3-n1-0<'); expect(html).toContain('>Alarm on link-r1<');
      expect(html).toContain('Alarm only, no workload effect'); expect(html).toContain('not switch emulation');
      expect(html).not.toContain('gpu-real-0'); expect(html).not.toContain('node-real-0');
      expect(html).toMatch(/<option value="gpu-r3-n1-0" selected="">/); expect(html).toMatch(/<option value="node-r3-n1" selected="">/);
      expect((html.match(/class="fault-row-problem"/g) ?? []).length).toBe(0);
      // latching Xids get no duration choice
      expect((html.match(/title="Persistent: expiry would not repair hardware"/g) ?? []).length).toBe(3);
    } finally { store.close(); }
  });

  it('disables every row with the read-only reason, and disables unmodelled rows in the fixture mock', async () => {
    const readOnly = new DashboardStore(createMockClient());
    const fixture = new DashboardStore(createMockClient());
    try {
      const html = await render(readOnly, false);
      expect((html.match(/Unavailable: Read-only without the presenter token/g) ?? []).length).toBe(FAULT_CATALOG.length);
      expect(html).not.toContain('Submitted this session');
      const preview = await render(fixture, true);
      expect((preview.match(/No canned fixture effect/g) ?? []).length).toBe(FAULT_CATALOG.filter((entry) => !entry.fixtureEffect).length);
      expect(preview).toContain('>Fail gpu-r3-n1-0 (Xid 79)<');
    } finally { readOnly.close(); fixture.close(); }
  });
});
