import { useEffect, useState } from 'react';
import { Activity, ArrowUpRight, Pause, Play, RefreshCw, AlertTriangle } from 'lucide-react';
import { useDashboard } from '../data/use-dashboard';
import { asMock, errorMessage, type Preview } from '../data/dashboard';
import { Header } from '../components/header/Header';
import { SimulationView } from '../components/simulation/SimulationView';
import { ModelAssumptions } from '../components/simulation/ModelAssumptions';
import { RealGpu } from '../components/heatmap/RealGpu';
import { Jobs } from '../components/jobs/Jobs';
import { Cooling } from '../components/cooling/Cooling';
import { Incidents } from '../components/incidents/Incidents';
import { Feed } from '../components/feed/Feed';
import { WorkflowBoard } from '../components/workflows/WorkflowBoard';
import { Ledger } from '../components/ledger/Ledger';
import { PresenterControls } from '../components/controls/Controls';
import { Scoreboard } from '../components/scoreboard/Scoreboard';
import { Badge } from '../components/ui/panel';
import { Button } from '../components/ui/button';
import { duration } from '../lib/utils';

export function App() {
  const [preview, setPreview] = useState<Preview>('physics');
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState('gpu-r3-n1-0');
  const [selectedPumpId, setSelectedPumpId] = useState<'pump-a' | 'pump-b'>('pump-a');
  const [speed, setSpeed] = useState(1);
  const [now, setNow] = useState(Date.now());
  const [openedAt] = useState(Date.now());
  const [controlError, setControlError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
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
  const simulatedGpus = snapshot?.gpus.filter((gpu) => gpu.resource_id !== 'gpu-real-0') ?? [];
  const available = simulatedGpus.filter((gpu) => gpu.availability === 'ready').length;
  const throttled = simulatedGpus.filter((gpu) => (gpu.clocks_event_reasons & 0x20) !== 0).length;
  const allocated = new Set(snapshot?.allocations.map((row) => row.gpu_id)).size;
  const stale = state.lastReceived !== null && !snapshot?.clock.paused && now - state.lastReceived > 5000;
  const selectGpu = (id: string) => { setSelected(id); const rack = Number(/gpu-r(\d+)-/.exec(id)?.[1]); if (rack >= 1 && rack <= 8) setSelectedPumpId(rack >= 2 && rack <= 4 ? 'pump-a' : 'pump-b'); };
  return <><a className="skip-link" href="#overview">Skip to cluster overview</a><Header mode={mode} localPhysics={localPhysics} dbName={dbName}/><main id="overview" className="main">
    <div className="page-title"><div><h1>Cluster operations</h1><p>Keep the training work. Contain the failure.</p></div><div className="run-identity"><Activity size={15}/><span>run-demo-1</span><Badge>SIMULATED</Badge></div></div>
    <div className="run-toolbar"><div className="clocks"><div><span>Sim time</span><strong data-testid="sim-clock">{snapshot ? duration(snapshot.clock.sim_time_ms) : '—'}</strong></div><div><span>Wall time · this session</span><strong>{duration(now - openedAt)}</strong></div><span className={`connection ${error || stale ? 'connection-error' : ''}`}><i/>{error ? 'Connection error' : stale ? 'Stale data' : snapshot ? localPhysics ? 'Local physics' : mode === 'mock' ? 'Fixture playback' : `Live DB connected · ${dbName}` : 'Connecting'}</span></div><div className="run-actions">{mode === 'mock' && <label className="inline-select"><span className="sr-only">Run view</span><select aria-label="Run view" value={preview} onChange={(event) => { setPreview(event.target.value as Preview); }}><option value="physics">Local physics simulation</option><option value="demo">Healthy fixture</option><option value="pump_degraded">Cooling fault</option><option value="recovery">Recovery example</option></select></label>}<label className="inline-select"><span className="sr-only">Simulation speed</span><select aria-label="Simulation speed" disabled={!canAdmin || !snapshot || pending} value={speed} onChange={(event) => void changeRun('speed', Number(event.target.value))}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}× speed</option>)}</select></label><Button variant="secondary" size="sm" disabled={!canAdmin || !snapshot || pending} onClick={() => void changeRun('pause')}>{snapshot?.clock.paused ? <Play size={14}/> : <Pause size={14}/>} {snapshot?.clock.paused ? 'Resume' : 'Pause'}</Button></div></div>
    {controlError && <p role="alert" className="data-warning">{controlError}</p>}
    {error && <div className="connection-banner" role="alert"><AlertTriangle size={20}/><div><strong>{snapshot ? 'Updates interrupted. Last received data is shown.' : 'Could not connect to the data source.'}</strong><p>{error}</p>{mode === 'live' && <p>Live mode requires P2’s deployed tables and client. No mock fallback has been substituted.</p>}</div><Button variant="secondary" onClick={() => setRevision((r) => r + 1)}><RefreshCw size={14}/>Retry</Button></div>}
    {!snapshot && !error && <div className="loading-surface" role="status"><span>Loading the cluster’s public snapshot…</span><div/><div/><div/></div>}
    {snapshot && <>
      <div className="cluster-summary" aria-label="Simulated cluster summary"><span><i className="status-dot"/><strong>{available}/{simulatedGpus.length}</strong> GPUs ready</span><span><strong>{allocated}</strong> allocated</span><span className={throttled ? 'text-warning' : ''}><strong>{throttled}</strong> thermally throttled</span><span><strong>{snapshot.job_states.filter((job) => job.status === 'running').length}/{snapshot.job_states.length}</strong> jobs running</span><span className="summary-provenance">Simulated values{localPhysics ? ' · P1 physics · no agent' : mode === 'mock' ? ' · fixture · no live agent' : ''}</span></div>
      {preview === 'recovery' && mode === 'mock' && <p className="data-warning">Recovery example: incidents and tool calls are scripted illustrations. They are not a live diagnosis, executed plan, or benchmark.</p>}
      <SimulationView snapshot={snapshot} selected={selected} onSelect={selectGpu} onSelectPump={setSelectedPumpId}/>
      {store && <PresenterControls store={store} canAdmin={canAdmin} selectedGpuId={selected} selectedPumpId={selectedPumpId} onSelectGpu={selectGpu} onSelectPump={setSelectedPumpId} onReset={() => setRevision((r) => r + 1)}/>}
      <div className="overview-grid"><div className="column"><Jobs snapshot={snapshot} losses={state.losses} history={state.jobHistory} details={state.actionDetails}/></div><div className="column"><Incidents incidents={state.incidents} evidence={state.evidence} example={mode === 'mock' && preview === 'recovery'}/><details className="sim-more"><summary>Detailed cooling measurements</summary><Cooling snapshot={snapshot}/></details><RealGpu evidence={state.evidence} now={now}/></div></div>
      <WorkflowBoard workflows={state.workflows} events={state.events} actionDetails={state.actionDetails} incidents={state.incidents} snapshot={snapshot} example={mode === 'mock' && preview === 'recovery'} mode={mode} nowUnixMs={now}/>
      <div className="activity-grid"><Feed events={state.events} example={mode === 'mock' && preview === 'recovery'}/><Ledger actions={state.actions} details={state.actionDetails} simTimeMs={snapshot.clock.sim_time_ms}/></div>
      {state.signals.length > 0 && <details className="signal-panel"><summary>Observed signals <Badge tone="warning">{state.signals.length}</Badge></summary><div>{[...state.signals].reverse().map((signal) => <p key={signal.event_id}><time>{duration(signal.sim_time_ms)} sim</time><code>{signal.resource_id}</code><strong>{signal.xid_code ? `XID ${signal.xid_code}` : signal.event_type}</strong><span>{signal.message}</span></p>)}</div></details>}
      <ModelAssumptions snapshot={snapshot}/>
      <Scoreboard results={state.results} mode={mode}/>
    </>}
    <footer className="footer"><span>DataCenterOS <span className="separator">/</span> A GPU cluster digital twin</span><span>Simulated, configurable thresholds: throttle 85 °C · shutdown 92 °C</span><a href="https://github.com/sss9746/DatacenterOS/blob/main/plans/CONTRACTS.md" target="_blank" rel="noreferrer">Model contracts<ArrowUpRight size={13}/></a></footer>
  </main></>;
}
