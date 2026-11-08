import { Fan, Minus } from 'lucide-react';
import type { ObservedSnapshot } from '@dcos/contracts';
import { Panel, Badge } from '../ui/panel';
import { number } from '../../lib/utils';
export function Cooling({ snapshot }: { snapshot: ObservedSnapshot }) {
  return <Panel title="Cooling & headroom" detail={<Badge>Simulated</Badge>}>
    <div className="pumps">{['a', 'b'].map((id) => {
      const pump = snapshot.cooling.find((row) => row.resource_id === `pump-${id}`);
      const loop = snapshot.cooling.find((row) => row.resource_id === `loop-${id}`);
      return <div className="pump" key={id}><Fan size={20}/><div><strong>Pump {id.toUpperCase()}</strong><span>loop-{id} · {id === 'a' ? 'r2–r4' : 'r1, r5–r8'}</span></div><div className="pump-reading"><Badge tone={pump && pump.operating_state !== 'normal' ? 'warning' : 'neutral'}>{pump?.operating_state ?? 'No data'}</Badge><span>{pump ? `${number(pump.pump_power_w / 1000, 1)} kW` : '—'} · loop {loop?.operating_state ?? 'no telemetry'}</span></div></div>;
    })}</div>
    <div className="rack-headroom" aria-label="Simulated thermal headroom by rack">{Array.from({ length: 8 }, (_, i) => {
      const node = snapshot.nodes.find((row) => row.rack_id === `rack-r${i + 1}`);
      return <div key={i} className={node && node.thermal_headroom_c < 7 ? 'headroom-low' : ''}><span>R{i + 1}</span><div className="headroom-track" aria-hidden="true"><i style={{ height: `${node ? Math.min(100, Math.max(0, node.thermal_headroom_c / 50 * 100)) : 0}%` }}/></div><strong>{node ? `${number(node.thermal_headroom_c, 1)}°` : <Minus size={12}/>}</strong></div>;
    })}</div><p className="panel-footnote">Available thermal headroom · reference scale 0–50 °C</p>
  </Panel>;
}
