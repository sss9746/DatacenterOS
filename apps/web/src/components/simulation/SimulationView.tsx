import { useEffect, useRef, useState } from 'react';
import { Activity, Fan, Server } from 'lucide-react';
import type { GpuCurrent, ObservedSnapshot, TelemetryEvent } from '@dcos/contracts';
import { number } from '../../lib/utils';
import type { PumpId } from '../controls/fault-form';
import { coolingLoops, degradedPumps, formatDeltaC, inletRiseC, isPumpId, loopOfRack, pumpLabel, rackRanges, type CoolingLoop } from './topology';
import './simulation-view.css';

type Props = { snapshot: ObservedSnapshot; selected: string; onSelect: (id: string) => void; onSelectPump: (id: PumpId) => void; telemetry?: readonly TelemetryEvent[] };
type State = 'normal' | 'warm' | 'hot' | 'fault';
const RACKS = Array.from({ length: 8 }, (_, i) => i + 1);
const SLOTS = Array.from({ length: 8 }, (_, i) => i);
const stateOf = (gpu: GpuCurrent): State => gpu.availability !== 'ready' || gpu.last_xid_code !== null ? 'fault' : gpu.temp_c >= 85 ? 'hot' : gpu.temp_c >= 80 ? 'warm' : 'normal';
const stateText = (state: State) => state === 'fault' ? 'GPU unavailable' : state === 'hot' ? 'GPU slowing down' : state === 'warm' ? 'Getting warm' : 'Running normally';
const rackState = (gpus: GpuCurrent[]): State => gpus.some((g) => stateOf(g) === 'fault') ? 'fault' : gpus.some((g) => stateOf(g) === 'hot') ? 'hot' : gpus.some((g) => stateOf(g) === 'warm') ? 'warm' : 'normal';
/** Last-resort mapping when the snapshot carries no cooling topology at all (P1's preset always does). */
const FALLBACK_PUMP = (rack: number): PumpId => (rack >= 2 && rack <= 4 ? 'pump-a' : 'pump-b');

export function SimulationView({ snapshot, selected, onSelect, onSelectPump, telemetry }: Props) {
  const [chosenRack, setChosenRack] = useState<number | null>(null);
  const [selectedPump, setSelectedPump] = useState<PumpId | null>(null);
  const selectedRack = Number(/gpu-r(\d+)-/.exec(selected)?.[1]);
  const rack = chosenRack ?? (selectedRack >= 1 && selectedRack <= 8 ? selectedRack : 1);
  useEffect(() => { if (selectedRack >= 1 && selectedRack <= 8) { setChosenRack(selectedRack); setSelectedPump(null); } }, [selectedRack]);

  const gpuById = new Map(snapshot.gpus.map((gpu) => [gpu.resource_id, gpu]));
  const jobByGpu = new Map(snapshot.allocations.map((row) => [row.gpu_id, row.job_id]));
  const rackGpusOf = (n: number) => SLOTS.map((slot) => gpuById.get(`gpu-r${n}-n1-${slot}`));
  const present = (n: number) => rackGpusOf(n).filter((gpu): gpu is GpuCurrent => Boolean(gpu));
  const hottestOf = (n: number) => { const temps = present(n).map((gpu) => gpu.temp_c); return temps.length ? Math.max(...temps) : null; };

  const loops = coolingLoops(snapshot);
  const pumpOf = (n: number): PumpId => { const id = loopOfRack(loops, n)?.pumpId; return id && isPumpId(id) ? id : FALLBACK_PUMP(n); };
  const pumpRow = (id: string) => snapshot.cooling.find((row) => row.resource_id === id);
  const degraded = new Set(degradedPumps(snapshot).map((row) => row.resource_id));
  const pumpIds: PumpId[] = (loops.length ? loops.map((loop) => loop.pumpId) : ['pump-a', 'pump-b']).filter(isPumpId);
  const loopByPump = new Map(loops.map((loop) => [loop.pumpId, loop]));
  const firstRackOf = (pump: PumpId) => loopByPump.get(pump)?.racks[0] ?? (pump === 'pump-a' ? 2 : 1);

  // Baseline per rack: its hottest GPU reading while its pump was still normal this session. A later reading on a
  // degraded loop is compared against it; no baseline (page opened mid-fault) means no delta is shown.
  const baseline = useRef<{ runKey: string; simMs: number; temps: Map<number, number> }>({ runKey: '', simMs: -1, temps: new Map() });
  const runKey = snapshot.run_id;
  if (baseline.current.runKey !== runKey || snapshot.clock.sim_time_ms < baseline.current.simMs) baseline.current = { runKey, simMs: -1, temps: new Map() };
  baseline.current.simMs = snapshot.clock.sim_time_ms;
  for (const n of RACKS) { const t = hottestOf(n); if (t !== null && !degraded.has(pumpOf(n))) baseline.current.temps.set(n, t); }

  const focusedPump: PumpId = selectedPump ?? pumpOf(rack);
  const focusedLoop = loopByPump.get(focusedPump);
  const focusedDegraded = degraded.has(focusedPump);
  const rackGpus = rackGpusOf(rack);
  const selectedGpu = selectedRack === rack ? gpuById.get(selected) : undefined;
  const hot = snapshot.gpus.filter((gpu) => gpu.resource_id !== 'gpu-real-0' && stateOf(gpu) === 'hot').length;
  const failed = snapshot.gpus.filter((gpu) => gpu.resource_id !== 'gpu-real-0' && stateOf(gpu) === 'fault').length;
  const rackJobIds = [...new Set(rackGpus.flatMap((gpu) => gpu ? [jobByGpu.get(gpu.resource_id)].filter((id): id is string => Boolean(id)) : []))];
  const degradedNames = [...degraded].map(pumpLabel);

  const choosePump = (id: PumpId) => { setSelectedPump(id); const first = firstRackOf(id); setChosenRack(first); onSelectPump(id); onSelect(`gpu-r${first}-n1-0`); };
  const chooseRack = (n: number) => { const pump = pumpOf(n); setChosenRack(n); setSelectedPump(pump); onSelectPump(pump); onSelect(`gpu-r${n}-n1-0`); };

  /** What a rack on a degraded loop shows beside its label: a measured delta when one exists, otherwise nothing. */
  const degradedDelta = (n: number, loop: CoolingLoop | undefined): string | null => {
    const inlet = inletRiseC(n, loop, snapshot, telemetry);
    if (inlet !== null) return `inlet ${formatDeltaC(inlet)} vs nominal`;
    const before = baseline.current.temps.get(n); const nowT = hottestOf(n);
    if (before === undefined || nowT === null) return null;
    const delta = Math.round((nowT - before) * 10) / 10;
    return Math.abs(delta) >= 0.1 ? `${formatDeltaC(delta)} since fault` : null;
  };

  return <section className="sim-view" id="topology" aria-labelledby="sim-view-title">
    <header className="sim-view-header">
      <div className="sim-view-title"><Server size={20} aria-hidden="true"/><div><h2 id="sim-view-title">Explore the data center</h2><p>Follow the cooling system, choose a rack, then inspect a GPU.</p></div></div>
      <div className="sim-view-health" aria-live="polite">
        {degradedNames.length > 0 && <span className="sim-count-warning">{degradedNames.join(', ')} degraded</span>}
        <span className={hot || degradedNames.length ? 'sim-count-warning' : ''}>{hot} slowing down</span>
        <span className={failed ? 'sim-count-fault' : ''}>{failed} unavailable</span>
      </div>
    </header>
    <div className="sim-explore">
      <div className="sim-step"><span>1</span><div><strong>Cooling</strong><p>Each pump serves a group of racks.</p></div></div>
      <div className="sim-cooling" role="group" aria-label="Choose a cooling pump">{pumpIds.map((id) => {
        const pump = pumpRow(id); const isDegraded = degraded.has(id); const loop = loopByPump.get(id);
        return <button type="button" key={id} className={`sim-cooling-route ${isDegraded ? 'is-degraded' : ''} ${focusedPump === id ? 'is-selected' : ''}`} aria-pressed={focusedPump === id} onClick={() => choosePump(id)}>
          <Fan size={19} aria-hidden="true"/>
          <span className="sim-pump-copy"><strong>{pumpLabel(id)}</strong><span>Cools {loop ? rackRanges(loop.racks) : rackRanges(RACKS.filter((n) => pumpOf(n) === id))}</span></span>
          <b>{pump ? isDegraded ? `Needs attention · ${pump.operating_state}` : 'Working normally' : 'No reading'}</b>
        </button>;
      })}</div>
      <div className="sim-step"><span>2</span><div><strong>Choose a rack</strong><p>Start with an amber or red rack to investigate a problem.</p></div></div>
      <div className="sim-racks" role="group" aria-label="Choose one of eight data center racks">{RACKS.map((n) => {
        const gpus = rackGpusOf(n); const here = present(n); const hottest = hottestOf(n); const state = rackState(here);
        const pump = pumpOf(n); const loop = loopOfRack(loops, n); const onDegradedLoop = degraded.has(pump);
        const delta = onDegradedLoop ? degradedDelta(n, loop) : null;
        const ready = here.filter((gpu) => gpu.availability === 'ready').length;
        const label = `Rack ${n}, ${hottest === null ? 'no temperature' : `${number(hottest, 0)} degrees Celsius`}, ${stateText(state)}, ${ready} of 8 GPUs ready${onDegradedLoop ? `, on degraded ${pumpLabel(pump)} loop${delta ? `, ${delta}` : ''}` : ''}`;
        return <button type="button" key={n} className={`sim-rack sim-rack-${state} ${rack === n ? 'is-selected' : ''} ${pump === focusedPump ? 'is-on-route' : ''} ${onDegradedLoop ? 'is-on-degraded-loop' : ''}`} aria-label={label} aria-pressed={rack === n} onClick={() => chooseRack(n)}>
          <span className="sim-rack-top"><span className="sim-rack-name">Rack {n}</span><strong>{hottest === null ? '—' : `${number(hottest, 0)} °C`}</strong></span>
          <span className="sim-rack-cabinet" aria-hidden="true"><span className="sim-rack-rail"/><span className="sim-rack-modules">{gpus.map((gpu, slot) => <span key={slot} className={`sim-rack-module sim-rack-module-${gpu ? stateOf(gpu) : 'missing'}`}><i/><b/><em/></span>)}</span><span className="sim-rack-rail"/></span>
          <span className="sim-rack-bottom">
            {onDegradedLoop && <span className="sim-rack-loop-note">On degraded {pumpLabel(pump)}{delta ? <em>{delta}</em> : null}</span>}
            <span className="sim-rack-description">{stateText(state)}</span><span className="sim-rack-ready">{ready}/8 ready</span>
          </span>
        </button>;
      })}</div>
      {loops.length > 0 && <div className="sim-loop-band" aria-hidden="true">{loopSegments(loops).map((segment) => <span key={`${segment.pumpId}-${segment.start}`} className={`sim-loop-segment ${degraded.has(segment.pumpId) ? 'is-degraded' : ''}`} style={{ gridColumn: `${segment.start} / ${segment.end + 1}` }}><i/><span>{pumpLabel(segment.pumpId)} loop{degraded.has(segment.pumpId) ? ' · degraded' : ''}</span></span>)}</div>}
      <div className={`sim-impact ${focusedDegraded ? 'is-degraded' : ''}`} aria-live="polite">
        <strong>{pumpLabel(focusedPump)} → rack {rack} → {rackJobIds.length ? rackJobIds.join(', ') : 'no training job'}</strong>
        <span>{focusedDegraded ? `${pumpLabel(focusedPump)} is ${pumpRow(focusedPump)?.operating_state ?? 'degraded'}: ${focusedLoop ? rackRanges(focusedLoop.racks) : 'its racks'} share this coolant. Inspect the rack and its jobs.` : 'Cooling is operating normally for this rack.'} All values are simulated.</span>
      </div>
      <div className="sim-step"><span>3</span><div><strong>Inspect rack {rack}</strong><p>Choose one GPU to see its readings and assigned job.</p></div></div>
      <div className="sim-detail">
        <div className="sim-gpu-list" role="group" aria-label={`GPUs in rack ${rack}`}>{rackGpus.map((gpu, slot) => {
          const id = `gpu-r${rack}-n1-${slot}`;
          if (!gpu) return <span className="sim-gpu sim-gpu-missing" key={id}>GPU {slot}<small>No data</small></span>;
          const state = stateOf(gpu); const isSelected = selectedGpu?.resource_id === id;
          return <button type="button" key={id} data-gpu={id} className={`sim-gpu sim-gpu-${state} ${isSelected ? 'is-selected' : ''}`} aria-label={`GPU ${slot}, ${number(gpu.temp_c, 1)} degrees Celsius, ${gpu.availability}${gpu.last_xid_code ? `, XID ${gpu.last_xid_code}` : ''}, ${jobByGpu.get(id) ?? 'free'}`} aria-pressed={isSelected} onClick={() => onSelect(id)}>
            <span className="sim-gpu-card" aria-hidden="true"><span className="sim-gpu-connector"/><span className="sim-gpu-board"><span className="sim-gpu-fan"/><span className="sim-gpu-vents"/><span className="sim-gpu-led"/></span></span>
            <span className="sim-gpu-caption"><span>GPU {slot}<small>{state === 'fault' ? 'Unavailable' : jobByGpu.get(id) ?? 'Free'}</small></span><strong>{number(gpu.temp_c, 0)} °C</strong></span>
          </button>;
        })}</div>
        <div className="sim-inspector" aria-live="polite">
          <div className="sim-inspector-heading"><Activity size={17} aria-hidden="true"/><strong>{selectedGpu ? `GPU ${selectedGpu.resource_id.split('-').at(-1)}` : 'Select a GPU'}</strong></div>
          {selectedGpu ? <>
            <p>{stateText(stateOf(selectedGpu))}{selectedGpu.last_xid_code !== null ? ` · XID ${selectedGpu.last_xid_code}` : ''}</p>
            <dl><div><dt>Temperature</dt><dd>{number(selectedGpu.temp_c, 1)} °C</dd></div><div><dt>Clock speed</dt><dd>{number(selectedGpu.sm_clock_mhz)} MHz</dd></div><div><dt>Power</dt><dd>{number(selectedGpu.power_w)} W</dd></div><div><dt>Training job</dt><dd>{jobByGpu.get(selectedGpu.resource_id) ?? 'None'}</dd></div></dl>
          </> : <p>Click one of the eight GPUs on the left to inspect it.</p>}
        </div>
      </div>
    </div>
  </section>;
}

/** Contiguous runs of racks (1–8) that share a pump, for the band drawn under the cabinets. */
export function loopSegments(loops: CoolingLoop[]): Array<{ pumpId: string; start: number; end: number }> {
  const out: Array<{ pumpId: string; start: number; end: number }> = [];
  for (const n of RACKS) {
    const pumpId = loopOfRack(loops, n)?.pumpId;
    if (!pumpId) continue;
    const last = out.at(-1);
    if (last && last.pumpId === pumpId && last.end === n - 1) last.end = n; else out.push({ pumpId, start: n, end: n });
  }
  return out;
}
