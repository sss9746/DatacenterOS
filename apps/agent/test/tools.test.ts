import { beforeEach, describe, expect, it } from 'vitest';
import { validatePayload, type Incident, type TelemetryEvent } from '@dcos/contracts';
import { FakeDb, FakePhysics } from './fakes/index.js';
import { loadPumpDegradedSnapshot, loadSignalXid79R7 } from './fixtures/index.js';
import {
  CommandBuildError,
  TOOL_NAMES,
  buildCommand,
  createToolRegistry,
  type PlacementCandidate,
  type ToolRegistry,
  type ToolResult,
} from '../src/tools/index.js';

const RUN = 'run-demo-1';
const WF = 'wf-test';

let db: FakeDb;
let physics: FakePhysics;
let reg: ToolRegistry;

const call = (name: string, args: unknown): Promise<ToolResult> => reg.invoke(name, JSON.stringify(args));
const okData = async <T = any>(name: string, args: unknown): Promise<T> => {
  const r = await call(name, args);
  if (!r.ok) throw new Error(`${name} failed: ${r.error}`);
  expect(r.summary.length).toBeLessThanOrEqual(160);
  return r.data as T;
};

beforeEach(() => {
  physics = new FakePhysics();
  db = new FakeDb({ snapshot: loadPumpDegradedSnapshot(), physics });
  reg = createToolRegistry({ db, physics, workflowId: WF, runId: RUN });
});

const incident: Incident = {
  schema_version: '1.1.0',
  run_id: RUN,
  incident_id: 'inc-1',
  state: 'open',
  severity: 'high',
  title: 'loop-a cooling degraded',
  hypothesis: null,
  confidence: 0.5,
  opened_sim_time_ms: 500_000,
  updated_sim_time_ms: 540_000,
  version: 1,
};

describe('definitions', () => {
  it('exposes the 7 read-only tools with descriptions and valid JSON Schemas', () => {
    expect(reg.definitions.map((d) => d.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(reg.definitions).toHaveLength(7);
    for (const d of reg.definitions) {
      expect(d.description.length).toBeGreaterThan(20);
      expect(d.parameters.type).toBe('object');
      expect(d.parameters.properties).toBeTypeOf('object');
      expect(d.parameters).not.toHaveProperty('$schema');
      expect(() => JSON.stringify(d.parameters)).not.toThrow();
    }
  });

  it('never exposes an execution tool', () => {
    for (const n of TOOL_NAMES) expect(n).not.toMatch(/request_action|claim|start_action|execute/);
  });
});

describe('registry error handling', () => {
  it('returns ok:false for an unknown tool', async () => {
    const r = await reg.invoke('request_action', '{}');
    expect(r.ok).toBe(false);
  });

  it('returns ok:false for malformed JSON and bad args without throwing', async () => {
    expect((await reg.invoke('get_job_state', '{nope')).ok).toBe(false);
    expect((await call('get_job_state', { job_ids: [] })).ok).toBe(false);
    expect((await call('get_resource_dependencies', { resource_ids: ['gpu-r2-n1-0'], depth: 9 })).ok).toBe(false);
    expect((await call('get_incident_evidence', { incident_ids: [], window_sim_ms: 999_999_999 })).ok).toBe(false);
    expect((await call('simulate_plan', { commands: [{ operation: 'format_disk', target_resource_id: 'x' }] })).ok).toBe(false);
  });

  it('turns a thrown dependency error into ok:false', async () => {
    const broken = createToolRegistry({
      db: { ...db, getObservedSnapshot: () => Promise.reject(new Error('db down')) } as never,
      physics,
      runId: RUN,
    });
    const r = await broken.invoke('get_job_state', '{"job_ids":["job-a"]}');
    expect(r.ok).toBe(false);
  });
});

describe('get_incident_evidence', () => {
  it('returns bounded evidence with IDs', async () => {
    db.incidents.set('inc-1', incident);
    db.links.push({ schema_version: '1.1.0', run_id: RUN, incident_id: 'inc-1', linked_id: 'gpu-r7-n1-3', link_kind: 'resource', reason: 'xid' });
    db.signals.push({ ...loadSignalXid79R7(), sim_time_ms: 530_000 });
    const d = await okData('get_incident_evidence', { incident_ids: ['inc-1'], window_sim_ms: 60_000 });
    expect(d.incidents[0].incident_id).toBe('inc-1');
    expect(d.signals[0].xid_code).toBe(79);
    expect(d.evidence_ids).toContain('sig-xid79-gpu-r7-n1-3-560000');
  });

  it('caps the serialized size at ~6 KB for huge evidence', async () => {
    const t: TelemetryEvent[] = [];
    for (let i = 0; i < 800; i++) {
      t.push({
        schema_version: '1.1.0', event_id: `tel-${i}-with-a-rather-long-identifier-suffix`, run_id: RUN,
        resource_id: `gpu-r${(i % 8) + 1}-n1-${i % 8}`, source_kind: 'simulator', source_id: 'sim', source_seq: i,
        observed_unix_ms: 1, sim_time_ms: 500_000 + i * 10, metric: i % 2 ? 'DCGM_FI_DEV_GPU_TEMP' : 'DCGM_FI_DEV_POWER_USAGE',
        value: 80 + (i % 7), unit: 'degC', quality: 'good', labels: {},
      });
    }
    db.telemetry.push(...t);
    const r = await call('get_incident_evidence', { incident_ids: [] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(JSON.stringify(r.data).length).toBeLessThanOrEqual(6000);
      expect((r.data as any).omitted.telemetry).toBeGreaterThan(0);
    }
  });
});

describe('get_resource_dependencies', () => {
  it('returns the gpu -> node -> rack -> loop -> pump chain', async () => {
    const d = await okData('get_resource_dependencies', { resource_ids: ['gpu-r2-n1-0'], depth: 3 });
    const r = d.resources[0];
    expect(r.chains).toContain('gpu-r2-n1-0 -> node-r2-n1 -> rack-r2 -> loop-a');
    const deep = await okData('get_resource_dependencies', { resource_ids: ['gpu-r2-n1-0'] , depth: 3 });
    expect(deep.resources[0].providers.map((p: any) => p.id)).toEqual(expect.arrayContaining(['node-r2-n1', 'rack-r2', 'loop-a']));
  });

  it('lists consumers of a pump and flags unknown ids', async () => {
    const d = await okData('get_resource_dependencies', { resource_ids: ['pump-a', 'nope'], depth: 2 });
    expect(d.resources[0].consumers.map((c: any) => c.id)).toEqual(expect.arrayContaining(['loop-a', 'rack-r2']));
    expect(d.resources[1].error).toMatch(/unknown/);
  });
});

describe('get_job_state', () => {
  it('returns spec, state, allocation and checkpoint age', async () => {
    const d = await okData('get_job_state', { job_ids: ['job-a', 'job-x'] });
    const a = d.jobs[0];
    expect(a.spec.gpus_required).toBe(16);
    expect(a.allocation.gpu_count).toBe(16);
    expect(Object.keys(a.allocation.by_rack).sort()).toEqual(['rack-r2', 'rack-r3']);
    expect(a.checkpoint.age_sim_s).toBe(540);
    expect(a.state.at_risk_work_units).toBe(8064);
    expect(d.jobs[1].error).toMatch(/unknown/);
  });
});

describe('list_placement_candidates', () => {
  it('offers free healthy whole-node sets, never gpu-real-0 or busy GPUs, sorted by headroom', async () => {
    const snap = loadPumpDegradedSnapshot();
    const busy = new Set(snap.job_states.flatMap((j) => j.allocated_gpu_ids));
    const d = await okData<{ candidates: PlacementCandidate[] }>('list_placement_candidates', { job_id: 'job-a' });
    expect(d.candidates.length).toBeGreaterThan(0);
    for (const c of d.candidates) {
      expect(c.destination_gpu_ids).toHaveLength(16);
      expect(c.destination_gpu_ids).not.toContain('gpu-real-0');
      for (const g of c.destination_gpu_ids) expect(busy.has(g)).toBe(false);
      expect(c.rack_ids.every((r) => !['rack-r2', 'rack-r3', 'rack-r4', 'rack-r6'].includes(r))).toBe(true);
    }
    const headrooms = d.candidates.map((c) => c.min_thermal_headroom_c);
    expect(headrooms).toEqual([...headrooms].sort((a, b) => b - a));
    expect(d.candidates.some((c) => c.rack_ids.includes('rack-r7'))).toBe(true);
  });

  it('ranks a low-headroom rack last when it has free GPUs', async () => {
    const snap = loadPumpDegradedSnapshot();
    // Free job-c from r6 so r6 (2 C headroom) becomes feasible but should sort last.
    const jc = snap.job_states.find((j) => j.job_id === 'job-c')!;
    jc.allocated_gpu_ids = [];
    snap.allocations = snap.allocations.filter((a) => a.job_id !== 'job-c');
    const db2 = new FakeDb({ snapshot: snap, physics });
    const reg2 = createToolRegistry({ db: db2, physics, workflowId: WF, runId: RUN });
    const r = await reg2.invoke('list_placement_candidates', JSON.stringify({ job_id: 'job-b' }));
    expect(r.ok).toBe(true);
    const cands = (r as any).data.candidates as PlacementCandidate[];
    const r6 = cands.findIndex((c) => c.rack_ids.includes('rack-r6'));
    expect(r6).toBe(cands.length - 1);
    expect(cands[r6]!.low_headroom).toBe(true);
  });

  it('fails cleanly for an unknown job', async () => {
    expect((await call('list_placement_candidates', { job_id: 'job-zzz' })).ok).toBe(false);
  });
});

describe('simulate_plan', () => {
  it('fills the envelope and returns PlanMetrics with a short summary', async () => {
    const cands = await okData<{ candidates: PlacementCandidate[] }>('list_placement_candidates', { job_id: 'job-a' });
    const dest = cands.candidates[0]!.destination_gpu_ids;
    const r = await call('simulate_plan', {
      commands: [
        { operation: 'checkpoint', target_resource_id: 'job-a' },
        { operation: 'migrate_restart', target_resource_id: 'job-a', arguments: { destination_gpu_ids: dest }, depends_on_command_keys: [`${WF}:checkpoint:job-a:1`] },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as any;
    expect(data.metrics).toHaveProperty('expected_lost_work_units');
    expect(data.metrics.violations).toEqual([]);
    expect(data.commands.map((c: any) => c.command_key)).toEqual([`${WF}:checkpoint:job-a:1`, `${WF}:migrate_restart:job-a:1`]);
    expect(r.summary).toMatch(/^simulate_plan\(job-a ckpt\+move→r\d/);
    expect(physics.calls.filter((c) => c.method === 'simulatePlan')).toHaveLength(1);
  });

  it('rejects arguments that do not match the operation', async () => {
    const r = await call('simulate_plan', { commands: [{ operation: 'migrate_restart', target_resource_id: 'job-a', arguments: {} }] });
    expect(r.ok).toBe(false);
  });
});

describe('buildCommand', () => {
  it('produces a schema-valid, deterministic command with snapshot epoch and versions', () => {
    const snap = loadPumpDegradedSnapshot();
    const mk = () => buildCommand({ operation: 'checkpoint', target_resource_id: 'job-a' }, snap, { runId: RUN, workflowId: WF });
    const c = mk();
    expect(validatePayload('ActionCommand', c).ok).toBe(true);
    expect(c.command_key).toBe(`${WF}:checkpoint:job-a:1`);
    expect(c.expected_decision_epoch).toBe(snap.clock.decision_epoch);
    expect(c.requested_sim_time_ms).toBe(snap.clock.sim_time_ms);
    expect(c.expected_resource_versions['job-a']).toBeTypeOf('number');
    expect(mk()).toEqual(c);
  });

  it('throws CommandBuildError on bad arguments', () => {
    expect(() => buildCommand({ operation: 'power_cap', target_resource_id: 'job-b' }, loadPumpDegradedSnapshot(), { runId: RUN, workflowId: WF })).toThrow(CommandBuildError);
  });
});

describe('propose_plan', () => {
  const base = () => ({
    incident_ids: ['inc-1'],
    assumptions: ['pump-a stays degraded'],
    command_keys: [`${WF}:checkpoint:job-a:1`, `${WF}:migrate_restart:job-a:1`],
    expected_completion_delay_sim_s: 150,
    expected_lost_work_units: 0,
    expected_gpu_busy_waste_s: 10,
    failure_risk_estimate: 0.02,
    explanation: 'Checkpoint then move job-a to r7/r8; loop-a degraded (sig-1).',
  });

  it('persists a proposal via submitPlan and does not execute', async () => {
    const d = await okData('propose_plan', base());
    expect(db.plans.get(d.plan_id)?.command_keys).toHaveLength(2);
    expect(db.calls.some((c) => c.method === 'requestAction')).toBe(false);
    expect(db.plans.get(d.plan_id)?.based_on_decision_epoch).toBe(2);
  });

  it('is deterministic: same commands give the same plan_id', async () => {
    const a = await okData('propose_plan', base());
    const b = await okData('propose_plan', base());
    expect(a.plan_id).toBe(b.plan_id);
  });

  it('rejects a stale decision epoch and invalid plans', async () => {
    expect((await call('propose_plan', { ...base(), based_on_decision_epoch: 1 })).ok).toBe(false);
    expect((await call('propose_plan', { ...base(), command_keys: [] })).ok).toBe(false);
    expect((await call('propose_plan', { ...base(), failure_risk_estimate: 3 })).ok).toBe(false);
    expect(db.plans.size).toBe(0);
  });
});

describe('get_action_status', () => {
  it('reports found:false for an unknown key', async () => {
    const d = await okData('get_action_status', { command_key: 'nope' });
    expect(d.found).toBe(false);
  });

  it('reads a requested action from the ledger', async () => {
    const snap = loadPumpDegradedSnapshot();
    const cmd = buildCommand({ operation: 'checkpoint', target_resource_id: 'job-b' }, snap, { runId: RUN, workflowId: WF });
    await db.requestAction(cmd);
    const d = await okData('get_action_status', { command_key: cmd.command_key });
    expect(d.found).toBe(true);
    expect(d.status.status).toBe('requested');
  });
});
