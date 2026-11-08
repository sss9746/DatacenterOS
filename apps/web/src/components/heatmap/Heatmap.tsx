import { useRef, type KeyboardEvent } from 'react';
import { ArrowUpRight, Zap, X, Cpu } from 'lucide-react';
import type { GpuCurrent, ObservedSnapshot } from '@dcos/contracts';
import { Panel, Badge } from '../ui/panel';
import { number } from '../../lib/utils';

export const thermalState = (gpu: GpuCurrent) => gpu.availability !== 'ready' || gpu.last_xid_code !== null ? 'fault' : gpu.temp_c >= 85 ? 'hot' : gpu.temp_c >= 80 ? 'warm' : 'normal';
export function Heatmap({ snapshot, selected, onSelect }: { snapshot: ObservedSnapshot; selected: string; onSelect: (id: string) => void }) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const gpus = new Map(snapshot.gpus.map((gpu) => [gpu.resource_id, gpu]));
  const jobs = new Map(snapshot.allocations.map((row) => [row.gpu_id, row.job_id]));
  const focusNeighbor = (event: KeyboardEvent<HTMLButtonElement>, rack: number, column: number) => {
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Home: [0, -column], End: [0, 7 - column] };
    const move = moves[event.key]; if (!move) return;
    event.preventDefault();
    const id = `gpu-r${Math.max(1, Math.min(8, rack + move[0]))}-n1-${Math.max(0, Math.min(7, column + move[1]))}`;
    onSelect(id); buttons.current.get(id)?.focus();
  };
  const current = gpus.get(selected);
  return <Panel title="GPU topology" id="topology" detail={<Badge>Simulated · °C</Badge>}>
    <div className="heatmap-intro"><span>8 racks <span className="separator">/</span> 8 GPUs per rack</span><span>Node 1 in each rack</span></div>
    <div className="matrix" role="group" aria-label="64 simulated GPUs, grouped by rack. Use arrow keys to inspect neighboring GPUs.">
      <div className="matrix-labels"><span>Rack / loop</span>{Array.from({ length: 8 }, (_, i) => <span key={i}>{String(i).padStart(2, '0')}</span>)}</div>
      {Array.from({ length: 8 }, (_, row) => {
        const rack = row + 1; const loopA = rack >= 2 && rack <= 4;
        return <div className={`matrix-row ${loopA ? 'loop-a-row' : ''}`} key={rack}>
          <div className="rack-label"><strong>R{rack}</strong><span>{loopA ? 'loop-a' : 'loop-b'}</span></div>
          {Array.from({ length: 8 }, (_, column) => {
            const id = `gpu-r${rack}-n1-${column}`; const gpu = gpus.get(id); const job = jobs.get(id);
            if (!gpu) return <div className="gpu-cell gpu-missing" key={id} aria-label={`${id}, no data`}>—</div>;
            const unavailable = gpu.availability !== 'ready' || gpu.last_xid_code !== null;
            return <button key={id} ref={(el) => { if (el) buttons.current.set(id, el); else buttons.current.delete(id); }} className={`gpu-cell gpu-${thermalState(gpu)} ${job || 'unallocated'} ${selected === id ? 'selected' : ''}`} data-gpu={id} aria-label={`${id}, ${number(gpu.temp_c, 1)} degrees Celsius, ${gpu.availability}${gpu.last_xid_code ? `, XID ${gpu.last_xid_code}` : ''}, ${job ?? 'unallocated'}`} aria-pressed={selected === id} tabIndex={selected === id ? 0 : -1} onClick={() => onSelect(id)} onKeyDown={(event) => focusNeighbor(event, rack, column)}>
              <span>{unavailable ? <X size={14}/> : (gpu.clocks_event_reasons & 0x20) !== 0 ? <Zap size={12}/> : null}{unavailable && gpu.last_xid_code ? gpu.last_xid_code : Math.round(gpu.temp_c)}</span>
            </button>;
          })}
        </div>;
      })}
    </div>
    <div className="heatmap-legend"><span><i className="legend-square normal"/>Below 80°</span><span><i className="legend-square warm"/>80–84°</span><span><i className="legend-square hot"/>85°+ / throttle</span><span><X size={12}/>Fault</span><span className="loop-legend">R2–R4 share loop A</span></div>
    <div className="gpu-inspector" aria-live="polite"><div><Cpu size={18}/><strong>{selected}</strong><Badge tone={current && thermalState(current) !== 'normal' ? 'warning' : 'neutral'}>{current?.availability ?? 'No data'}</Badge></div>{current ? <dl><div><dt>Temperature</dt><dd>{number(current.temp_c, 1)} °C</dd></div><div><dt>SM clock</dt><dd>{number(current.sm_clock_mhz)} MHz</dd></div><div><dt>Power</dt><dd>{number(current.power_w)} W</dd></div><div><dt>Allocated to</dt><dd>{jobs.get(selected) ? <a href="#jobs">{jobs.get(selected)}<ArrowUpRight size={12}/></a> : 'Free capacity'}</dd></div></dl> : <p>Waiting for this GPU’s public telemetry.</p>}</div>
  </Panel>;
}
