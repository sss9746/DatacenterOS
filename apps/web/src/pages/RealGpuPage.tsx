import type { PageProps } from '../app/page-props';
import { RealGpu } from '../components/heatmap/RealGpu';
import { Badge, Panel } from '../components/ui/panel';
import '../components/heatmap/real-gpu.css';

/**
 * Page 6 — "What is the one real L40S doing?" Owner: agent D. The tile keeps RealGpu.tsx's live/stale/REPLAY/offline
 * rules untouched; this page only adds the explanation of what each state means.
 */
export function RealGpuPage({ state, now, mode }: PageProps) {
  return <div className="real-gpu-page">
    <RealGpu evidence={state.evidence} now={now}/>
    <Panel title="How to read this tile" className="real-gpu-about" detail={<Badge tone={mode === 'live' ? 'neutral' : 'mock'}>{mode === 'live' ? 'Live DB' : 'Mock mode · no collector'}</Badge>}>
      <p>One real NVIDIA L40S on Brev streams <code>nvidia-smi</code> readings into the twin as <code>gpu-real-0</code>. It is observed only: the planner never places a job on it, and its numbers are never mixed into the simulated cluster.</p>
      <ul className="real-gpu-legend" aria-label="Tile states">
        <li><Badge tone="real">REAL</Badge><span>Green is reserved for real hardware readings. A sample fresher than 15 s shows as <strong>Live</strong>.</span></li>
        <li><Badge>REPLAY</Badge><span>A recorded trace of the same GPU, shown only when no live reading exists. It never claims to be live.</span></li>
        <li><span className="real-gpu-offline-dot">Stale</span><span>The latest sample is older than 15 s. Values stay on screen but are marked stale.</span></li>
        <li><span className="real-gpu-offline-dot">Collector offline</span><span>No sample for 15 s, or mock mode (which has no collector). Nothing is simulated in its place.</span></li>
      </ul>
    </Panel>
  </div>;
}
