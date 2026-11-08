import type { PageProps } from '../app/page-props';
import { SimulationView } from '../components/simulation/SimulationView';
import { Cooling } from '../components/cooling/Cooling';

/** Page 1 — "Is the cluster healthy right now?" Owner: agent C. This stub renders the existing components. */
export function ClusterPage({ snapshot, state, selectedGpuId, onSelectGpu, onSelectPump }: PageProps) {
  return <>
    <SimulationView snapshot={snapshot} selected={selectedGpuId} onSelect={onSelectGpu} onSelectPump={onSelectPump} telemetry={state.evidence?.telemetry}/>
    <details className="sim-more"><summary>Detailed cooling measurements</summary><Cooling snapshot={snapshot}/></details>
  </>;
}
