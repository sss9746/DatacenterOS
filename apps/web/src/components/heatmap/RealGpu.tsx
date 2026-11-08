import { Cpu } from 'lucide-react';
import type { Evidence } from '@dcos/db-client';
import { Badge } from '../ui/panel';
import { number } from '../../lib/utils';
export function RealGpu({ evidence, now }: { evidence: Evidence | null; now: number }) {
  const metrics = [ ['nvidia_smi.temperature_gpu', 'Temperature', '°C'], ['nvidia_smi.power_draw', 'Power', 'W'], ['nvidia_smi.utilization_gpu', 'Utilization', '%'], ['nvidia_smi.clocks_sm', 'SM clock', 'MHz'] ];
  const samples = evidence?.telemetry.filter((row) => row.resource_id === 'gpu-real-0' && row.source_kind === 'hardware' && row.labels.collector === 'nvidia-smi') ?? [];
  return <section className="real-gpu" aria-labelledby="real-gpu-heading"><div className="real-gpu-title"><Cpu size={20}/><h2 id="real-gpu-heading">Real NVIDIA GPU <span>· Brev</span></h2><Badge>REAL</Badge></div>{samples.length ? <dl>{metrics.map(([metric, label, unit]) => { const sample = samples.filter((row) => row.metric === metric).sort((a, b) => b.observed_unix_ms - a.observed_unix_ms)[0]; const stale = sample && (now - sample.observed_unix_ms > 15_000 || !['good', 'estimated'].includes(sample.quality)); return <div key={metric}><dt>{label}</dt><dd>{sample ? `${number(sample.value * (unit === '%' ? 100 : 1), 1)} ${unit}${stale ? ' · stale' : ''}` : 'No data'}</dd></div>; })}</dl> : <p><span className="offline-dot"/>No data <span>Waiting for the nvidia-smi collector</span></p>}<small>gpu-real-0 · observation only · never allocated to jobs</small></section>;
}
