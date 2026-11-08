// FAKE CSV fixtures (hand-written, not from a real GPU) until the Brev box is up.
import { describe, expect, it } from 'vitest';
import { validatePayload } from '@dcos/contracts';
import { createMockClient } from '@dcos/db-client';
import {
  createMonotonicClock,
  createSeq,
  detectReasonField,
  parseCsvLine,
  queryFields,
  rowToEvents,
  type ReasonField,
} from '../src/mapping.js';

const FAKE_LINE = '61, 72.35, 45, 2040, 72.00, 0x0000000000000020, NVIDIA L4';

function eventsFor(line: string, field: ReasonField = 'clocks_event_reasons.active', seq = createSeq(1000)) {
  const row = parseCsvLine(line, field);
  if (!row) throw new Error('expected a row');
  return rowToEvents(row, {
    runId: 'run-demo-1',
    sourceId: 'nvsmi-brev-1',
    sourceKind: 'hardware',
    observedUnixMs: 1_762_600_000_000,
    nextSeq: seq,
    host: 'brev',
  });
}

const byMetric = (evs: ReturnType<typeof eventsFor>) => Object.fromEntries(evs.map((e) => [e.metric, e]));

describe('detectReasonField', () => {
  it('prefers clocks_event_reasons on newer drivers', () => {
    const help = '"clocks_event_reasons.active"\nBitmask...\n"clocks_throttle_reasons.active"\nDeprecated alias';
    expect(detectReasonField(help)).toBe('clocks_event_reasons.active');
  });
  it('falls back to clocks_throttle_reasons on older drivers', () => {
    expect(detectReasonField('"clocks_throttle_reasons.active"\nBitmask of active throttle reasons')).toBe(
      'clocks_throttle_reasons.active',
    );
  });
  it('puts name last in the query so commas in names cannot shift columns', () => {
    expect(queryFields('clocks_throttle_reasons.active')).toEqual([
      'temperature.gpu', 'power.draw', 'utilization.gpu', 'clocks.sm', 'power.limit',
      'clocks_throttle_reasons.active', 'name',
    ]);
  });
});

describe('parseCsvLine + rowToEvents', () => {
  it('maps every metric to the tile wire format', () => {
    const m = byMetric(eventsFor(FAKE_LINE));
    expect(Object.keys(m).sort()).toEqual([
      'nvidia_smi.clocks_event_reasons', 'nvidia_smi.clocks_sm', 'nvidia_smi.power_draw',
      'nvidia_smi.power_limit', 'nvidia_smi.temperature_gpu', 'nvidia_smi.utilization_gpu',
    ]);
    expect(m['nvidia_smi.temperature_gpu']).toMatchObject({ value: 61, unit: 'C' });
    expect(m['nvidia_smi.power_draw']).toMatchObject({ value: 72.35, unit: 'W' });
    expect(m['nvidia_smi.clocks_sm']).toMatchObject({ value: 2040, unit: 'MHz' });
    expect(m['nvidia_smi.clocks_event_reasons']).toMatchObject({ value: 0x20, unit: 'bitmask' });
    const t = m['nvidia_smi.temperature_gpu']!;
    expect(t).toMatchObject({
      resource_id: 'gpu-real-0', source_kind: 'hardware', sim_time_ms: 0, quality: 'good',
      event_id: 'hw.1762600000000.gpu-real-0.nvidia_smi.temperature_gpu',
      labels: { collector: 'nvidia-smi', gpu_name: 'NVIDIA L4', host: 'brev' },
    });
  });

  it('sends utilization as a 0-1 ratio (percent / 100)', () => {
    const m = byMetric(eventsFor(FAKE_LINE));
    expect(m['nvidia_smi.utilization_gpu']).toMatchObject({ value: 0.45, unit: 'ratio' });
    expect(byMetric(eventsFor('40, 70, 100, 2040, 72, 0x0, NVIDIA L4'))['nvidia_smi.utilization_gpu']!.value).toBe(1);
  });

  it('skips [N/A] / [Not Supported] fields instead of sending 0', () => {
    const m = byMetric(eventsFor('61, [N/A], 45, 2040, [Not Supported], [N/A], Tesla T4'));
    expect(m['nvidia_smi.power_draw']).toBeUndefined();
    expect(m['nvidia_smi.power_limit']).toBeUndefined();
    expect(m['nvidia_smi.clocks_event_reasons']).toBeUndefined();
    expect(Object.keys(m)).toHaveLength(3);
    expect(Object.values(m).every((e) => e.value !== 0)).toBe(true);
  });

  it('works with the older clocks_throttle_reasons field name (same column position)', () => {
    const m = byMetric(eventsFor('55, 30.1, 0, 585, 70.00, 0x0000000000000001, Tesla T4', 'clocks_throttle_reasons.active'));
    expect(m['nvidia_smi.clocks_event_reasons']).toMatchObject({ value: 1, unit: 'bitmask' });
    expect(m['nvidia_smi.temperature_gpu']!.labels.gpu_name).toBe('Tesla T4');
  });

  it('keeps a GPU name that contains commas intact', () => {
    expect(eventsFor('61, 72, 45, 2040, 72, 0x0, NVIDIA A10G, rev 2')[0]!.labels.gpu_name).toBe('NVIDIA A10G, rev 2');
  });

  it('rejects blank, short and garbage lines', () => {
    expect(parseCsvLine('', 'clocks_event_reasons.active')).toBeNull();
    expect(parseCsvLine('61, 72', 'clocks_event_reasons.active')).toBeNull();
    expect(parseCsvLine('Failed to initialize NVML: Driver/library version mismatch', 'clocks_event_reasons.active')).toBeNull();
    expect(parseCsvLine('[N/A], [N/A], [N/A], [N/A], [N/A], [N/A], NVIDIA L4', 'clocks_event_reasons.active')).toBeNull();
  });

  it('every event passes validatePayload(TelemetryEvent)', () => {
    const lines = [FAKE_LINE, '61, [N/A], 45, 2040, [N/A], [N/A], Tesla T4', '80, 72, 100, 1800, 72, 0x20, NVIDIA L4'];
    for (const line of lines) {
      for (const ev of eventsFor(line)) expect(validatePayload('TelemetryEvent', ev)).toEqual({ ok: true });
    }
  });

  it('replay events use source_kind replay and a replay. event_id prefix', () => {
    const row = parseCsvLine(FAKE_LINE, 'clocks_event_reasons.active')!;
    const evs = rowToEvents(row, {
      runId: 'run-demo-1', sourceId: 'nvsmi-brev-1-replay', sourceKind: 'replay', observedUnixMs: 5,
      nextSeq: createSeq(0), host: 'brev', extraLabels: { replay: 'REPLAY OF REAL RECORDING' },
    });
    for (const ev of evs) {
      expect(ev.source_kind).toBe('replay');
      expect(ev.event_id.startsWith('replay.5.')).toBe(true);
      expect(ev.labels.replay).toBe('REPLAY OF REAL RECORDING');
      expect(validatePayload('TelemetryEvent', ev)).toEqual({ ok: true });
    }
  });
});

describe('sequencing', () => {
  it('source_seq strictly increases across rows and across a simulated reconnect', () => {
    const seq = createSeq(Date.now());
    const first = eventsFor(FAKE_LINE, 'clocks_event_reasons.active', seq);
    const afterReconnect = eventsFor(FAKE_LINE, 'clocks_event_reasons.active', seq);
    const all = [...first, ...afterReconnect].map((e) => e.source_seq);
    for (let i = 1; i < all.length; i++) expect(all[i]!).toBeGreaterThan(all[i - 1]!);
  });

  it('monotonic clock never repeats a millisecond (unique event_ids)', () => {
    const clock = createMonotonicClock(() => 42);
    expect([clock(), clock(), clock()]).toEqual([42, 43, 44]);
  });

  it('the db-client mock accepts a batch, then rejects the same batch (duplicate event_id / seq)', async () => {
    const db = createMockClient();
    const seq = createSeq(1);
    const batch = eventsFor(FAKE_LINE, 'clocks_event_reasons.active', seq);
    await expect(db.ingestObservations(batch)).resolves.toBeUndefined();
    await expect(db.ingestObservations(batch)).rejects.toThrow();
  });
});
