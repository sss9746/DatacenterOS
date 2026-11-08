import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Evidence } from '@dcos/db-client';
import { RealGpu } from '../src/components/heatmap/RealGpu';

const NOW = 1_762_600_000_000;
const row = (source_kind: string, value: number, ageMs = 1_000) => ({
  resource_id: 'gpu-real-0',
  source_kind,
  metric: 'nvidia_smi.temperature_gpu',
  value,
  unit: 'C',
  quality: 'good',
  observed_unix_ms: NOW - ageMs,
  labels: { collector: 'nvidia-smi' },
});
const render = (telemetry: ReturnType<typeof row>[]) =>
  renderToStaticMarkup(createElement(RealGpu, { evidence: { telemetry } as unknown as Evidence, now: NOW }));

describe('RealGpu', () => {
  it('shows fresh hardware readings as live and real', () => {
    const html = render([row('hardware', 54)]);
    expect(html).toContain('Live');
    expect(html).toContain('REAL');
    expect(html).not.toContain('REPLAY');
  });

  it('labels a recording as replay and never as live', () => {
    const html = render([row('replay', 41)]);
    expect(html).toContain('REPLAY OF REAL RECORDING');
    expect(html).toContain('41');
    expect(html).not.toContain('Live');
    expect(html).not.toContain('>REAL<');
  });

  it('prefers live hardware over a replay still in the window', () => {
    const html = render([row('replay', 41), row('hardware', 54)]);
    expect(html).toContain('54');
    expect(html).not.toContain('REPLAY');
  });

  it('shows the offline state with no readings', () => {
    expect(render([])).toContain('collector offline');
  });
});
