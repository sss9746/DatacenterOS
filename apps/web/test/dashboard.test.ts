import { afterEach, describe, expect, it } from 'vitest';
import { createMockClient } from '@dcos/db-client';
import { DashboardStore, openDashboard } from '../src/data/dashboard';
import { actionLabel, reasonText } from '../src/components/ledger/Ledger';
import { thermalState } from '../src/components/heatmap/Heatmap';
import type { ActionStatus } from '@dcos/contracts';
const stores: DashboardStore[] = [];
afterEach(() => { stores.forEach((store) => store.close()); stores.length = 0; });
describe('public dashboard projection', () => {
  it('uses the actual mock fixtures and records real observed work loss after XID 79', async () => {
    const client = createMockClient(); const store = new DashboardStore(client); stores.push(store); await store.refresh();
    expect(store.state.snapshot?.gpus.filter((row) => row.resource_id !== 'gpu-real-0')).toHaveLength(64);
    const before = store.state.snapshot!.job_states.find((job) => job.job_id === 'job-a')!;
    await client.injectFault({ schema_version: '1.1.0', run_id: 'run-demo-1', fault_id: 'test-fault', kind: 'gpu_xid_79', target_resource_id: 'gpu-r3-n1-0', start_sim_time_ms: 0, duration_sim_ms: null, severity: 1, parameters: {}, seed_offset: 0 });
    await store.refresh();
    const after = store.state.snapshot!.job_states.find((job) => job.job_id === 'job-a')!;
    expect(after.progress_work_units).toBe(before.durable_work_units); expect(store.state.losses['job-a']).toBe(before.progress_work_units - before.durable_work_units);
    expect(store.state.signals[0].xid_code).toBe(79); expect('injectedFaults' in store.state).toBe(false);
  });
  it('does not silently fall back from a failed live connection', async () => { await expect(openDashboard('live', 'demo', { uri: 'ws://localhost:3000', db: 'dcos-test' })).rejects.toThrow(/connect\(.*\) failed|not available/); });
  it('keeps scripted examples separate and does not fabricate benchmark scores', async () => { const store = await openDashboard('mock', 'recovery', { uri: '', db: '' }); stores.push(store); store.start(); await new Promise((r) => setTimeout(r, 25)); expect(store.state.incidents).toHaveLength(2); expect(store.state.events).toHaveLength(20); expect(store.state.workflows.map((row) => row.workflow_id).sort()).toEqual(['wf-example-cooling', 'wf-example-xid']); expect(store.state.results).toHaveLength(0); expect(store.state.events.every((event) => event.summary.startsWith('Example:'))).toBe(true); });
  it('retains a last snapshot and exposes fetch errors', async () => { const client = createMockClient(); const store = new DashboardStore(client); stores.push(store); await store.refresh(); client.getObservedSnapshot = async () => { throw new Error('Connection lost'); }; await store.refresh(); expect(store.state.snapshot).not.toBeNull(); expect(store.state.error).toContain('Connection lost'); expect(store.state.phase).toBe('error'); });
  it('renders safety denials as BLOCKED and preserves reason codes', () => { const status = { status: 'failed', reason_code: 'SAFETY_REJECTED' } as ActionStatus; expect(actionLabel(status)).toBe('BLOCKED'); expect(reasonText('DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT')).toContain('thermal headroom'); });
  it('treats unavailable GPUs as faults even without a persistent XID code', async () => { const client = createMockClient(); const store = new DashboardStore(client); stores.push(store); await store.refresh(); expect(thermalState({ ...store.state.snapshot!.gpus[0], availability: 'unreachable', last_xid_code: null })).toBe('fault'); });
});
