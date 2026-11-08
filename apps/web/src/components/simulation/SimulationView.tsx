import { useEffect, useRef, useState } from 'react';
import { Activity, Fan, X } from 'lucide-react';
import type { GpuCurrent, ObservedSnapshot, TelemetryEvent } from '@dcos/contracts';
import type { ActionDetail } from '@dcos/db-client';
import { number } from '../../lib/utils';
import { Badge } from '../ui/panel';
import type { PumpId } from '../controls/fault-form';
import {
  capacityLoss, coolingLoops, degradedPumps, detectMoves, formatDeltaC, inletRiseC, isPumpId, jobRacks, loopOfRack, loopPath,
  moveArcPath, pumpLabel, rackAnchor, rackColumnsFor, rackRanges, type CoolingLoop, type JobMove, type RackGridGeometry,
} from './topology';
import './simulation-view.css';

type Props = {
  snapshot: ObservedSnapshot; selected: string; onSelect: (id: string) => void; onSelectPump: (id: PumpId) => void;
  telemetry?: readonly TelemetryEvent[];
  /** Typed ledger projection: a job with an active `migrate_restart` is marked "moving" on its racks. */
  actionDetails?: ActionDetail[];
};
type State = 'normal' | 'warm' | 'hot' | 'fault';
const RACKS = Array.from({ length: 8 }, (_, i) => i + 1);
const SLOTS = Array.from({ length: 8 }, (_, i) => i);
/** Mirrors `--sim-rack-gap` and the band height in simulation-view.css. */
const RACK_GAP = 8; const BAND_HEIGHT = 46; const LANE_Y: Record<string, number> = { 'pump-a': 14, 'pump-b': 32 };
const FAIL_MS = 1500; const MOVE_MS = 1600;
const ACTIVE = new Set(['requested', 'claimed', 'running']);
export const stateOf = (gpu: GpuCurrent): State => gpu.availability !== 'ready' || gpu.last_xid_code !== null ? 'fault' : gpu.temp_c >= 85 ? 'hot' : gpu.temp_c >= 80 ? 'warm' : 'normal';
const isThrottled = (gpu: GpuCurrent) => (gpu.clocks_event_reasons & 0x20) !== 0;
const stateText = (state: State) => state === 'fault' ? 'GPU unavailable' : state === 'hot' ? 'GPU slowing down' : state === 'warm' ? 'Getting warm' : 'Running normally';
const rackState = (gpus: GpuCurrent[]): State => gpus.some((g) => stateOf(g) === 'fault') ? 'fault' : gpus.some((g) => stateOf(g) === 'hot') ? 'hot' : gpus.some((g) => stateOf(g) === 'warm') ? 'warm' : 'normal';
/** Last-resort mapping when the snapshot carries no cooling topology at all (P1's preset always does). */
const FALLBACK_PUMP = (rack: number): PumpId => (rack >= 2 && rack <= 4 ? 'pump-a' : 'pump-b');
const jobClass = (jobId: string | undefined) => (jobId ? `has-job job-${jobId.replace(/^job-/, '')}` : '');
const rackOfGpu = (id: string) => Number(/gpu-r(\d+)-/.exec(id)?.[1]);
const loopClass = (pumpId: string) => `sim-loop-${pumpId.replace('pump-', '')}`;

export function SimulationView({ snapshot, selected, onSelect, onSelectPump, telemetry, actionDetails = [] }: Props) {
  const [chosenRack, setChosenRack] = useState<number | null>(null);
  const [selectedPump, setSelectedPump] = useState<PumpId | null>(null);
  const selectedRack = rackOfGpu(selected);
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
  const racksOfPump = (id: PumpId) => loopByPump.get(id)?.racks ?? RACKS.filter((n) => pumpOf(n) === id);
  const firstRackOf = (pump: PumpId) => racksOfPump(pump)[0] ?? (pump === 'pump-a' ? 2 : 1);
  const lossText = (id: string) => { const loss = capacityLoss(pumpRow(id)); return loss === null ? null : `−${Math.round(loss * 100)} % capacity`; };
  const movingJobs = new Set(actionDetails.filter((d) => d.command.operation === 'migrate_restart' && ACTIVE.has(d.status.status) && d.command.job_id).map((d) => d.command.job_id as string));

  // Baseline per rack: its hottest GPU reading while its pump was still normal this session. A later reading on a
  // degraded loop is compared against it; no baseline (page opened mid-fault) means no delta is shown.
  const baseline = useRef<{ runKey: string; simMs: number; temps: Map<number, number> }>({ runKey: '', simMs: -1, temps: new Map() });
  const runKey = snapshot.run_id;
  if (baseline.current.runKey !== runKey || snapshot.clock.sim_time_ms < baseline.current.simMs) baseline.current = { runKey, simMs: -1, temps: new Map() };
  baseline.current.simMs = snapshot.clock.sim_time_ms;
  for (const n of RACKS) { const t = hottestOf(n); if (t !== null && !degraded.has(pumpOf(n))) baseline.current.temps.set(n, t); }

  // Geometry of the rack field, measured once per resize, drives the SVG overlay (coolant loops, move arcs).
  const rootRef = useRef<HTMLElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = fieldRef.current; if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => { const r = entries[0]?.contentRect; if (r) setSize((s) => (s.width === r.width && s.height === r.height ? s : { width: r.width, height: r.height })); });
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const cols = rackColumnsFor(size.width);
  const band = cols === 8 ? BAND_HEIGHT : 0;
  const geometry: RackGridGeometry = { width: size.width, height: size.height + band, cols, gap: RACK_GAP, bandHeight: band };

  // XID failure flourish: only on a transition of real store data, never on first paint, never across a run reset.
  const prevStates = useRef<{ runKey: string; states: Map<string, State> } | null>(null);
  useEffect(() => {
    const states = new Map(snapshot.gpus.map((gpu) => [gpu.resource_id, stateOf(gpu)]));
    const prev = prevStates.current; prevStates.current = { runKey: snapshot.run_id, states };
    const root = rootRef.current;
    if (!prev || prev.runKey !== snapshot.run_id || !root) return;
    for (const [id, state] of states) {
      const before = prev.states.get(id);
      if (state !== 'fault' || before === undefined || before === 'fault') continue;
      const tiles = root.querySelectorAll(`[data-sim-gpu="${id}"]`);
      const rackEl = root.querySelector(`[data-sim-rack="${rackOfGpu(id)}"]`);
      tiles.forEach((tile) => tile.classList.add('is-failing')); rackEl?.classList.add('is-rippling');
      window.setTimeout(() => { tiles.forEach((tile) => tile.classList.remove('is-failing')); rackEl?.classList.remove('is-rippling'); }, FAIL_MS);
    }
  }, [snapshot]);

  // Job moves: rack set changed between consecutive snapshots → one arc from the old racks to the new ones.
  const prevRacks = useRef<{ runKey: string; racks: Record<string, number[]> } | null>(null);
  const [arcs, setArcs] = useState<Array<{ key: string; move: JobMove }>>([]);
  useEffect(() => {
    const racks = jobRacks(snapshot.allocations);
    const prev = prevRacks.current; prevRacks.current = { runKey: snapshot.run_id, racks };
    if (!prev || prev.runKey !== snapshot.run_id) return;
    const moves = detectMoves(prev.racks, racks);
    if (moves.length === 0) return;
    const stamped = moves.map((move) => ({ key: `${move.jobId}-${snapshot.clock.sim_time_ms}`, move }));
    setArcs((current) => [...current, ...stamped]);
    const landing = moves.map((move) => rootRef.current?.querySelector(`[data-sim-rack="${move.to[0]}"]`) ?? null);
    landing.forEach((el) => el?.classList.add('is-landing'));
    window.setTimeout(() => { setArcs((current) => current.filter((arc) => !stamped.includes(arc))); landing.forEach((el) => el?.classList.remove('is-landing')); }, MOVE_MS);
  }, [snapshot]);

  const focusedPump: PumpId = selectedPump ?? pumpOf(rack);
  const rackGpus = rackGpusOf(rack);
  const selectedGpu = selectedRack === rack ? gpuById.get(selected) : undefined;
  const simGpus = snapshot.gpus.filter((gpu) => gpu.resource_id !== 'gpu-real-0');
  const ready = simGpus.filter((gpu) => stateOf(gpu) !== 'fault').length;

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

  const tempText = (gpu: GpuCurrent) => `${number(gpu.temp_c, 1)} °C`;
  const tileTitle = (gpu: GpuCurrent, id: string) => `${id} · ${tempText(gpu)} · ${stateText(stateOf(gpu))}${gpu.last_xid_code !== null ? ` · XID ${gpu.last_xid_code}` : ''}${isThrottled(gpu) ? ' · thermal throttle' : ''} · ${jobByGpu.get(id) ?? 'free'}`;
  const selectedRackPump = pumpOf(rack);
  const selectedRackDelta = degraded.has(selectedRackPump) ? degradedDelta(rack, loopOfRack(loops, rack)) : null;

  return <section className="sim-view" id="topology" aria-labelledby="sim-view-title" ref={rootRef}>
    <header className="sim-view-header">
      <div className="sim-view-title"><h2 id="sim-view-title">Simulated cluster</h2><Badge tone="simulated">Simulated</Badge><span className="sim-ready" title={`${ready} of ${simGpus.length} simulated GPUs are ready`}>{ready} of {simGpus.length || 64} GPUs ready</span></div>
      <div className="sim-legend" aria-label="Legend">
        <span><i className="sim-key sim-key-normal"/>cool</span><span><i className="sim-key sim-key-warm"/>warm</span><span><i className="sim-key sim-key-hot"/>hot</span><span><i className="sim-key sim-key-fault"><X size={9} aria-hidden="true"/></i>failed</span><span><i className="sim-key-line"/>coolant</span><span><i className="sim-key-line is-degraded"/>loop failing</span>
      </div>
    </header>
    <div className="sim-explore">
      <div className="sim-cooling" role="group" aria-label="Choose a cooling pump">{pumpIds.map((id) => {
        const pump = pumpRow(id); const isDegraded = degraded.has(id); const loss = lossText(id); const racks = rackRanges(racksOfPump(id));
        const detail = pump ? isDegraded ? `${pump.operating_state}${loss ? ` · ${loss}` : ''}` : 'normal' : 'no reading';
        return <button type="button" key={id} className={`sim-cooling-route ${loopClass(id)} ${isDegraded ? 'is-degraded' : ''} ${focusedPump === id ? 'is-selected' : ''}`} aria-pressed={focusedPump === id} aria-label={`${pumpLabel(id)} Cools ${racks} · ${isDegraded ? `failing · ${detail}` : detail}`} title={`${pumpLabel(id)} · ${racks} · ${detail}`} onClick={() => choosePump(id)}>
          <Fan size={18} aria-hidden="true" className="sim-fan"/>
          <span className="sim-pump-copy" aria-hidden="true"><strong>{pumpLabel(id)}</strong><span>{racks}</span></span>
          <b aria-hidden="true">{pump ? isDegraded ? `failing${loss ? ` · ${loss}` : ''}` : 'normal' : 'no reading'}</b>
        </button>;
      })}</div>

      <div className="sim-rack-field" ref={fieldRef}>
        <div className="sim-racks" role="group" aria-label="Choose one of eight data center racks">{RACKS.map((n) => {
          const gpus = rackGpusOf(n); const here = present(n); const hottest = hottestOf(n); const state = rackState(here);
          const pump = pumpOf(n); const loop = loopOfRack(loops, n); const onDegradedLoop = degraded.has(pump);
          const delta = onDegradedLoop ? degradedDelta(n, loop) : null;
          const readyHere = here.filter((gpu) => gpu.availability === 'ready').length;
          const rackJobs = [...new Set(here.map((gpu) => jobByGpu.get(gpu.resource_id)).filter((id): id is string => Boolean(id)))];
          const moving = rackJobs.filter((id) => movingJobs.has(id));
          const temp = hottest === null ? 'no temperature' : `${number(hottest, 0)} degrees Celsius`;
          const label = `Rack ${n}, ${temp}, ${stateText(state)}, ${readyHere} of 8 GPUs ready${rackJobs.length ? `, ${rackJobs.join(' and ')}` : ''}${onDegradedLoop ? `, on degraded ${pumpLabel(pump)} loop${delta ? `, ${delta}` : ''}` : ''}${moving.length ? `, ${moving.join(', ')} moving` : ''}`;
          return <button type="button" key={n} data-sim-rack={n} className={`sim-rack sim-rack-${state} ${loopClass(pump)} ${rack === n ? 'is-selected' : ''} ${pump === focusedPump ? 'is-on-route' : ''} ${onDegradedLoop ? 'is-on-degraded-loop' : ''}`} aria-label={label} title={label} aria-pressed={rack === n} onClick={() => chooseRack(n)}>
            <span className="sim-rack-top" aria-hidden="true"><span className="sim-rack-name">R{n}</span>{moving.length > 0 ? <span className="sim-rack-flag">moving</span> : <span className="sim-rack-temp">{hottest === null ? '—' : `${number(hottest, 0)}°`}</span>}</span>
            <span className="sim-rack-tiles" aria-hidden="true">{gpus.map((gpu, slot) => {
              const id = `gpu-r${n}-n1-${slot}`;
              if (!gpu) return <span key={slot} className="sim-tile sim-tile-missing"/>;
              const s = stateOf(gpu);
              return <span key={slot} data-sim-gpu={id} title={tileTitle(gpu, id)} className={`sim-tile sim-tile-${s} ${jobClass(jobByGpu.get(id))} ${isThrottled(gpu) || s === 'hot' ? 'is-throttled' : ''} ${selected === id ? 'is-selected' : ''}`}>{s === 'fault' ? <X size={10} aria-hidden="true"/> : null}</span>;
            })}</span>
          </button>;
        })}</div>
        {size.width > 0 && <svg className="sim-overlay" aria-hidden="true" width={size.width} height={size.height + band} viewBox={`0 0 ${size.width} ${size.height + band}`}>
          {cols === 8 && loops.map((loop) => <path key={loop.loopId} className={`sim-loop-path ${loopClass(loop.pumpId)} ${degraded.has(loop.pumpId) ? 'is-degraded' : ''}`} d={loopPath(loop.racks, LANE_Y[loop.pumpId] ?? 24, geometry)}/>)}
          {arcs.map(({ key, move }) => <path key={key} className={`sim-move-arc ${jobClass(move.jobId)}`} d={moveArcPath(move, geometry)}/>)}
          {arcs.map(({ key, move }) => { const to = rackAnchor(move.to[0]!, geometry); return <circle key={`${key}-dot`} className={`sim-move-dot ${jobClass(move.jobId)}`} cx={to.x} cy={to.top + 6} r={5}/>; })}
        </svg>}
        {cols === 8 && size.width > 0 && loops.map((loop) => {
          const racks = loop.racks; if (!racks.length) return null;
          const mid = (rackAnchor(racks[0]!, geometry).x + rackAnchor(racks.at(-1)!, geometry).x) / 2;
          const isDegraded = degraded.has(loop.pumpId);
          return <span key={loop.loopId} className={`sim-loop-chip ${loopClass(loop.pumpId)} ${isDegraded ? 'is-degraded' : ''}`} style={{ left: mid, top: size.height + (LANE_Y[loop.pumpId] ?? 24) }} title={`${pumpLabel(loop.pumpId)} loop${isDegraded ? ` · degraded${lossText(loop.pumpId) ? ` · ${lossText(loop.pumpId)}` : ''}` : ''}`} aria-hidden="true">{pumpLabel(loop.pumpId)}{isDegraded ? ' · failing' : ''}</span>;
        })}
      </div>

      <div className="sim-detail">
        <div className="sim-gpu-list" role="group" aria-label={`GPUs in rack ${rack}`}>{rackGpus.map((gpu, slot) => {
          const id = `gpu-r${rack}-n1-${slot}`;
          if (!gpu) return <span className="sim-gpu sim-gpu-missing" key={id} title={`${id} · no data`}/>;
          const state = stateOf(gpu); const isSelected = selectedGpu?.resource_id === id; const job = jobByGpu.get(id);
          return <button type="button" key={id} data-gpu={id} data-sim-gpu={id} title={tileTitle(gpu, id)} className={`sim-gpu sim-gpu-${state} ${jobClass(job)} ${isThrottled(gpu) || state === 'hot' ? 'is-throttled' : ''} ${isSelected ? 'is-selected' : ''}`} aria-label={`GPU ${slot}, ${number(gpu.temp_c, 1)} degrees Celsius, ${gpu.availability}${gpu.last_xid_code ? `, XID ${gpu.last_xid_code}` : ''}, ${job ?? 'free'}`} aria-pressed={isSelected} onClick={() => onSelect(id)}>
            {state === 'fault' ? <X size={14} aria-hidden="true"/> : <span aria-hidden="true">{slot}</span>}
          </button>;
        })}</div>
        <div className="sim-inspector" aria-live="polite">
          <div className="sim-inspector-heading"><Activity size={16} aria-hidden="true"/><strong>{selectedGpu ? `GPU ${selectedGpu.resource_id.split('-').at(-1)} in rack ${rack}` : `Rack ${rack}`}</strong></div>
          {selectedGpu ? <>
            <p className={`sim-inspector-state is-${stateOf(selectedGpu)}`}>{stateText(stateOf(selectedGpu))}{selectedGpu.last_xid_code !== null ? ` · XID ${selectedGpu.last_xid_code}` : ''}{isThrottled(selectedGpu) ? ' · thermal throttle' : ''} · {tempText(selectedGpu)}</p>
            <p className="sim-inspector-job">{jobByGpu.get(selectedGpu.resource_id) ? `Running ${jobByGpu.get(selectedGpu.resource_id)}` : 'No training job'}{degraded.has(selectedRackPump) ? ` · on failing ${pumpLabel(selectedRackPump)} loop` : ''}</p>
            <details className="sim-inspector-more"><summary>Readings</summary>
              <dl><div><dt>GPU id</dt><dd>{selectedGpu.resource_id}</dd></div><div><dt>SM clock</dt><dd>{number(selectedGpu.sm_clock_mhz)} MHz</dd></div><div><dt>Power</dt><dd>{number(selectedGpu.power_w)} W</dd></div><div><dt>Rack {rack} ready</dt><dd>{present(rack).filter((g) => g.availability === 'ready').length} of 8</dd></div>{selectedRackDelta && <div><dt>Rack since fault</dt><dd>{selectedRackDelta.replace(/ since fault$/, '')}</dd></div>}{degraded.has(selectedRackPump) && <div><dt>{pumpLabel(selectedRackPump)}</dt><dd>{lossText(selectedRackPump) ?? pumpRow(selectedRackPump)?.operating_state ?? 'degraded'}</dd></div>}</dl>
            </details>
          </> : <p>Choose one of the eight GPUs in rack {rack} to inspect it.</p>}
        </div>
      </div>
    </div>
  </section>;
}

/** Contiguous runs of racks (1–8) that share a pump (kept for callers and tests that describe the loop band). */
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
