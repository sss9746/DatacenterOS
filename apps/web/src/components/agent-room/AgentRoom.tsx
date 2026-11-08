import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEventInput, WorkflowRecord } from '@dcos/db-client';
import type { Incident } from '@dcos/contracts';
import { Badge, Panel } from '../ui/panel';
import { SEATS, UNATTRIBUTED } from './seat-of';
import { buildRoomView, RUN_THREAD_ID, type Bubble as BubbleModel, type Thread } from './room-view';
import { Seat } from './Seat';
import { Bubble, Divider } from './Bubble';
import './agent-room.css';

const FRESH_MS = 1600;
const BOTTOM_SLACK_PX = 24;

export function AgentRoom(props: { events: AgentEventInput[]; workflows: WorkflowRecord[]; incidents: Incident[]; nowUnixMs: number; example: boolean; mode: 'mock' | 'live' }) {
  const { events, workflows, incidents, nowUnixMs, example, mode } = props;
  const view = useMemo(() => buildRoomView({ events, workflows, incidents, nowUnixMs, example }), [events, workflows, incidents, nowUnixMs, example]);

  // Thread selection: explicit click wins while that thread exists; otherwise the thread with the newest event.
  const [picked, setPicked] = useState<string | null>(null);
  const newest = view.threads.reduce<Thread | null>((best, t) => (t.id !== RUN_THREAD_ID && (best === null || (t.lastObservedUnixMs ?? 0) >= (best.lastObservedUnixMs ?? 0)) ? t : best), null) ?? view.threads[0] ?? null;
  const active = view.threads.find((t) => t.id === picked) ?? newest;

  // Freshness: ids first seen after mount animate once; nothing animates on the initial paint.
  const seenRef = useRef<Map<string, number> | null>(null);
  if (seenRef.current === null) seenRef.current = new Map(events.map((e) => [e.agent_event_id, 0]));
  const seen = seenRef.current;
  const renderedAt = Date.now();
  for (const e of events) if (!seen.has(e.agent_event_id)) seen.set(e.agent_event_id, renderedAt);
  const isFresh = (id: string) => { const at = seen.get(id) ?? 0; return at > 0 && renderedAt - at < FRESH_MS; };

  // Auto-scroll only when the viewer was already at the bottom.
  const logRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const itemCount = active?.items.length ?? 0;
  useEffect(() => {
    const el = logRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [itemCount, active?.id]);
  // Keep the selected tab visible inside the (horizontally scrollable) tab row without moving the page.
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = tabsRef.current;
    const tab = row?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!row || !tab) return;
    const left = tab.offsetLeft - row.offsetLeft;
    if (left < row.scrollLeft) row.scrollLeft = left - 8;
    else if (left + tab.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = left + tab.offsetWidth - row.clientWidth + 8;
  }, [active?.id]);
  const onScroll = () => { const el = logRef.current; if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX; };

  const counts = new Map<string, number>();
  for (const t of view.threads) for (const i of t.items) if (i.kind === 'bubble') counts.set(i.seat, (counts.get(i.seat) ?? 0) + 1);
  const seats = view.counts.unattributed > 0 ? [...SEATS, UNATTRIBUTED] : SEATS;
  const bubbles = active?.items.filter((i): i is BubbleModel => i.kind === 'bubble') ?? [];

  const detail = (
    <div className="ar-head-right">
      <strong className="ar-head-line">6 specialists · 2 Nemotron · 4 code{view.counts.processes > 0 && ` · ${view.counts.processes} process${view.counts.processes === 1 ? '' : 'es'}`}</strong>
      <span className="ar-head-badges">
        {mode === 'live' ? <Badge tone="neutral">LIVE DB</Badge> : <Badge tone="mock">MOCK</Badge>}
        {example && <Badge tone="example">EXAMPLE</Badge>}
      </span>
    </div>
  );

  return (
    <Panel id="agent-room" title="Agent room" detail={detail} className="agent-room">
      <ul className="ar-seats" aria-label="Specialist seats">
        {seats.map((s) => <Seat key={s.id} info={s} state={view.seatStates[s.id]} count={counts.get(s.id) ?? 0}/>)}
      </ul>

      {view.threads.length > 1 && (
        <div ref={tabsRef} className="ar-tabs" role="tablist" aria-label="Incident threads">
          {view.threads.map((t) => {
            const selected = t.id === active?.id;
            const n = t.items.filter((i) => i.kind === 'bubble').length;
            return (
              <button key={t.id} type="button" role="tab" id={`ar-tab-${t.id}`} aria-selected={selected} aria-controls="ar-stream" tabIndex={selected ? 0 : -1} className={`ar-tab ar-accent-${t.accent}${selected ? ' is-selected' : ''}`} onClick={() => setPicked(t.id)}>
                <i className="ar-tab-swatch" aria-hidden="true"/>
                <span className="ar-tab-title">{t.title}</span>
                <span className="ar-tab-meta">
                <span className="ar-tab-count">{n}</span>
                {t.owner && (t.leaseLapsed ? <span className="ar-tab-owner is-lapsed">lease lapsed · was {t.owner}</span> : <span className="ar-tab-owner">owned by {t.owner}</span>)}
                {t.closed && <span className="ar-tab-state">{t.workflowStage === 'escalated' ? 'needs a human' : 'done'}</span>}
                {t.silentForS !== null && <span className="ar-tab-silent">silent for {t.silentForS}s</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {active?.owner && <p className={`ar-active-owner${active.leaseLapsed ? ' is-lapsed' : ''}`}>{active.leaseLapsed ? `lease lapsed · was ${active.owner}` : `owned by ${active.owner}`}</p>}

      <div id="ar-stream" ref={logRef} onScroll={onScroll} role="log" aria-live="polite" aria-labelledby={active ? `ar-tab-${active.id}` : undefined} className={`ar-stream ar-accent-${active?.accent ?? 'run'}`}>
        {active === null || active.items.length === 0 ? (
          <div className="ar-empty"><strong>No agent events yet</strong><p>{mode === 'live' ? 'Waiting for the agent to publish its first event.' : 'Start a run to see the specialists talk.'}</p></div>
        ) : (
          <ol className="ar-items">
            {active.items.map((item) => {
              if (item.kind === 'divider') return <Divider key={item.id} divider={item}/>;
              const next = bubbles[bubbles.indexOf(item) + 1];
              // The handoff dot travels when the receiving bubble has just arrived, never on the initial paint.
              return <Bubble key={item.id} bubble={item} fresh={isFresh(item.id)} handoffFresh={next ? isFresh(next.id) : false}/>;
            })}
          </ol>
        )}
      </div>
    </Panel>
  );
}
