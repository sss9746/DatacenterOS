import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActionDetail } from '@dcos/db-client';
import { createLocalPhysicsClient } from '../src/data/local-physics';
import { buildFaultInjection } from '../src/components/controls/fault-form';
import { capacityLoss, detectMoves, jobRacks, loopPath, moveArcPath, rackAnchor, rackColumnsFor, racksOfGpus, type RackGridGeometry } from '../src/components/simulation/topology';
import { SimulationView, stateOf } from '../src/components/simulation/SimulationView';
import { situation, situationTone } from '../src/components/simulation/situation';
import { clusterImpact, impactStats, isBlockedBySafety } from '../src/components/simulation/impact-model';

const alloc = (job: string, ...gpus: string[]) => gpus.map((gpu_id) => ({ job_id: job, gpu_id }));

describe('job moves are derived from consecutive allocation sets', () => {
  it('reads rack sets from gpu ids and ignores ids without a rack', () => {
    expect(racksOfGpus(['gpu-r3-n1-0', 'gpu-r2-n1-7', 'gpu-r3-n1-1', 'gpu-real-0'])).toEqual([2, 3]);
    expect(jobRacks([...alloc('job-a', 'gpu-r2-n1-0', 'gpu-r3-n1-0'), ...alloc('job-b', 'gpu-r4-n1-1')])).toEqual({ 'job-a': [2, 3], 'job-b': [4] });
  });

  it('detects a move only when a job keeps an allocation but its racks change', () => {
    const before = { 'job-a': [2, 3], 'job-b': [4], 'job-c': [6] };
    expect(detectMoves(before, { 'job-a': [2, 3], 'job-b': [5], 'job-c': [6] })).toEqual([{ jobId: 'job-b', from: [4], to: [5] }]);
    expect(detectMoves(before, before)).toEqual([]);
    expect(detectMoves(before, { 'job-a': [2, 3], 'job-c': [6] })).toEqual([]); // job-b lost its allocation: a failure, not a move
    expect(detectMoves({}, before)).toEqual([]); // first allocations are starts, not moves
  });
});

describe('coolant loop and move geometry', () => {
  const g: RackGridGeometry = { width: 800, height: 200 + 46, cols: 8, gap: 8, bandHeight: 46 };
  it('places racks on a single row and threads loop A under racks 2–4', () => {
    expect(rackColumnsFor(900)).toBe(8); expect(rackColumnsFor(500)).toBe(4); expect(rackColumnsFor(320)).toBe(2);
    const r1 = rackAnchor(1, g); const r2 = rackAnchor(2, g);
    expect(r1.x).toBeCloseTo(46.5); expect(r2.x).toBeCloseTo(147.5); expect(r1.bottom).toBe(200); expect(r1.top).toBe(0);
    const d = loopPath([2, 3, 4], 14, g);
    expect(d.startsWith('M 147.5 214.0 H 349.5')).toBe(true);
    expect(d.match(/ V 214\.0/g)).toHaveLength(3); // one riser per rack
    expect(loopPath([2, 3, 4], 14, { ...g, cols: 4 })).toBe(''); // wrapped grid: band hidden
  });
  it('draws the move arc from the first old rack to the first new rack above the row', () => {
    expect(moveArcPath({ jobId: 'job-b', from: [4], to: [5] }, g).startsWith('M 349.5 6.0 Q 400.0 -22.0 450.5 6.0')).toBe(true);
    expect(moveArcPath({ jobId: 'job-b', from: [4], to: [5] }, { ...g, width: 0 })).toBe('');
  });
  it('reads the pump capacity loss from observed vs nominal only', () => {
    expect(capacityLoss({ nominal_capacity_w: 1000, observed_capacity_estimate_w: 400 })).toBe(0.6);
    expect(capacityLoss({ nominal_capacity_w: 1000, observed_capacity_estimate_w: null })).toBeNull();
    expect(capacityLoss(undefined)).toBeNull();
  });
});

describe('XID 79 in the rendered cluster', () => {
  it('marks the failed tile with XID 79 in the detail tile, one fault tile in the rack glyphs, and says so in the situation line', async () => {
    const client = createLocalPhysicsClient();
    try {
      const before = await client.getObservedSnapshot();
      expect(situation(before)).toBe('All 64 GPUs healthy');
      expect(situationTone(before)).toBe('normal');
      expect(impactStats(clusterImpact(before)).map((s) => [s.value, s.tone])).toEqual([[0, 'neutral'], [0, 'neutral'], [0, 'neutral'], [3, 'agent'], [0, 'neutral']]);
      await client.injectFault(buildFaultInjection({ runId: before.run_id, simTimeMs: before.clock.sim_time_ms, faultId: 'judge-x', kind: 'gpu_xid_79', targetId: 'gpu-r3-n1-0', delayS: 0 }));
      client.advance(5);
      const after = await client.getObservedSnapshot();
      const gpu = after.gpus.find((row) => row.resource_id === 'gpu-r3-n1-0')!;
      expect(stateOf(gpu)).toBe('fault');
      const html = renderToStaticMarkup(createElement(SimulationView, { snapshot: after, selected: 'gpu-r3-n1-0', onSelect: () => {}, onSelectPump: () => {} }));
      expect(html).toMatch(/data-gpu="gpu-r3-n1-0"[^>]*aria-label="GPU 0, [^"]*XID 79/);
      expect(html.match(/sim-rack-module-fault/g)?.length).toBe(1);
      expect(situation(after)).toMatch(/^1 GPU failed/);
      expect(situationTone(after)).toBe('danger');
      const impact = clusterImpact(after);
      expect(impact.gpusFailed).toBe(1);
      expect(impact.jobsProtected).toBeLessThan(impact.jobsTotal); // the failed GPU's job is no longer protected with nothing in flight
      expect(impactStats(impact).find((s) => s.id === 'gpus')?.tone).toBe('danger');
    } finally { client.close(); }
  });
});

describe('unsafe moves are counted as BLOCKED, never as executed', () => {
  const detail = (status: string, reason: string | null): ActionDetail => ({ status: { status, reason_code: reason } as unknown as ActionDetail['status'], command: { operation: 'migrate_restart', job_id: 'job-b', command_key: 'k' } as unknown as ActionDetail['command'], claimed_by: null, due_sim_time_ms: null, safety: null, start_safety: null, history: [] });
  it('only counts failed + SAFETY_REJECTED', () => {
    expect(isBlockedBySafety(detail('failed', 'SAFETY_REJECTED'))).toBe(true);
    expect(isBlockedBySafety(detail('failed', 'TIMEOUT'))).toBe(false);
    expect(isBlockedBySafety(detail('succeeded', null))).toBe(false);
    const stat = impactStats({ pumpsDegraded: 0, racksHot: 0, gpusFailed: 0, jobsProtected: 3, jobsTotal: 3, unsafeMovesBlocked: 1 }).find((s) => s.id === 'blocked')!;
    expect(stat.label).toBe('unsafe move blocked'); expect(stat.tone).toBe('agent');
  });
});
