import { useEffect, useRef, useState } from 'react';
import { Activity, Fan } from 'lucide-react';
import type { GpuCurrent, ObservedSnapshot, TelemetryEvent } from '@dcos/contracts';
import type { ActionDetail } from '@dcos/db-client';
import type { DashboardState } from '../../data/dashboard';
import { number } from '../../lib/utils';
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
  /** Observed status history per job (from the dashboard store); shown as a transition count on the job legend. */
  history?: DashboardState['jobHistory'];
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

export function SimulationView({ snapshot, selected, onSelect, onSelectPump, telemetry, actionDetails = [], history = {} }: Props) {
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
  const lossOf = (id: string) => capacityLoss(pumpRow(id));
  const lossText = (id: string) => { const loss = lossOf(id); return loss === null ? null : `−${Math.round(loss * 100)} % capacity`; };
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
  const focusedLoop = loopByPump.get(focusedPump);
  const focusedDegraded = degraded.has(focusedPump);
  const rackGpus = rackGpusOf(rack);
  const selectedGpu = selectedRack === rack ? gpuById.get(selected) : undefined;
  const simGpus = snapshot.gpus.filter((gpu) => gpu.resource_id !== 'gpu-real-0');
  const ready = simGpus.filter((gpu) => stateOf(gpu) !== 'fault').length;
  const hot = simGpus.filter((gpu) => stateOf(gpu) === 'hot').length;
  const warm = simGpus.filter((gpu) => stateOf(gpu) === 'warm').length;
  const failed = simGpus.length - ready;
  const rackJobIds = [...new Set(rackGpus.flatMap((gpu) => gpu ? [jobByGpu.get(gpu.resource_id)].filter((id): id is string => Boolean(id)) : []))];
  const degradedNames = [...degraded].map(pumpLabel);
  const jobIds = snapshot.job_states.map((job) => job.job_id);

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

  const tileLabel = (gpu: GpuCurrent) => gpu.last_xid_code !== null ? `XID ${gpu.last_xid_code}` : stateOf(gpu) === 'fault' ? gpu.availability : `${number(gpu.temp_c, 0)}°`;

  return <section className="sim-view" id="topology" aria-labelledby="sim-view-title" ref={rootRef}>
    <header className="sim-view-header">
      <div className="sim-view-title"><span className="sim-eyebrow">Simulated cluster</span><h2 id="sim-view-title">8 racks · 64 GPUs · 2 coolant loops</h2></div>
      <div className="sim-view-health" aria-live="polite">
        <span className="sim-hero-stat"><strong>{ready}<small>/{simGpus.length || 64}</small></strong><span>GPUs ready</span></span>
        <span className="sim-health-row">
          {degradedNames.length > 0 && <span className="sim-count sim-count-warning">{degradedNames.join(', ')} degraded</span>}
          <span className={`sim-count ${hot ? 'sim-count-hot' : ''}`}>{hot} throttling</span>
          <span className={`sim-count ${warm ? 'sim-count-warning' : ''}`}>{warm} warm</span>
          <span className={`sim-count ${failed ? 'sim-count-fault' : ''}`}>{failed} unavailable</span>
        </span>
      </div>
    </header>
    <div className="sim-explore">
      <div className="sim-cooling" role="group" aria-label="Choose a cooling pump">{pumpIds.map((id) => {
        const pump = pumpRow(id); const isDegraded = degraded.has(id); const loss = lossText(id);
        return <button type="button" key={id} className={`sim-cooling-route sim-loop-${id.replace('pump-', '')} ${isDegraded ? 'is-degraded' : ''} ${focusedPump === id ? 'is-selected' : ''}`} aria-pressed={focusedPump === id} onClick={() => choosePump(id)}>
          <Fan size={18} aria-hidden="true" className="sim-fan"/>
          <span className="sim-pump-copy"><strong>{pumpLabel(id)}</strong><span>Cools {rackRanges(racksOfPump(id))}</span></span>
          <b>{pump ? isDegraded ? `${pump.operating_state}${loss ? ` · ${loss}` : ''}` : 'normal' : 'No reading'}</b>
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
          const label = `Rack ${n}, ${hottest === null ? 'no temperature' : `${number(hottest, 0)} degrees Celsius`}, ${stateText(state)}, ${readyHere} of 8 GPUs ready${rackJobs.length ? `, ${rackJobs.join(' and ')}` : ''}${onDegradedLoop ? `, on degraded ${pumpLabel(pump)} loop${delta ? `, ${delta}` : ''}` : ''}${moving.length ? `, ${moving.join(', ')} moving` : ''}`;
          return <button type="button" key={n} data-sim-rack={n} className={`sim-rack sim-rack-${state} sim-loop-${pump.replace('pump-', '')} ${rack === n ? 'is-selected' : ''} ${pump === focusedPump ? 'is-on-route' : ''} ${onDegradedLoop ? 'is-on-degraded-loop' : ''}`} aria-label={label} aria-pressed={rack === n} onClick={() => chooseRack(n)}>
            <span className="sim-rack-top" aria-hidden="true"><span className="sim-rack-name">R{n}</span><strong>{hottest === null ? '—' : `${number(hottest, 0)}°`}</strong></span>
            <span className="sim-rack-tiles" aria-hidden="true">{gpus.map((gpu, slot) => {
              const id = `gpu-r${n}-n1-${slot}`;
              if (!gpu) return <span key={slot} className="sim-tile sim-tile-missing">·</span>;
              const s = stateOf(gpu);
              return <span key={slot} data-sim-gpu={id} className={`sim-tile sim-tile-${s} ${jobClass(jobByGpu.get(id))} ${isThrottled(gpu) || s === 'hot' ? 'is-throttled' : ''} ${selected === id ? 'is-selected' : ''}`}>{s === 'fault' ? '✕' : number(gpu.temp_c, 0)}</span>;
            })}</span>
            <span className="sim-rack-bottom" aria-hidden="true">
              {onDegradedLoop ? <span className="sim-rack-loop-note">On degraded {pumpLabel(pump)}{delta ? <em>{delta}</em> : null}</span> : <span className="sim-rack-description">{stateText(state)}</span>}
              <span className="sim-rack-ready">{readyHere}/8 ready{moving.length ? ` · ${moving.join(', ')} moving` : ''}</span>
            </span>
          </button>;
        })}</div>
        {size.width > 0 && <svg className="sim-overlay" aria-hidden="true" width={size.width} height={size.height + band} viewBox={`0 0 ${size.width} ${size.height + band}`}>
          {cols === 8 && loops.map((loop) => <path key={loop.loopId} className={`sim-loop-path sim-loop-${loop.pumpId.replace('pump-', '')} ${degraded.has(loop.pumpId) ? 'is-degraded' : ''}`} d={loopPath(loop.racks, LANE_Y[loop.pumpId] ?? 24, geometry)}/>)}
          {arcs.map(({ key, move }) => <path key={key} className={`sim-move-arc ${jobClass(move.jobId)}`} d={moveArcPath(move, geometry)}/>)}
          {arcs.map(({ key, move }) => { const to = rackAnchor(move.to[0]!, geometry); return <circle key={`${key}-dot`} className={`sim-move-dot ${jobClass(move.jobId)}`} cx={to.x} cy={to.top + 6} r={5}/>; })}
        </svg>}
        {cols === 8 && size.width > 0 && loops.map((loop) => {
          const racks = loop.racks; if (!racks.length) return null;
          const mid = (rackAnchor(racks[0]!, geometry).x + rackAnchor(racks.at(-1)!, geometry).x) / 2;
          const isDegraded = degraded.has(loop.pumpId); const loss = lossText(loop.pumpId);
          return <span key={loop.loopId} className={`sim-loop-chip sim-loop-${loop.pumpId.replace('pump-', '')} ${isDegraded ? 'is-degraded' : ''}`} style={{ left: mid, top: size.height + (LANE_Y[loop.pumpId] ?? 24) }} aria-hidden="true">{pumpLabel(loop.pumpId)} loop{isDegraded ? ` · degraded${loss ? ` · ${loss}` : ''}` : ''}</span>;
        })}
      </div>

      <div className={`sim-impact ${focusedDegraded ? 'is-degraded' : ''}`} aria-live="polite">
        <strong>{pumpLabel(focusedPump)} → rack {rack} → {rackJobIds.length ? rackJobIds.join(', ') : 'no training job'}</strong>
        <span>{focusedDegraded ? `${pumpLabel(focusedPump)} is ${pumpRow(focusedPump)?.operating_state ?? 'degraded'}${lossText(focusedPump) ? ` (${lossText(focusedPump)})` : ''}: ${focusedLoop ? rackRanges(focusedLoop.racks) : 'its racks'} share this coolant.` : 'Cooling is operating normally for this rack.'} All values are simulated.</span>
      </div>

      <div className="sim-legend" aria-label="Legend">
        <span><i className="sim-key sim-key-normal"/>&lt; 80 °C</span><span><i className="sim-key sim-key-warm"/>80–84 °C</span><span><i className="sim-key sim-key-hot"/>≥ 85 °C · throttling</span><span><i className="sim-key sim-key-fault">✕</i>failed / XID</span>
        <span><i className="sim-key-line sim-loop-a"/>loop A</span><span><i className="sim-key-line sim-loop-b"/>loop B</span><span><i className="sim-key-line is-degraded"/>degraded</span>
        {jobIds.map((id) => <span key={id} className={jobClass(id)}><i className="sim-key-job"/>{id}{(history[id]?.length ?? 0) > 1 ? <small> · {history[id]!.length - 1} status changes</small> : null}</span>)}
      </div>

      <div className="sim-detail">
        <div className="sim-gpu-list" role="group" aria-label={`GPUs in rack ${rack}`}>{rackGpus.map((gpu, slot) => {
          const id = `gpu-r${rack}-n1-${slot}`;
          if (!gpu) return <span className="sim-gpu sim-gpu-missing" key={id}><small>GPU {slot}</small>no data</span>;
          const state = stateOf(gpu); const isSelected = selectedGpu?.resource_id === id; const job = jobByGpu.get(id);
          return <button type="button" key={id} data-gpu={id} data-sim-gpu={id} className={`sim-gpu sim-gpu-${state} ${jobClass(job)} ${isThrottled(gpu) || state === 'hot' ? 'is-throttled' : ''} ${isSelected ? 'is-selected' : ''}`} aria-label={`GPU ${slot}, ${number(gpu.temp_c, 1)} degrees Celsius, ${gpu.availability}${gpu.last_xid_code ? `, XID ${gpu.last_xid_code}` : ''}, ${job ?? 'free'}`} aria-pressed={isSelected} onClick={() => onSelect(id)}>
            <small aria-hidden="true">{slot}</small>
            <strong aria-hidden="true">{state === 'fault' ? '✕' : number(gpu.temp_c, 0)}</strong>
            <span aria-hidden="true">{tileLabel(gpu)}</span>
          </button>;
        })}</div>
        <div className="sim-inspector" aria-live="polite">
          <div className="sim-inspector-heading"><Activity size={16} aria-hidden="true"/><strong>{selectedGpu ? selectedGpu.resource_id : 'Select a GPU'}</strong></div>
          {selectedGpu ? <>
            <p className={`sim-inspector-state is-${stateOf(selectedGpu)}`}>{stateText(stateOf(selectedGpu))}{selectedGpu.last_xid_code !== null ? ` · XID ${selectedGpu.last_xid_code}` : ''}{isThrottled(selectedGpu) ? ' · thermal throttle' : ''}</p>
            <dl><div><dt>Temperature</dt><dd>{number(selectedGpu.temp_c, 1)} °C</dd></div><div><dt>SM clock</dt><dd>{number(selectedGpu.sm_clock_mhz)} MHz</dd></div><div><dt>Power</dt><dd>{number(selectedGpu.power_w)} W</dd></div><div><dt>Training job</dt><dd>{jobByGpu.get(selectedGpu.resource_id) ?? 'None'}</dd></div></dl>
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
