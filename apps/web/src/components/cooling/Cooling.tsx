import { Fan, Minus } from 'lucide-react';
import type { ObservedSnapshot } from '@dcos/contracts';
import { Panel, Badge } from '../ui/panel';
import { number } from '../../lib/utils';
import { capacityLoss, coolingLoops, pumpLabel, rackRanges } from '../simulation/topology';
export function Cooling({ snapshot }: { snapshot: ObservedSnapshot }) {
  const loops = coolingLoops(snapshot);
  const pumpIds = loops.length ? loops.map((loop) => loop.pumpId) : ['pump-a', 'pump-b'];
  return <Panel title="Cooling & headroom" detail={<Badge tone="simulated">Simulated</Badge>}>
    <div className="pumps">{pumpIds.map((pumpId) => {
      const pump = snapshot.cooling.find((row) => row.resource_id === pumpId);
      const loopMeta = loops.find((loop) => loop.pumpId === pumpId);
      const loop = loopMeta ? snapshot.cooling.find((row) => row.resource_id === loopMeta.loopId) : undefined;
      const loss = capacityLoss(pump);
      return <div className="pump" key={pumpId}><Fan size={20}/><div><strong>{pumpLabel(pumpId)}</strong><span>{loopMeta ? `${loopMeta.loopId} · ${rackRanges(loopMeta.racks)}` : 'loop not reported'}</span></div><div className="pump-reading"><Badge tone={pump && pump.operating_state !== 'normal' ? 'warning' : 'neutral'}>{pump?.operating_state ?? 'No data'}{loss !== null && loss > 0 ? ` · −${Math.round(loss * 100)} %` : ''}</Badge><span>{pump ? `${number(pump.pump_power_w / 1000, 1)} kW` : '—'} · loop {loop?.operating_state ?? 'no telemetry'}</span></div></div>;
    })}</div>
    <div className="rack-headroom" aria-label="Simulated thermal headroom by rack">{Array.from({ length: 8 }, (_, i) => {
      const node = snapshot.nodes.find((row) => row.rack_id === `rack-r${i + 1}`);
      return <div key={i} className={node && node.thermal_headroom_c < 7 ? 'headroom-low' : ''}><span>R{i + 1}</span><div className="headroom-track" aria-hidden="true"><i style={{ height: `${node ? Math.min(100, Math.max(0, node.thermal_headroom_c / 50 * 100)) : 0}%` }}/></div><strong>{node ? `${number(node.thermal_headroom_c, 1)}°` : <Minus size={12}/>}</strong></div>;
    })}</div><p className="panel-footnote">Available thermal headroom · reference scale 0–50 °C</p>
  </Panel>;
}
