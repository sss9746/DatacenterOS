import { Cpu } from 'lucide-react';
import type { Evidence } from '@dcos/db-client';
import { Badge } from '../ui/panel';
import { number } from '../../lib/utils';

const METRICS: ReadonlyArray<readonly [metric: string, label: string, unit: string]> = [
  ['nvidia_smi.temperature_gpu', 'Temperature', '°C'], ['nvidia_smi.power_draw', 'Power', 'W'],
  ['nvidia_smi.utilization_gpu', 'Utilization', '%'], ['nvidia_smi.clocks_sm', 'SM clock', 'MHz'],
];
/** A sample older than this is shown but marked stale (unchanged rule). */
const STALE_AFTER_MS = 15_000;

/** The one real GPU (gpu-real-0, nvidia-smi over hardware). Mock mode has no collector, so it shows the offline state. */
export function RealGpu({ evidence, now }: { evidence: Evidence | null; now: number }) {
  const samples = evidence?.telemetry.filter((row) => row.resource_id === 'gpu-real-0' && row.source_kind === 'hardware' && row.labels.collector === 'nvidia-smi') ?? [];
  const latestMs = samples.reduce((max, row) => Math.max(max, row.observed_unix_ms), 0);
  const ageS = latestMs ? Math.max(0, Math.round((now - latestMs) / 1000)) : null;
  const live = ageS !== null && ageS * 1000 <= STALE_AFTER_MS;
  return <section className={`real-gpu ${samples.length ? live ? 'is-live' : 'is-stale' : 'is-offline'}`} aria-labelledby="real-gpu-heading">
    <div className="real-gpu-title"><Cpu size={20} aria-hidden="true"/><h2 id="real-gpu-heading">Real NVIDIA GPU <span>· Brev</span></h2><Badge tone="real">REAL</Badge></div>
    {samples.length ? <>
      <p className="real-gpu-pulse"><i className="pulse-dot" aria-hidden="true"/>{live ? 'Live' : 'Stale'} · updated {ageS} s ago</p>
      <dl className="real-gpu-metrics">{METRICS.map(([metric, label, unit]) => {
        const sample = samples.filter((row) => row.metric === metric).sort((a, b) => b.observed_unix_ms - a.observed_unix_ms)[0];
        const stale = sample && (now - sample.observed_unix_ms > STALE_AFTER_MS || !['good', 'estimated'].includes(sample.quality));
        return <div key={metric}><dt>{label}</dt><dd>{sample ? <><strong>{number(sample.value * (unit === '%' ? 100 : 1), 1)}</strong> <span>{unit}</span>{stale ? <em>stale</em> : null}</> : <span className="real-gpu-none">no data</span>}</dd></div>;
      })}</dl>
    </> : <p className="real-gpu-pulse"><i className="offline-dot" aria-hidden="true"/>Live mode only · not simulated · collector offline</p>}
    <small>gpu-real-0 · observation only · never allocated to jobs</small>
  </section>;
}
