import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Activity, ArrowUpRight, Pause, Play, RefreshCw, AlertTriangle, SlidersHorizontal } from 'lucide-react';
import { useDashboard } from '../data/use-dashboard';
import { asMock, errorMessage, type Preview } from '../data/dashboard';
import { Header } from '../components/header/Header';
import { coolingLoops, isPumpId, loopOfRack } from '../components/simulation/topology';
import { PresenterControls } from '../components/controls/Controls';
import { DEFAULT_XID_GPU_ID, type PumpId } from '../components/controls/fault-form';
import { Badge } from '../components/ui/panel';
import { Button } from '../components/ui/button';
import { duration } from '../lib/utils';
import { ROUTES, anchorFromHash, hrefOf, routeFromHash, type RouteId } from './routes';
import type { PageProps } from './page-props';
import { ClusterPage } from '../pages/ClusterPage';
import { JobsPage } from '../pages/JobsPage';
import { RecoveryPage } from '../pages/RecoveryPage';
import { WorkflowsPage } from '../pages/WorkflowsPage';
import { BenchmarksPage } from '../pages/BenchmarksPage';
import { RealGpuPage } from '../pages/RealGpuPage';

/** `?presenter=1` opens the control drawer on load; judges' default view keeps it closed under the story. */
const presenterRequested = () => { try { return new URLSearchParams(window.location.search).get('presenter') === '1'; } catch { return false; } };
const readHash = () => { try { return window.location.hash; } catch { return ''; } };

const PAGES: Record<RouteId, (props: PageProps) => ReactElement> = { cluster: ClusterPage, jobs: JobsPage, recovery: RecoveryPage, workflows: WorkflowsPage, benchmarks: BenchmarksPage, 'real-gpu': RealGpuPage };

/** Hash router: the page id comes from `#/…`; legacy anchors are normalised to their page. */
function useRoute() {
  const [hash, setHash] = useState(readHash);
  useEffect(() => { const onHash = () => setHash(readHash()); window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash); }, []);
  const route = routeFromHash(hash);
  const anchor = anchorFromHash(hash);
  const navigate = useCallback((next: RouteId, nextAnchor?: string) => { window.location.hash = nextAnchor ? `${hrefOf(next)}/${nextAnchor}` : hrefOf(next); }, []);
  // Legacy `#jobs` → `#/jobs` so the address bar shows the canonical deep link.
  useEffect(() => { if (hash && !hash.startsWith('#/')) window.history.replaceState(null, '', hrefOf(route)); }, [hash, route]);
  useEffect(() => { if (anchor) document.getElementById(anchor)?.scrollIntoView({ block: 'start' }); else window.scrollTo(0, 0); }, [route, anchor]);
  return { route, anchor, navigate };
}

export function App() {
  const [preview, setPreview] = useState<Preview>('physics');
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState(DEFAULT_XID_GPU_ID);
  const [selectedPumpId, setSelectedPumpId] = useState<PumpId>('pump-a');
  const [speed, setSpeed] = useState(1);
  const [now, setNow] = useState(Date.now());
  const [openedAt] = useState(Date.now());
  const [presenterOpen] = useState(presenterRequested);
  const [controlError, setControlError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { route, navigate } = useRoute();
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
  const stale = state.lastReceived !== null && !snapshot?.clock.paused && now - state.lastReceived > 5000;
  const pumpOfRack = (rack: number): PumpId => { const id = snapshot ? loopOfRack(coolingLoops(snapshot), rack)?.pumpId : undefined; return id && isPumpId(id) ? id : rack >= 2 && rack <= 4 ? 'pump-a' : 'pump-b'; };
  const selectGpu = (id: string) => { setSelected(id); const rack = Number(/gpu-r(\d+)-/.exec(id)?.[1]); if (rack >= 1 && rack <= 8) setSelectedPumpId(pumpOfRack(rack)); };
  const example = mode === 'mock' && preview === 'recovery';
  const current = ROUTES.find((row) => row.id === route) ?? ROUTES[0];
  const Page = PAGES[route];
  return <><a className="skip-link" href="#main">Skip to content</a><Header mode={mode} localPhysics={localPhysics} dbName={dbName} route={route}/><main id="main" className="main">
    <div className="page-title"><div><h1>{current.label}</h1><p>{current.question}</p></div><div className="run-identity"><Activity size={15}/><span>run-demo-1</span><Badge>SIMULATED</Badge></div></div>
    <div className="run-toolbar"><div className="clocks"><div><span>Sim time</span><strong data-testid="sim-clock">{snapshot ? duration(snapshot.clock.sim_time_ms) : '—'}</strong></div><div><span>Wall time · this session</span><strong>{duration(now - openedAt)}</strong></div><span className={`connection ${error || stale ? 'connection-error' : ''}`}><i/>{error ? 'Connection error' : stale ? 'Stale data' : snapshot ? localPhysics ? 'Local physics' : mode === 'mock' ? 'Fixture playback' : `Live DB connected · ${dbName}` : 'Connecting'}</span></div><div className="run-actions">{mode === 'mock' && <label className="inline-select"><span className="sr-only">Run view</span><select aria-label="Run view" value={preview} onChange={(event) => { setPreview(event.target.value as Preview); }}><option value="physics">Local physics simulation</option><option value="demo">Healthy fixture</option><option value="pump_degraded">Cooling fault</option><option value="recovery">Recovery example</option></select></label>}<label className="inline-select"><span className="sr-only">Simulation speed</span><select aria-label="Simulation speed" disabled={!canAdmin || !snapshot || pending} value={speed} onChange={(event) => void changeRun('speed', Number(event.target.value))}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}× speed</option>)}</select></label><Button variant="secondary" size="sm" disabled={!canAdmin || !snapshot || pending} onClick={() => void changeRun('pause')}>{snapshot?.clock.paused ? <Play size={14}/> : <Pause size={14}/>} {snapshot?.clock.paused ? 'Resume' : 'Pause'}</Button></div></div>
    {controlError && <p role="alert" className="data-warning">{controlError}</p>}
    {error && <div className="connection-banner" role="alert"><AlertTriangle size={20}/><div><strong>{snapshot ? 'Updates interrupted. Last received data is shown.' : 'Could not connect to the data source.'}</strong><p>{error}</p>{mode === 'live' && <p>Live mode requires P2’s deployed tables and client. No mock fallback has been substituted.</p>}</div><Button variant="secondary" onClick={() => setRevision((r) => r + 1)}><RefreshCw size={14}/>Retry</Button></div>}
    {!snapshot && !error && <div className="loading-surface" role="status"><span>Loading the cluster’s public snapshot…</span><div/><div/><div/></div>}
    {snapshot && store && <>
      {example && <p className="data-warning">Recovery example: incidents and tool calls are scripted illustrations. They are not a live diagnosis, executed plan, or benchmark.</p>}
      <Page state={state} store={store} snapshot={snapshot} mode={mode} dbName={dbName} canAdmin={canAdmin} localPhysics={localPhysics} example={example} now={now} runWorkflows={state.workflows.filter((row) => row.run_id === snapshot.run_id)} runPlans={state.plans.filter((row) => row.run_id === snapshot.run_id)} selectedGpuId={selected} selectedPumpId={selectedPumpId} onSelectGpu={selectGpu} onSelectPump={setSelectedPumpId} onError={setControlError} navigate={navigate}/>
    </>}
    <footer className="footer"><span>DataCenterOS <span className="separator">/</span> A GPU cluster digital twin</span><span>Simulated, configurable thresholds: throttle 85 °C · shutdown 92 °C</span><a href="https://github.com/sss9746/DatacenterOS/blob/main/plans/CONTRACTS.md" target="_blank" rel="noreferrer">Model contracts<ArrowUpRight size={13}/></a></footer>
    {snapshot && store && <details className="presenter-drawer" id="presenter" open={presenterOpen}>
      <summary><SlidersHorizontal size={16} aria-hidden="true"/><span>Presenter controls</span><small>{canAdmin ? 'Inject a fault · safety probe · reset' : 'Read-only without the presenter token'}</small></summary>
      <div className="presenter-drawer-body"><PresenterControls store={store} canAdmin={canAdmin} selectedGpuId={selected} selectedPumpId={selectedPumpId} onSelectGpu={selectGpu} onSelectPump={setSelectedPumpId} onReset={() => setRevision((r) => r + 1)}/></div>
    </details>}
  </main></>;
}
