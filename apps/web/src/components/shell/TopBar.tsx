import { Boxes, ExternalLink, Pause, Play, SlidersHorizontal } from 'lucide-react';
import type { ObservedSnapshot } from '@dcos/contracts';
import type { Preview } from '../../data/dashboard';
import { hrefOf } from '../../app/routes';
import { duration } from '../../lib/utils';
import { Badge } from '../ui/panel';
import { Button } from '../ui/button';
import type { PageProps } from '../../app/page-props';
import './topbar-recorded.css';

export interface TopBarProps {
  mode: 'mock' | 'live';
  dbName: string;
  localPhysics: boolean;
  snapshot: ObservedSnapshot | null;
  error: string | null;
  stale: boolean;
  canAdmin: boolean;
  pending: boolean;
  preview: Preview;
  onPreview: (next: Preview) => void;
  speed: number;
  onSpeed: (next: number) => void;
  onTogglePause: () => void;
  demoOpen: boolean;
  onToggleDemo: () => void;
  /** Non-null in the RECORDED replay: model, date and database of the saved real run. */
  recorded?: PageProps['recorded'];
}

const SPEEDS = [1, 2, 3, 4, 5] as const;

/** Global masthead: brand, sim clock, mode and connection, run controls and the Demo controls toggle. One row at 1440; wraps at 390. */
export function TopBar({ mode, dbName, localPhysics, snapshot, error, stale, canAdmin, pending, preview, onPreview, speed, onSpeed, onTogglePause, demoOpen, onToggleDemo, recorded = null }: TopBarProps) {
  const connection = error ? 'Connection error' : stale ? 'Stale data' : snapshot ? localPhysics ? 'Local physics' : mode === 'mock' ? 'Fixture playback' : `Live DB connected · ${dbName}` : 'Connecting';
  const connectionTone = error ? 'connection-error' : stale ? 'connection-stale' : '';
  const paused = Boolean(snapshot?.clock.paused);
  const controlsDisabled = !canAdmin || !snapshot || pending;
  return <header className="masthead">
    <a className="brand" href={hrefOf('cluster')} aria-label="DataCenterOS cluster overview"><Boxes size={25} strokeWidth={1.7} aria-hidden="true"/><span>DataCenter<span className="brand-os">OS</span></span></a>
    <div className="masthead-status">
      <div className="sim-clock" title="Simulated time since the run started; it differs from wall time"><span>Sim time</span><strong data-testid="sim-clock">{snapshot ? duration(snapshot.clock.sim_time_ms) : '—'}</strong></div>
      <span className="masthead-badges">
        <Badge tone={mode === 'mock' ? 'mock' : 'neutral'}>{localPhysics ? 'Mock · local physics' : mode === 'mock' ? 'Mock · fixtures' : `Live DB · ${dbName}`}</Badge>
        <Badge tone="simulated">SIMULATED</Badge>
      </span>
      {recorded && <span className="recorded-badge" title="Agent-team rounds replayed from a saved real Nemotron run; cluster telemetry is the mock fixture">
        <Badge tone="recorded">RECORDED · {recorded.model ?? 'model not recorded'} · {recorded.date} · {recorded.db}</Badge>
        {recorded.timing === 'replay' && <span className="recorded-timing">replay pacing, not recorded timing</span>}
      </span>}
      {/* In the RECORDED replay the badge already says where the data came from; errors and staleness still show. */}
      {!(recorded && !error && !stale) && <span className={`connection ${connectionTone}`} role="status"><i aria-hidden="true"/>{connection}</span>}
    </div>
    <div className="masthead-actions">
      {mode === 'mock' && <label className="inline-select"><span className="sr-only">Run view</span><select aria-label="Run view" value={preview} onChange={(event) => onPreview(event.target.value as Preview)}><option value="physics">Local physics simulation</option><option value="demo">Healthy fixture</option><option value="pump_degraded">Cooling fault</option><option value="recovery">Recovery example</option><option value="recorded">Recorded agent team (L3)</option></select></label>}
      <label className="inline-select"><span className="sr-only">Simulation speed</span><select aria-label="Simulation speed" disabled={controlsDisabled} value={speed} onChange={(event) => onSpeed(Number(event.target.value))}>{SPEEDS.map((value) => <option key={value} value={value}>{value}× speed</option>)}</select></label>
      <Button variant="secondary" size="sm" disabled={controlsDisabled} onClick={onTogglePause}>{paused ? <Play size={14} aria-hidden="true"/> : <Pause size={14} aria-hidden="true"/>}{paused ? 'Resume' : 'Pause'}</Button>
      <Button variant={demoOpen ? 'default' : 'secondary'} size="sm" className="demo-toggle" aria-label="Demo controls" aria-expanded={demoOpen} aria-controls="presenter" disabled={!snapshot} onClick={onToggleDemo}><SlidersHorizontal size={14} aria-hidden="true"/><span>Demo controls</span></Button>
      <a className="icon-link" href="https://github.com/sss9746/DatacenterOS" target="_blank" rel="noreferrer" aria-label="Open DataCenterOS repository"><ExternalLink size={16} aria-hidden="true"/></a>
    </div>
  </header>;
}
