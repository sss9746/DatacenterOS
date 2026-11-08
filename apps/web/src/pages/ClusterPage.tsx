import type { PageProps } from '../app/page-props';
import { SimulationView } from '../components/simulation/SimulationView';
import { Impact } from '../components/simulation/Impact';
import { situation, situationTone } from '../components/simulation/situation';
import { Cooling } from '../components/cooling/Cooling';
import { RealGpu } from '../components/heatmap/RealGpu';
import { Badge } from '../components/ui/panel';
import '../components/heatmap/real-gpu.css';

/** The four cluster-impact tiles on the left; the safety tile sits under the real GPU on the right. */
const MAIN_STATS = ['pumps', 'racks', 'gpus', 'jobs'] as const;
const SIDE_STATS = ['blocked'] as const;

/**
 * Page 1 — "Is the cluster healthy right now?" One sentence, the impact counts, then the simulated cluster itself.
 * The one real GPU (`gpu-real-0`) is shown top-right as an observation-only tile; it is never drawn in the simulated grid.
 * RealGpu.tsx keeps its live/stale/REPLAY/offline rules untouched; this page only adds the legend that explains them.
 */
export function ClusterPage({ snapshot, state, example, mode, now, selectedGpuId, onSelectGpu, onSelectPump }: PageProps) {
  const tone = situationTone(snapshot);
  return <>
    <p className={`cluster-situation is-${tone}`} aria-live="polite">
      {situation(snapshot)}
      <small>{example ? 'Scripted example · every value on this page is a simulated illustration.' : 'Simulated cluster · 8 racks, 64 GPUs, 2 cooling pumps.'}</small>
    </p>
    <div className="cluster-top">
      <Impact snapshot={snapshot} details={state.actionDetails} ids={MAIN_STATS} className="cluster-impact-main"/>
      <div className="cluster-side">
        <div className="real-gpu-wrap">
          <RealGpu evidence={state.evidence} now={now}/>
          <details className="real-gpu-how">
            <summary>How to read this tile <Badge tone={mode === 'live' ? 'neutral' : 'mock'}>{mode === 'live' ? 'Live DB' : 'Mock · no collector'}</Badge></summary>
            <p>One real NVIDIA L40S on Brev streams <code>nvidia-smi</code> readings into the twin as <code>gpu-real-0</code>. Observed only: the planner never places a job on it and its numbers never mix into the simulated cluster.</p>
            <ul className="real-gpu-legend" aria-label="Tile states">
              <li><Badge tone="real">REAL</Badge><span>Green marks real hardware readings. A sample fresher than 15 s shows as <strong>Live</strong>.</span></li>
              <li><Badge>REPLAY</Badge><span>A recording of the same GPU, shown only when no live reading exists. It never claims to be live.</span></li>
              <li><span className="real-gpu-offline-dot">Stale</span><span>The latest sample is older than 15 s; values stay but are marked stale.</span></li>
              <li><span className="real-gpu-offline-dot">Collector offline</span><span>No sample for 15 s, or mock mode (no collector). Nothing is simulated in its place.</span></li>
            </ul>
          </details>
        </div>
        <Impact snapshot={snapshot} details={state.actionDetails} ids={SIDE_STATS} label="Safety summary (simulated)" className="cluster-impact-side"/>
      </div>
    </div>
    <SimulationView snapshot={snapshot} selected={selectedGpuId} onSelect={onSelectGpu} onSelectPump={onSelectPump} telemetry={state.evidence?.telemetry} actionDetails={state.actionDetails}/>
    <details className="sim-more"><summary>Detailed cooling measurements</summary><Cooling snapshot={snapshot}/></details>
  </>;
}
