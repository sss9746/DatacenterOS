import { useEffect, useState, type KeyboardEvent } from 'react';
import { ArrowUpRight, Pause, Play, RefreshCw, AlertTriangle } from 'lucide-react';
import { useDashboard } from '../data/use-dashboard';
import { asMock, errorMessage, type Preview } from '../data/dashboard';
import type { ObservedSnapshot } from '@dcos/contracts';
import { Header } from '../components/header/Header';
import { SimulationView } from '../components/simulation/SimulationView';
import { ModelAssumptions } from '../components/simulation/ModelAssumptions';
import { coolingLoops, degradedPumps, isPumpId, loopOfRack, pumpLabel, rackRanges } from '../components/simulation/topology';
import { RealGpu } from '../components/heatmap/RealGpu';
import { Jobs } from '../components/jobs/Jobs';
import { Cooling } from '../components/cooling/Cooling';
import { Incidents } from '../components/incidents/Incidents';
import { Feed } from '../components/feed/Feed';
import { WorkflowBoard } from '../components/workflows/WorkflowBoard';
import { Ledger } from '../components/ledger/Ledger';
import { DEFAULT_XID_GPU_ID, type PumpId } from '../components/controls/fault-form';
import { Scoreboard } from '../components/scoreboard/Scoreboard';
import { AgentRoom } from '../components/agent-room/AgentRoom';
import { DemoControls } from '../components/controls/DemoControls';
import { loadRealBatch, loadRehearsalBatch } from '../data/rehearsal-batch';
import { Badge } from '../components/ui/panel';
import { Button } from '../components/ui/button';
import { duration } from '../lib/utils';

/** `?presenter=1` opens the demo-controls bar on load; judges' default view keeps it collapsed under the story. */
const presenterRequested = () => { try { return new URLSearchParams(window.location.search).get('presenter') === '1'; } catch { return false; } };

/** Details tabs. Every panel stays in the DOM (hidden when inactive) so `#jobs`, `#ledger`, `#activity`, `#scoreboard`, `#real-gpu` keep working. */
const TABS = [
  { id: 'jobs', label: 'Jobs' }, { id: 'ledger', label: 'Ledger' }, { id: 'activity', label: 'Full log' },
  { id: 'scoreboard', label: 'Scoreboard' }, { id: 'real-gpu', label: 'Real GPU' }, { id: 'model', label: 'Model' },
] as const;
type TabId = (typeof TABS)[number]['id'];
const isTabId = (value: string): value is TabId => TABS.some((tab) => tab.id === value);
/** Anchor ids that live inside a tab; targeting one (hash or `data-tab-target`) opens that tab. */
const TAB_OF_TARGET: Record<string, TabId> = { jobs: 'jobs', 'fault-controls': 'jobs', ledger: 'ledger', activity: 'activity', scoreboard: 'scoreboard', 'real-gpu': 'real-gpu', model: 'model', 'model-assumptions': 'model', signals: 'model', details: 'jobs' };
const tabForHash = (hash: string): TabId | null => { const id = hash.replace(/^#/, ''); return isTabId(id) ? id : TAB_OF_TARGET[id] ?? null; };

/** One plain sentence about the cluster, derived only from the snapshot. */
export function situation(snapshot: ObservedSnapshot): string {
  const gpus = snapshot.gpus.filter((gpu) => gpu.resource_id !== 'gpu-real-0');
  const failed = gpus.filter((gpu) => gpu.availability !== 'ready' || gpu.last_xid_code !== null).length;
  const throttled = gpus.filter((gpu) => (gpu.clocks_event_reasons & 0x20) !== 0 || gpu.temp_c >= 85).length;
  const warm = gpus.filter((gpu) => gpu.temp_c >= 80).length;
  const moving = snapshot.job_states.filter((job) => job.status === 'restarting').length;
  const stopped = snapshot.job_states.filter((job) => job.status === 'failed' || job.status === 'paused').length;
  const loops = coolingLoops(snapshot);
  const degraded = degradedPumps(snapshot);
  const parts: string[] = [];
  for (const pump of degraded) {
    const racks = loops.find((loop) => loop.pumpId === pump.resource_id)?.racks ?? [];
    parts.push(`${pumpLabel(pump.resource_id)} is failing${racks.length ? ` — ${rackRanges(racks)} ${warm ? 'heating' : 'losing cooling'}` : ''}`);
  }
  if (failed) parts.push(`${failed} GPU${failed === 1 ? '' : 's'} failed${moving ? ` — ${moving === 1 ? 'its job is' : `${moving} jobs are`} being moved` : stopped ? ` — ${stopped} job${stopped === 1 ? '' : 's'} stopped` : ''}`);
  if (!degraded.length && throttled) parts.push(`${throttled} GPU${throttled === 1 ? '' : 's'} slowing down from heat`);
  if (parts.length === 0) return `All ${gpus.length} GPUs healthy`;
  return parts.join('. ');
}

export function App() {
  const [preview, setPreview] = useState<Preview>('physics');
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState(DEFAULT_XID_GPU_ID);
  const [selectedPumpId, setSelectedPumpId] = useState<PumpId>('pump-a');
  const [speed, setSpeed] = useState(1);
  const [now, setNow] = useState(Date.now());
  const [presenterOpen] = useState(presenterRequested);
  const [controlError, setControlError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [tab, setTab] = useState<TabId>(() => { try { return tabForHash(window.location.hash) ?? 'jobs'; } catch { return 'jobs'; } });
  const { state, store, error, mode, dbName, canAdmin } = useDashboard(preview, revision);
  const snapshot = state.snapshot;
  const localPhysics = mode === 'mock' && preview === 'physics';
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const mock = store ? asMock(store.client) : null;
    if (!mock) return;
    const timer = setInterval(() => mock.tick(), 1000 / speed);
    return () => clearInterval(timer);
  }, [store, speed]);
  useEffect(() => { setSpeed(1); setControlError(null); }, [preview, revision]);
  // Open the right tab when a section inside it is targeted: `#ledger` in the URL, or a click on `[data-tab-target="ledger"]`.
  useEffect(() => {
    const onHash = () => { const next = tabForHash(window.location.hash); if (next) setTab(next); };
    const onClick = (event: MouseEvent) => { const el = (event.target as Element | null)?.closest<HTMLElement>('[data-tab-target]'); const next = el?.dataset.tabTarget; if (next && isTabId(next)) setTab(next); };
    window.addEventListener('hashchange', onHash); document.addEventListener('click', onClick);
    return () => { window.removeEventListener('hashchange', onHash); document.removeEventListener('click', onClick); };
  }, []);
  async function changeRun(action: 'pause' | 'speed', nextSpeed = speed) {
    if (!store || !snapshot || !canAdmin || pending) return;
    setPending(true); setControlError(null);
    try {
      if (action === 'pause') await store.client.pauseRun(snapshot.run_id, !snapshot.clock.paused);
      else { await store.client.configureRun(snapshot.run_id, { speed: nextSpeed }); setSpeed(nextSpeed); }
      await store.refresh();
    } catch (reason) { setControlError(errorMessage(reason)); }
    finally { setPending(false); }
  }
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((item) => item.id === tab);
    const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' ? (index - 1 + TABS.length) % TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); setTab(TABS[next]!.id);
    document.getElementById(`tab-${TABS[next]!.id}`)?.focus();
  };
  const stale = state.lastReceived !== null && !snapshot?.clock.paused && now - state.lastReceived > 5000;
  // The pump that cools a rack comes from the snapshot's cooling loops; the fixed split is only for snapshots without one.
  const pumpOfRack = (rack: number): PumpId => { const id = snapshot ? loopOfRack(coolingLoops(snapshot), rack)?.pumpId : undefined; return id && isPumpId(id) ? id : rack >= 2 && rack <= 4 ? 'pump-a' : 'pump-b'; };
  const selectGpu = (id: string) => { setSelected(id); const rack = Number(/gpu-r(\d+)-/.exec(id)?.[1]); if (rack >= 1 && rack <= 8) setSelectedPumpId(pumpOfRack(rack)); };
  const example = mode === 'mock' && preview === 'recovery';
  const runWorkflows = snapshot ? state.workflows.filter((row) => row.run_id === snapshot.run_id) : [];
  const runPlans = snapshot ? state.plans.filter((row) => row.run_id === snapshot.run_id) : [];
  const runViewSelect = mode === 'mock' ? <label className="inline-select"><span className="sr-only">Run view</span><select aria-label="Run view" value={preview} onChange={(event) => { setPreview(event.target.value as Preview); }}><option value="physics">Local physics simulation</option><option value="demo">Healthy fixture</option><option value="pump_degraded">Cooling fault</option><option value="recovery">Recovery example</option></select></label> : null;
  return <><a className="skip-link" href="#overview">Skip to cluster overview</a><Header mode={mode} localPhysics={localPhysics} dbName={dbName}>{runViewSelect}</Header><main id="main" className="main">
    <div className="page-title">
      <div><h1>Cluster operations</h1><p className="situation">{snapshot ? situation(snapshot) : error ? 'No data yet.' : 'Connecting…'}</p></div>
      <div className="title-controls">
        {(error || stale) && <span className="connection connection-error"><i/>{error ? 'Connection error' : 'Stale data'}</span>}
        <span className="sim-clock"><span className="sr-only">Sim time </span><strong data-testid="sim-clock">{snapshot ? duration(snapshot.clock.sim_time_ms) : '—'}</strong></span>
        <label className="inline-select inline-select-sm"><span className="sr-only">Simulation speed</span><select aria-label="Simulation speed" disabled={!canAdmin || !snapshot || pending} value={speed} onChange={(event) => void changeRun('speed', Number(event.target.value))}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}×</option>)}</select></label>
        <Button variant="secondary" size="sm" disabled={!canAdmin || !snapshot || pending} onClick={() => void changeRun('pause')}>{snapshot?.clock.paused ? <Play size={14}/> : <Pause size={14}/>} {snapshot?.clock.paused ? 'Resume' : 'Pause'}</Button>
      </div>
    </div>
    {controlError && <p role="alert" className="data-warning">{controlError}</p>}
    {error && <div className="connection-banner" role="alert"><AlertTriangle size={20}/><div><strong>{snapshot ? 'Updates interrupted. Last received data is shown.' : 'Could not connect to the data source.'}</strong><p>{error}</p>{mode === 'live' && <p>Live mode requires P2’s deployed tables and client. No mock fallback has been substituted.</p>}</div><Button variant="secondary" onClick={() => setRevision((r) => r + 1)}><RefreshCw size={14}/>Retry</Button></div>}
    {!snapshot && !error && <div className="loading-surface" role="status"><span>Loading the cluster’s public snapshot…</span><div/><div/><div/></div>}
    {snapshot && store && <>
      {example && <p className="data-warning"><strong>Recovery example</strong> — a scripted illustration, not a live diagnosis.</p>}
      <div className="hero-grid">
        <div id="overview" className="hero-cluster"><SimulationView snapshot={snapshot} selected={selected} onSelect={selectGpu} onSelectPump={setSelectedPumpId} telemetry={state.evidence?.telemetry} actionDetails={state.actionDetails} history={state.jobHistory}/></div>
        <div className="hero-room"><AgentRoom events={state.events} workflows={runWorkflows} incidents={state.incidents} nowUnixMs={now} example={example} mode={mode}/></div>
      </div>
      <div className="story-row"><Incidents incidents={state.incidents.slice(0, 2)} evidence={state.evidence} example={example}/><WorkflowBoard workflows={runWorkflows} plans={runPlans} events={state.events} actionDetails={state.actionDetails} incidents={state.incidents} snapshot={snapshot} example={example} mode={mode} nowUnixMs={now}/></div>

      <section id="details" className="details" aria-labelledby="details-heading">
        <div className="details-head"><h2 id="details-heading">Details</h2>
          <div className="tablist" role="tablist" aria-label="Details" onKeyDown={onTabKey}>{TABS.map((item) => <button key={item.id} type="button" role="tab" id={`tab-${item.id}`} className="tab" aria-selected={tab === item.id} aria-controls={`panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
        </div>
        <div role="tabpanel" id="panel-jobs" aria-labelledby="tab-jobs" className="tabpanel" hidden={tab !== 'jobs'}><Jobs snapshot={snapshot} losses={state.losses} history={state.jobHistory} details={state.actionDetails}/><details className="sim-more"><summary>Detailed cooling measurements</summary><Cooling snapshot={snapshot}/></details></div>
        <div role="tabpanel" id="panel-ledger" aria-labelledby="tab-ledger" className="tabpanel" hidden={tab !== 'ledger'}><Ledger actions={state.actions} details={state.actionDetails} simTimeMs={snapshot.clock.sim_time_ms}/></div>
        <div role="tabpanel" id="panel-activity" aria-labelledby="tab-activity" className="tabpanel" hidden={tab !== 'activity'}><Feed events={state.events} example={example}/></div>
        <div role="tabpanel" id="panel-scoreboard" aria-labelledby="tab-scoreboard" className="tabpanel" hidden={tab !== 'scoreboard'}><Scoreboard results={state.results} mode={mode} onLoadRehearsal={mode === 'mock' ? () => { void loadRehearsalBatch(store.client).catch((reason) => setControlError(errorMessage(reason))); } : undefined}/></div>
        <div role="tabpanel" id="real-gpu" aria-labelledby="tab-real-gpu" className="tabpanel" hidden={tab !== 'real-gpu'}><RealGpu evidence={state.evidence} now={now}/></div>
        <div role="tabpanel" id="panel-model" aria-labelledby="tab-model" className="tabpanel" hidden={tab !== 'model'}>
          {state.signals.length > 0 && <details className="signal-panel" id="signals"><summary>Observed signals <Badge tone="warning">{state.signals.length}</Badge></summary><div>{[...state.signals].reverse().map((signal) => <p key={signal.event_id}><time>{duration(signal.sim_time_ms)} sim</time><code>{signal.resource_id}</code><strong>{signal.xid_code ? `XID ${signal.xid_code}` : signal.event_type}</strong><span>{signal.message}</span></p>)}</div></details>}
          <ModelAssumptions snapshot={snapshot}/>
          <p className="model-links">Run <code>{snapshot.run_id}</code> · {localPhysics ? 'local physics in this browser' : mode === 'mock' ? 'fixture playback' : `live DB · ${dbName}`} · thresholds: throttle 85 °C, shutdown 92 °C · <a href="https://github.com/sss9746/DatacenterOS/blob/main/plans/CONTRACTS.md" target="_blank" rel="noreferrer">Model contracts<ArrowUpRight size={13}/></a></p>
        </div>
      </section>
    </>}
    <footer className="footer"><span><span className="footer-brand">DataCenterOS</span> · a simulated GPU cluster twin · HackUTD 2026</span><a href="https://github.com/sss9746/DatacenterOS" target="_blank" rel="noreferrer">Source<ArrowUpRight size={13}/></a></footer>
    {snapshot && store && <DemoControls store={store} canAdmin={canAdmin} open={presenterOpen} selectedGpuId={selected} selectedPumpId={selectedPumpId} onSelectGpu={selectGpu} onSelectPump={setSelectedPumpId} onReset={() => setRevision((r) => r + 1)} plans={runPlans} actionDetails={state.actionDetails} workflows={runWorkflows} snapshot={snapshot}/>}
  </main></>;
}
