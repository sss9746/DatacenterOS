import type { PageProps } from '../app/page-props';
import { SimulationView } from '../components/simulation/SimulationView';
import { Impact } from '../components/simulation/Impact';
import { situation, situationTone } from '../components/simulation/situation';
import { Cooling } from '../components/cooling/Cooling';

/**
 * Page 1 — "Is the cluster healthy right now?" One sentence, five counts, then the simulated cluster itself.
 * The real GPU (`gpu-real-0`) has its own page and is never drawn in this grid.
 */
export function ClusterPage({ snapshot, state, example, selectedGpuId, onSelectGpu, onSelectPump }: PageProps) {
  const tone = situationTone(snapshot);
  return <>
    <p className={`cluster-situation is-${tone}`} aria-live="polite">
      {situation(snapshot)}
      <small>{example ? 'Scripted example · every value on this page is a simulated illustration.' : 'Simulated cluster · 8 racks, 64 GPUs, 2 cooling pumps.'}</small>
    </p>
    <Impact snapshot={snapshot} details={state.actionDetails}/>
    <SimulationView snapshot={snapshot} selected={selectedGpuId} onSelect={onSelectGpu} onSelectPump={onSelectPump} telemetry={state.evidence?.telemetry} actionDetails={state.actionDetails}/>
    <details className="sim-more"><summary>Detailed cooling measurements</summary><Cooling snapshot={snapshot}/></details>
  </>;
}
