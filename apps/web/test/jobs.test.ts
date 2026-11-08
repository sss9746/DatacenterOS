import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActionDetail, PlanRecord } from '@dcos/db-client';
import { createLocalPhysicsClient } from '../src/data/local-physics';
import { buildFaultInjection } from '../src/components/controls/fault-form';
import { Jobs } from '../src/components/jobs/Jobs';
import { decisionFor, jobName, optionFromOperations, optionLabel, placementText, statusLabel, workAtRisk } from '../src/components/jobs/job-view';

const candidate = (over: Record<string, unknown>) => ({ job_id: 'job-a', option: 'checkpoint_then_migrate', commands_summary: '', predicted_lost_work_units: 0, predicted_work_deficit_units: null, predicted_gpu_busy_waste_s: null, safety: 'allow', violations: [], chosen: true, reason: 'least lost work', decided_by: 'nemotron', snapshot_epoch: 1, as_of_sim_time_ms: 1000, ...over });

describe('work at risk and labels', () => {
  it('is current minus durable, never negative', () => {
    expect(workAtRisk({ progress_work_units: 1200, durable_work_units: 800 })).toBe(400);
    expect(workAtRisk({ progress_work_units: 800, durable_work_units: 800 })).toBe(0);
    expect(workAtRisk({ progress_work_units: 700, durable_work_units: 800 })).toBe(0);
  });
  it('uses plain words for ids, statuses, options and placements', () => {
    expect(jobName('job-a')).toBe('Job A'); expect(jobName('train-7')).toBe('train-7');
    expect(statusLabel('restarting')).toBe('moving'); expect(statusLabel('completed')).toBe('done');
    expect(optionLabel('checkpoint_then_migrate')).toBe('Checkpoint, then move');
    expect(optionFromOperations(['checkpoint', 'migrate_restart'])).toBe('checkpoint_then_migrate');
    expect(optionFromOperations([])).toBe('keep_running');
    expect(placementText([2, 3, 4])).toBe('Racks 2–4'); expect(placementText([4])).toBe('Rack 4'); expect(placementText([1, 5])).toBe('Racks 1 and 5'); expect(placementText([])).toBe('No GPUs assigned');
  });
});

describe('what the agent decided per job', () => {
  it('takes the latest chosen persisted candidate for the job and labels its actor', () => {
    const workflows = [
      { state: { candidates: [candidate({ as_of_sim_time_ms: 1000, option: 'keep_running', decided_by: 'code', reason: 'older' }), candidate({ job_id: 'job-b', option: 'power_cap' })] } },
      { state: { candidates: [candidate({ as_of_sim_time_ms: 2000 }), candidate({ chosen: false, option: 'keep_running', reason: 'rejected' })] } },
    ];
    expect(decisionFor('job-a', workflows)).toEqual({ option: 'checkpoint_then_migrate', label: 'Checkpoint, then move', reason: 'least lost work', decidedBy: 'nemotron', asOfSimMs: 2000 });
    expect(decisionFor('job-b', workflows)?.label).toBe('Cap power, keep running');
    expect(decisionFor('job-c', workflows)).toBeNull();
  });
  it('accepts option ids that start with the job id and tolerates junk', () => {
    const workflows = [{ state: { candidates: [candidate({ job_id: undefined, option_id: 'job-c:cap', option: 'power_cap', decided_by: 'robot' }), null, 'x'] } }, { state: {} }];
    expect(decisionFor('job-c', workflows)).toMatchObject({ option: 'power_cap', decidedBy: 'agent' });
  });
  it('falls back to the latest plan whose commands target the job (actor unknown → agent)', () => {
    const details = [{ command: { command_key: 'k1', job_id: 'job-b', operation: 'checkpoint' } }, { command: { command_key: 'k2', job_id: 'job-b', operation: 'migrate_restart' } }] as unknown as ActionDetail[];
    const plans = [{ plan_id: 'p1', command_keys: ['k1', 'k2'], based_on_decision_epoch: 3, explanation: 'checkpoint first, then move off the hot rack' }] as unknown as PlanRecord[];
    expect(decisionFor('job-b', [], plans, details)).toEqual({ option: 'checkpoint_then_migrate', label: 'Checkpoint, then move', reason: 'checkpoint first, then move off the hot rack', decidedBy: 'agent', asOfSimMs: null });
    expect(decisionFor('job-a', [], plans, details)).toBeNull();
  });
});

describe('rendered job cards', () => {
  it('shows one card per job with its placement, risk line and lost work after an XID fault', async () => {
    const client = createLocalPhysicsClient();
    try {
      const before = await client.getObservedSnapshot();
      const html0 = renderToStaticMarkup(createElement(Jobs, { snapshot: before, losses: {}, history: {} }));
      expect(html0.match(/class="jobcard /g)?.length).toBe(before.job_states.length);
      expect(html0).toContain('id="jobs"');
      expect(html0).toContain('No agent decision recorded');
      expect(html0).not.toContain('work units lost');
      await client.injectFault(buildFaultInjection({ runId: before.run_id, simTimeMs: before.clock.sim_time_ms, faultId: 'judge-x', fault: 'gpu_xid_79', targetId: 'gpu-r3-n1-0', delayS: 0 }));
      client.advance(5);
      const after = await client.getObservedSnapshot();
      const failed = after.job_states.find((job) => job.status === 'failed');
      expect(failed).toBeDefined();
      const html = renderToStaticMarkup(createElement(Jobs, { snapshot: after, losses: { [failed!.job_id]: 410 }, history: {}, workflows: [{ state: { candidates: [candidate({ job_id: failed!.job_id })] } } as never] }));
      expect(html).toContain('>failed<');
      expect(html).toContain('410</strong> work units lost');
      expect(html).toContain('Checkpoint, then move');
      expect(html).toContain('>Nemotron<');
    } finally { client.close(); }
  });
});
