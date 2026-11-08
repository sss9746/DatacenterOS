import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEventInput, WorkflowRecord } from '@dcos/db-client';
import type { Incident } from '@dcos/contracts';
import { Badge, Panel } from '../ui/panel';
import { SEATS, UNATTRIBUTED } from './seat-of';
import { AGENTS_THREAD_ID, buildRoomView, RUN_THREAD_ID, type Bubble as BubbleModel, type Thread } from './room-view';
import { Seat } from './Seat';
import { Bubble, Divider } from './Bubble';
import './agent-room.css';

const FRESH_MS = 1600;
const TRAVEL_MS = 1400;
const TRAVEL_MIN_ROOM_PX = 600;
const BOTTOM_SLACK_PX = 24;

interface Travel { id: string; x0: number; x1: number; y: number }

const isLane = (id: string) => id === RUN_THREAD_ID || id === AGENTS_THREAD_ID;

export function AgentRoom(props: { events: AgentEventInput[]; workflows: WorkflowRecord[]; incidents: Incident[]; nowUnixMs: number; example: boolean; mode: 'mock' | 'live' }) {
  const { events, workflows, incidents, nowUnixMs, example, mode } = props;
  const view = useMemo(() => buildRoomView({ events, workflows, incidents, nowUnixMs, example }), [events, workflows, incidents, nowUnixMs, example]);

  // Thread selection: explicit click wins while that thread exists; otherwise the workflow thread with the newest event.
  const [picked, setPicked] = useState<string | null>(null);
  const newest = view.threads.reduce<Thread | null>((best, t) => (!isLane(t.id) && (best === null || (t.lastObservedUnixMs ?? 0) >= (best.lastObservedUnixMs ?? 0)) ? t : best), null) ?? view.threads[0] ?? null;
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
  const onScroll = () => { const el = logRef.current; if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX; };

  // Cross-agent message travel: a dot runs from the sender's thread tab to the receiver's, once per new message, wide rooms only.
  const tabsRef = useRef<HTMLDivElement>(null);
  const travelledRef = useRef(new Set<string>());
  const [travel, setTravel] = useState<Travel | null>(null);
  const messages = useMemo(() => view.threads.find((t) => t.id === AGENTS_THREAD_ID)?.items.filter((i): i is BubbleModel => i.kind === 'bubble') ?? [], [view]);
  useEffect(() => {
    const row = tabsRef.current;
    if (!row) return;
    const room = row.closest<HTMLElement>('#agent-room');
    if (!room || room.clientWidth < TRAVEL_MIN_ROOM_PX) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const next = messages.find((b) => !travelledRef.current.has(b.id) && (seen.get(b.id) ?? 0) > 0 && b.message?.fromThreadId && b.message.toThreadId && b.message.fromThreadId !== b.message.toThreadId);
    if (!next?.message) return;
    travelledRef.current.add(next.id);
    const centre = (id: string | null) => { const el = row.querySelector<HTMLElement>(`[data-thread-tab="${id}"]`); return el ? el.offsetLeft - row.scrollLeft + el.offsetWidth / 2 : null; };
    const x0 = centre(next.message.fromThreadId);
    const x1 = centre(next.message.toThreadId);
    if (x0 === null || x1 === null) return;
    setTravel({ id: next.id, x0, x1, y: row.clientHeight - 6 });
    const timer = window.setTimeout(() => setTravel(null), TRAVEL_MS + 100);
    return () => window.clearTimeout(timer);
  }, [messages, seen]);

  const counts = new Map<string, number>();
  for (const t of view.threads) if (!isLane(t.id)) for (const i of t.items) if (i.kind === 'bubble') counts.set(i.seat, (counts.get(i.seat) ?? 0) + 1);
  const seats = view.counts.unattributed > 0 ? [...SEATS, UNATTRIBUTED] : SEATS;
  const bubbles = active?.items.filter((i): i is BubbleModel => i.kind === 'bubble') ?? [];

  const detail = (
    <div className="ar-head-right">
      <strong className="ar-head-line">2 Nemotron · 4 code{view.counts.processes >= 2 && ` · ${view.counts.processes} processes`}</strong>
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
              <button key={t.id} type="button" role="tab" id={`ar-tab-${t.id}`} data-thread-tab={t.id} aria-selected={selected} aria-controls="ar-stream" tabIndex={selected ? 0 : -1} className={`ar-tab ar-accent-${t.accent}${selected ? ' is-selected' : ''}`} onClick={() => setPicked(t.id)}>
                <span className="ar-tab-top">
                  <i className="ar-tab-swatch" aria-hidden="true"/>
                  <span className="ar-tab-title">{t.title}</span>
                  <span className="ar-tab-count">{n}</span>
                  {t.allExample && <Badge tone="example">EXAMPLE</Badge>}
                </span>
                {(t.owner || t.closed || t.silentForS !== null) && (
                  <span className="ar-tab-sub">
                    {t.owner && <span className={`ar-tab-owner${t.leaseLapsed ? ' is-lapsed' : ''}`}>{t.leaseLapsed ? `lease lapsed · was ${t.owner}` : `owned by ${t.owner}`}</span>}
                    {t.closed && <span className="ar-tab-state">{t.workflowStage === 'escalated' ? 'needs a human' : 'done'}</span>}
                    {t.silentForS !== null && <span className="ar-tab-silent">silent for {t.silentForS}s</span>}
                  </span>
                )}
              </button>
            );
          })}
          {travel && (
            <span key={travel.id} className="ar-travel" aria-hidden="true" style={{ top: travel.y, left: Math.min(travel.x0, travel.x1), width: Math.abs(travel.x1 - travel.x0), ['--ar-dir' as string]: travel.x1 >= travel.x0 ? 1 : -1, ['--ar-span' as string]: `${Math.abs(travel.x1 - travel.x0)}px` }}>
              <i className="ar-travel-line"/><i className="ar-travel-dot" style={{ left: travel.x1 >= travel.x0 ? 0 : 'auto', right: travel.x1 >= travel.x0 ? 'auto' : 0 }}/>
            </span>
          )}
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
              return <Bubble key={item.id} bubble={item} fresh={isFresh(item.id)} handoffFresh={next ? isFresh(next.id) : false} showExample={!active.allExample} showHandoff={active.id !== AGENTS_THREAD_ID}/>;
            })}
          </ol>
        )}
      </div>
    </Panel>
  );
}
