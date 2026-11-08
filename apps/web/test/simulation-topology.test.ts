import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMockClient } from '@dcos/db-client';
import type { TelemetryEvent } from '@dcos/contracts';
import { createLocalPhysicsClient } from '../src/data/local-physics';
import { buildFaultInjection, DEFAULT_XID_GPU_ID } from '../src/components/controls/fault-form';
import { coolingLoops, degradedPumps, formatDeltaC, inletRiseC, loopOfRack, pumpLabel, rackRanges } from '../src/components/simulation/topology';
import { loopSegments, SimulationView } from '../src/components/simulation/SimulationView';
import { situation } from '../src/components/simulation/situation';

describe('cooling topology read from the snapshot', () => {
  it('maps pumps to racks from cooling_loop resources in local physics and in the fixture', async () => {
    for (const client of [createLocalPhysicsClient(), createMockClient()]) {
      try {
        const loops = coolingLoops(await client.getObservedSnapshot());
        expect(loops.map((loop) => [loop.pumpId, loop.racks])).toEqual([['pump-a', [2, 3, 4]], ['pump-b', [1, 5, 6, 7, 8]]]);
        expect(loopOfRack(loops, 7)?.pumpId).toBe('pump-b');
        expect(loops[0]!.supplyC).toBeTypeOf('number');
      } finally { client.close(); }
    }
  });

  it('yields no loops for a snapshot without cooling topology instead of guessing', () => {
    expect(coolingLoops({ resources: [], dependencies: [] })).toEqual([]);
  });

  it('formats rack ranges and pump names the way the explorer shows them', () => {
    expect(rackRanges([2, 3, 4])).toBe('racks 2–4');
    expect(rackRanges([1, 5, 6, 7, 8])).toBe('racks 1 and 5–8');
    expect(rackRanges([3])).toBe('rack 3');
    expect(rackRanges([1, 2, 5])).toBe('racks 1, 2 and 5');
    expect(rackRanges([])).toBe('no racks');
    expect(pumpLabel('pump-a')).toBe('Pump A');
    expect(formatDeltaC(5.84)).toBe('+5.8 °C');
    expect(formatDeltaC(-0.3)).toBe('−0.3 °C');
    expect(loopSegments(coolingLoops({ resources: [
      { schema_version: '1.1.0', run_id: 'r', resource_id: 'loop-a', kind: 'cooling_loop', parent_id: null, failure_domain_id: 'f', profile: 'p', enabled: true, config: { pump_id: 'pump-a', rack_ids: ['rack-r2', 'rack-r3', 'rack-r4'] } },
      { schema_version: '1.1.0', run_id: 'r', resource_id: 'loop-b', kind: 'cooling_loop', parent_id: null, failure_domain_id: 'f', profile: 'p', enabled: true, config: { pump_id: 'pump-b', rack_ids: ['rack-r1', 'rack-r5', 'rack-r6', 'rack-r7', 'rack-r8'] } },
    ], dependencies: [] }))).toEqual([{ pumpId: 'pump-b', start: 1, end: 1 }, { pumpId: 'pump-a', start: 2, end: 4 }, { pumpId: 'pump-b', start: 5, end: 8 }]);
  });

  it('computes the inlet rise only from measured inlet telemetry and the configured nominal', async () => {
    const client = createLocalPhysicsClient();
    try {
      const snapshot = await client.getObservedSnapshot();
      const loops = coolingLoops(snapshot);
      const loopA = loopOfRack(loops, 3)!;
      const sample = (value: number, simMs: number, quality: TelemetryEvent['quality'] = 'estimated'): TelemetryEvent => ({ schema_version: '1.1.0', event_id: `t-${simMs}`, run_id: snapshot.run_id, resource_id: 'rack-r3', source_kind: 'simulator', source_id: 'sim', source_seq: simMs, observed_unix_ms: 0, sim_time_ms: simMs, metric: 'rack.inlet_temp_c', value, unit: 'degC', quality, labels: {} });
      expect(inletRiseC(3, loopA, snapshot, undefined)).toBeNull();
      expect(inletRiseC(3, loopA, snapshot, [])).toBeNull();
      expect(inletRiseC(3, loopA, snapshot, [sample(loopA.supplyC! + 2, 1), sample(loopA.supplyC! + 5.84, 2), sample(99, 3, 'stale')])).toBe(5.8);
      // Rack 6 carries an inlet offset in its config: the nominal includes it, so the same reading is a smaller rise.
      const r6 = { ...sample(loopA.supplyC! + 12, 1), resource_id: 'rack-r6' };
      expect(inletRiseC(6, loopOfRack(loops, 6), snapshot, [r6])).toBe(0);
    } finally { client.close(); }
  });

  it('flags only real pumps as degraded and marks their racks in the rendered explorer', async () => {
    const client = createLocalPhysicsClient();
    try {
      const before = await client.getObservedSnapshot();
      expect(degradedPumps(before)).toEqual([]);
      await client.injectFault(buildFaultInjection({ runId: before.run_id, simTimeMs: before.clock.sim_time_ms, faultId: 'judge-a', kind: 'cooling_pump_degradation', targetId: 'pump-a', capacityLoss: 0.6, delayS: 0 }));
      client.advance(60);
      const after = await client.getObservedSnapshot();
      expect(degradedPumps(after).map((row) => row.resource_id)).toEqual(['pump-a']);
      const html = renderToStaticMarkup(createElement(SimulationView, { snapshot: after, selected: DEFAULT_XID_GPU_ID, onSelect: () => {}, onSelectPump: () => {} }));
      expect(html.match(/is-on-degraded-loop/g)).toHaveLength(3);
      expect(html).toContain('on degraded Pump A loop'); // rack accessible name / tooltip
      expect(html).toContain('Pump A Cools racks 2–4 · failing · degraded · −60 % capacity'); // pump accessible name carries the loss
      expect(situation(after)).toMatch(/^Pump A is failing — racks 2–4/); // the one page-level sentence
      expect(html).not.toMatch(/sim-tile sim-tile-\w+[^>]*>\d/); // rack tiles carry colour, not numbers
      expect(html).toContain('data-gpu="gpu-r7-n1-0"'); // the chosen rack's eight interactive tiles
      expect(html.match(/data-sim-gpu="gpu-r\d-n1-\d"/g)?.length).toBe(64 + 8); // 64 rack tiles + 8 detail tiles
      expect(html).not.toContain('gpu-real-0'); // the real GPU is never drawn in the simulated grid
      expect(html).not.toContain('since fault'); // no pre-fault reading in a fresh render: no delta is invented
      expect(html).not.toContain('is-failing'); // first paint never plays the failure flourish
    } finally { client.close(); }
  });
});

describe('default Xid target', () => {
  it('sits on pump-b’s loop so the second fault opens a separate incident from the pump-a cooling fault', async () => {
    const client = createLocalPhysicsClient();
    try {
      const snapshot = await client.getObservedSnapshot();
      const rack = Number(/gpu-r(\d+)-/.exec(DEFAULT_XID_GPU_ID)![1]);
      expect(loopOfRack(coolingLoops(snapshot), rack)?.pumpId).toBe('pump-b');
      expect(rack).not.toBe(6);
      expect(snapshot.gpus.some((gpu) => gpu.resource_id === DEFAULT_XID_GPU_ID)).toBe(true);
      expect(buildFaultInjection({ runId: snapshot.run_id, simTimeMs: snapshot.clock.sim_time_ms, faultId: 'judge-x', kind: 'gpu_xid_79', targetId: DEFAULT_XID_GPU_ID, delayS: 0 }).target_resource_id).toBe('gpu-r7-n1-0');
    } finally { client.close(); }
  });
});
