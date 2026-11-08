import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { SHUTDOWN_C, SLOWDOWN_C } from '@dcos/physics';
import type { PageProps } from '../app/page-props';
import { WorkflowBoard } from '../components/workflows/WorkflowBoard';
import { Ledger } from '../components/ledger/Ledger';
import { Feed } from '../components/feed/Feed';
import { ModelAssumptions } from '../components/simulation/ModelAssumptions';
import { Badge, Empty, Panel } from '../components/ui/panel';
import { duration } from '../lib/utils';
import '../components/workflows/workflows-page.css';

/** Tab ids double as the in-page anchors (`#/workflows/ledger`), so `navigate('workflows', 'ledger')` opens the right tab. */
const TABS = [
  { id: 'workflows', label: 'Workflows' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'event-log', label: 'Event log' },
  { id: 'model', label: 'Model' },
] as const;
type TabId = (typeof TABS)[number]['id'];
/** Legacy anchors that used to live inside the single-page dashboard. */
const ANCHOR_TO_TAB: Record<string, TabId> = { workflows: 'workflows', ledger: 'ledger', 'event-log': 'event-log', activity: 'event-log', model: 'model', 'model-assumptions': 'model', signals: 'model', details: 'model' };

const readTabFromHash = (): TabId => {
  try {
    const raw = window.location.hash.replace(/^#\/?/, '');
    const [head, anchor] = raw.split(/[/?]/);
    if (head !== 'workflows' || !anchor) return 'workflows';
    return ANCHOR_TO_TAB[anchor] ?? 'workflows';
  } catch { return 'workflows'; }
};

/**
 * Page 4 — "Where is each recovery, and what was blocked?" Owner: agent D. Four tabs over one read model: every section
 * is rendered (inactive ones are `hidden`) so anchors keep resolving and the shell can scroll to any section id.
 */
export function WorkflowsPage({ state, snapshot, runWorkflows, runPlans, example, mode, localPhysics, now }: PageProps) {
  const [tab, setTab] = useState<TabId>(readTabFromHash);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    const onHash = () => setTab(readTabFromHash());
    onHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const select = (next: TabId) => {
    setTab(next);
    // keep the address bar a deep link to this tab without re-triggering the shell's scroll-to-anchor on the first tab
    try { window.history.replaceState(null, '', next === 'workflows' ? '#/workflows' : `#/workflows/${next}`); } catch { /* history unavailable */ }
  };
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'Home' ? -index : event.key === 'End' ? TABS.length - 1 - index : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (index + delta + TABS.length) % TABS.length;
    select(TABS[next]!.id);
    tabRefs.current[next]?.focus();
  };
  const blocked = state.actions.filter((a) => a.status === 'failed' && a.reason_code === 'SAFETY_REJECTED').length;
  const counts: Record<TabId, number | null> = { workflows: runWorkflows.length, ledger: state.actions.length, 'event-log': state.events.length, model: null };
  return <div className="wf-page">
    <div className="wf-tabs" role="tablist" aria-label="Workflow views">
      {TABS.map((t, i) => <button key={t.id} ref={(el) => { tabRefs.current[i] = el; }} type="button" role="tab" id={`wf-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`wf-pane-${t.id}`} tabIndex={tab === t.id ? 0 : -1} className="wf-tab" onClick={() => select(t.id)} onKeyDown={(event) => onKey(event, i)}>
        {t.label}{counts[t.id] !== null && <span className="wf-tab-count">{counts[t.id]}</span>}{t.id === 'ledger' && blocked > 0 && <span className="wf-tab-blocked" title={`${blocked} blocked by safety`}>{blocked} blocked</span>}
      </button>)}
    </div>
    <div id="wf-pane-workflows" role="tabpanel" aria-labelledby="wf-tab-workflows" hidden={tab !== 'workflows'} className="wf-pane">
      <WorkflowBoard workflows={runWorkflows} plans={runPlans} events={state.events} actionDetails={state.actionDetails} incidents={state.incidents} snapshot={snapshot} example={example} mode={mode} nowUnixMs={now} evidence={state.evidence}/>
    </div>
    <div id="wf-pane-ledger" role="tabpanel" aria-labelledby="wf-tab-ledger" hidden={tab !== 'ledger'} className="wf-pane">
      <Ledger actions={state.actions} details={state.actionDetails} simTimeMs={snapshot.clock.sim_time_ms}/>
    </div>
    <div id="wf-pane-event-log" role="tabpanel" aria-labelledby="wf-tab-event-log" hidden={tab !== 'event-log'} className="wf-pane">
      <Feed events={state.events} example={example} id="event-log" title="Event log"/>
    </div>
    <div id="wf-pane-model" role="tabpanel" aria-labelledby="wf-tab-model" hidden={tab !== 'model'} className="wf-pane">
      <ModelPanel snapshot={snapshot} signals={state.signals} mode={mode} localPhysics={localPhysics} example={example}/>
    </div>
  </div>;
}

const SIGNAL_TONE: Record<string, string> = { critical: 'danger', warning: 'warning', info: 'neutral' };

function ModelPanel({ snapshot, signals, mode, localPhysics, example }: Pick<PageProps, 'snapshot' | 'mode' | 'localPhysics' | 'example'> & { signals: PageProps['state']['signals'] }) {
  const source = mode === 'live' ? 'live DB' : localPhysics ? 'local physics in this browser' : example ? 'scripted example fixture' : 'fixture playback';
  const newest = [...signals].reverse();
  return <Panel title="Model" id="model" className="wf-model" detail={<Badge tone={mode === 'live' ? 'neutral' : 'simulated'}>{mode === 'live' ? 'Live DB' : 'Simulated'}</Badge>}>
    <p className="wf-provenance">Run <code>{snapshot.run_id}</code> · {source} · thresholds throttle {SLOWDOWN_C} °C, shutdown {SHUTDOWN_C} °C · <a href="https://github.com/sss9746/DatacenterOS/blob/main/plans/CONTRACTS.md" target="_blank" rel="noreferrer">Model contracts<ArrowUpRight size={12} aria-hidden="true"/></a></p>
    <div className="wf-model-body">
      <ModelAssumptions snapshot={snapshot}/>
      <details className="sim-more wf-signals" id="signals">
        <summary>Observed signals <Badge>{signals.length}</Badge></summary>
        {newest.length === 0 ? <Empty title="No signals yet">Equipment alarms, XID errors and recovery notices appear here as the twin observes them.</Empty>
          : <ol className="wf-signal-list" aria-label="Observed signals, newest first">{newest.slice(0, 40).map((s) => <li key={s.event_id}>
            <Badge tone={SIGNAL_TONE[s.severity] ?? 'neutral'}>{s.severity}</Badge>
            <span className="wf-signal-text">{s.message}</span>
            <span className="wf-signal-meta" title={`${s.event_type} · ${s.source_kind} · ${s.resource_id}`}>{s.resource_id} · {duration(s.sim_time_ms)} sim</span>
          </li>)}{newest.length > 40 && <li className="wf-signal-more">+{newest.length - 40} older signals</li>}</ol>}
      </details>
    </div>
  </Panel>;
}
