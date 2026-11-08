import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { ArrowUpRight, RefreshCw, AlertTriangle } from 'lucide-react';
import { useDashboard } from '../data/use-dashboard';
import { asMock, errorMessage, type Preview } from '../data/dashboard';
import { Sidebar } from '../components/shell/Sidebar';
import { TopBar } from '../components/shell/TopBar';
import { PageHeader } from '../components/shell/PageHeader';
import { coolingLoops, isPumpId, loopOfRack } from '../components/simulation/topology';
import { DemoControls } from '../components/controls/DemoControls';
import { DEFAULT_XID_GPU_ID, type PumpId } from '../components/controls/fault-form';
import { Button } from '../components/ui/button';
import { ROUTES, anchorFromHash, hrefOf, routeFromHash, type RouteId } from './routes';
import type { PageProps } from './page-props';
import { ClusterPage } from '../pages/ClusterPage';
import { JobsPage } from '../pages/JobsPage';
import { RecoveryPage } from '../pages/RecoveryPage';
import { WorkflowsPage } from '../pages/WorkflowsPage';
import { BenchmarksPage } from '../pages/BenchmarksPage';
import { RealGpuPage } from '../pages/RealGpuPage';

/** `?presenter=1` opens the Demo controls drawer on load; judges' default view keeps it closed under the story. */
const presenterRequested = () => { try { return new URLSearchParams(window.location.search).get('presenter') === '1'; } catch { return false; } };
const readHash = () => { try { return window.location.hash; } catch { return ''; } };
/** Data older than this (wall ms) while the clock runs is reported as stale. */
const STALE_AFTER_MS = 5000;

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
  const [demoOpen, setDemoOpen] = useState(presenterRequested);
  const [controlError, setControlError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { route, navigate } = useRoute();
  const { state, store, error, mode, dbName, canAdmin } = useDashboard(preview, revision);
  const snapshot = state.snapshot;
  const localPhysics = mode === 'mock' && preview === 'physics';
  const current = ROUTES.find((row) => row.id === route) ?? ROUTES[0];
  useEffect(() => { document.title = `DataCenterOS · ${current.label}`; }, [current.label]);
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
  const stale = state.lastReceived !== null && !snapshot?.clock.paused && now - state.lastReceived > STALE_AFTER_MS;
  const pumpOfRack = (rack: number): PumpId => { const id = snapshot ? loopOfRack(coolingLoops(snapshot), rack)?.pumpId : undefined; return id && isPumpId(id) ? id : rack >= 2 && rack <= 4 ? 'pump-a' : 'pump-b'; };
  const selectGpu = (id: string) => { setSelected(id); const rack = Number(/gpu-r(\d+)-/.exec(id)?.[1]); if (rack >= 1 && rack <= 8) setSelectedPumpId(pumpOfRack(rack)); };
  const example = mode === 'mock' && preview === 'recovery';
  const Page = PAGES[route];
  const openDemo = () => { setDemoOpen((open) => !open); if (!demoOpen) requestAnimationFrame(() => document.getElementById('presenter')?.scrollIntoView({ block: 'end' })); };
  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    <TopBar mode={mode} dbName={dbName} localPhysics={localPhysics} snapshot={snapshot} error={error} stale={stale} canAdmin={canAdmin} pending={pending}
      preview={preview} onPreview={setPreview} speed={speed} onSpeed={(next) => void changeRun('speed', next)} onTogglePause={() => void changeRun('pause')}
      demoOpen={demoOpen} onToggleDemo={openDemo}/>
    <Sidebar route={route}/>
    <main id="main" className="main">
      <PageHeader route={current}/>
      {controlError && <p role="alert" className="data-warning">{controlError}</p>}
      {error && <div className="connection-banner" role="alert"><AlertTriangle size={20} aria-hidden="true"/><div><strong>{snapshot ? 'Updates interrupted. Last received data is shown.' : 'Could not connect to the data source.'}</strong><p>{error}</p>{mode === 'live' && <p>Live mode requires P2’s deployed tables and client. No mock fallback has been substituted.</p>}</div><Button variant="secondary" onClick={() => setRevision((r) => r + 1)}><RefreshCw size={14} aria-hidden="true"/>Retry</Button></div>}
      {!snapshot && !error && <div className="loading-surface" role="status"><span>Loading the cluster’s public snapshot…</span><div/><div/><div/></div>}
      {snapshot && store && <>
        {example && <p className="data-warning">Recovery example: incidents and tool calls are scripted illustrations. They are not a live diagnosis, executed plan, or benchmark.</p>}
        <Page state={state} store={store} snapshot={snapshot} mode={mode} dbName={dbName} canAdmin={canAdmin} localPhysics={localPhysics} example={example} now={now} runWorkflows={state.workflows.filter((row) => row.run_id === snapshot.run_id)} runPlans={state.plans.filter((row) => row.run_id === snapshot.run_id)} selectedGpuId={selected} selectedPumpId={selectedPumpId} onSelectGpu={selectGpu} onSelectPump={setSelectedPumpId} onError={setControlError} navigate={navigate}/>
      </>}
      <footer className="footer"><span>DataCenterOS <span className="separator">/</span> A GPU cluster digital twin</span><span>Simulated, configurable thresholds: throttle 85 °C · shutdown 92 °C</span><a href="https://github.com/sss9746/DatacenterOS/blob/main/plans/CONTRACTS.md" target="_blank" rel="noreferrer">Model contracts<ArrowUpRight size={13} aria-hidden="true"/></a></footer>
      {snapshot && store && <DemoControls store={store} canAdmin={canAdmin} open={demoOpen} onOpenChange={setDemoOpen} selectedGpuId={selected} selectedPumpId={selectedPumpId} onSelectGpu={selectGpu} onSelectPump={setSelectedPumpId} onReset={() => setRevision((r) => r + 1)} plans={state.plans} actionDetails={state.actionDetails} workflows={state.workflows} snapshot={snapshot}/>}
    </main>
  </>;
}
