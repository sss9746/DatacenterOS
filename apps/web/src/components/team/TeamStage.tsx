import { useEffect, useRef, useState } from 'react';
import { Badge } from '../ui/panel';
import { ROLE_LABEL, partyLabel, type NodeState, type TeamEdge, type TeamParty, type TeamRole, type TeamRoundView } from './team-view';
import './team.css';

/** Mirrors Lane B's `PageProps.recorded`; read defensively until it lands. */
export interface RecordedInfo { model: string | null; date: string; db: string; timing: 'replay' | 'recorded' }

// Geometry in viewBox units (300 × 376). Agents on top, the code gate below them, the coordinator last.
const VIEW_W = 300;
const VIEW_H = 376;
type Box = { cx: number; cy: number; w: number; h: number };
const BOX: Record<TeamRole | 'gate' | 'coordinator', Box> = {
  cooling: { cx: 72, cy: 46, w: 128, h: 66 },
  workload: { cx: 228, cy: 46, w: 128, h: 66 },
  lead: { cx: 150, cy: 150, w: 128, h: 66 },
  gate: { cx: 150, cy: 258, w: 284, h: 54 },
  coordinator: { cx: 150, cy: 346, w: 180, h: 44 },
};
type Pt = [number, number];
/** One straight line per unordered pair, written from the first party to the second. */
const PAIR: Record<string, [Pt, Pt]> = {
  'cooling|workload': [[136, 38], [164, 38]],
  'cooling|lead': [[100, 79], [122, 117]],
  'workload|lead': [[200, 79], [178, 117]],
  'lead|supervisor': [[150, 183], [150, 231]],
  'cooling|supervisor': [[24, 79], [24, 231]],
  'workload|supervisor': [[276, 79], [276, 231]],
};
const REVERSE_OFFSET = 14;

/** Endpoints for a directed edge, or null when the pair has no place on the stage (the transcript still lists it). */
export function edgeLine(from: TeamParty, to: TeamParty): [Pt, Pt] | null {
  const fwd = PAIR[`${from}|${to}`];
  if (fwd) return fwd;
  const rev = PAIR[`${to}|${from}`];
  if (!rev) return null;
  // Reverse direction: same line, shifted sideways so both directions stay visible.
  const [[x0, y0], [x1, y1]] = rev;
  const len = Math.hypot(x1 - x0, y1 - y0) || 1;
  const nx = (-(y1 - y0) / len) * REVERSE_OFFSET;
  const ny = ((x1 - x0) / len) * REVERSE_OFFSET;
  return [[x1 + nx, y1 + ny], [x0 + nx, y0 + ny]];
}

const STATE_CLASS: Record<NodeState, string> = {
  thinking: 'is-thinking', done: 'is-done', timed_out: 'is-failed', rejected: 'is-failed', failed: 'is-failed',
  covering: 'is-covering', missing: 'is-failed', idle: 'is-idle', not_called: 'is-idle',
};

const TRAVEL_MS = 1400;

/** Message edges that gained a message since the last render of the same round. First paint of a round animates nothing. */
function useFreshEdges(round: TeamRoundView): Set<string> {
  const seenRef = useRef(new Map<string, Set<string>>());
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    const ids = round.messages.map((m) => m.id);
    const seen = seenRef.current.get(round.key);
    if (!seen) { seenRef.current.set(round.key, new Set(ids)); setFresh(new Set()); return; }
    const added = ids.filter((id) => !seen.has(id));
    if (!added.length) return;
    for (const id of added) seen.add(id);
    setFresh(new Set(round.edges.filter((e) => e.messageIds.some((id) => added.includes(id))).map((e) => e.key)));
    const timer = window.setTimeout(() => setFresh(new Set()), TRAVEL_MS + 400);
    return () => window.clearTimeout(timer);
  }, [round]);
  return fresh;
}

const EDGE_WORD: Record<TeamEdge['consumption'], string> = { consumed: 'consumed', none: 'not consumed', partial: 'partly consumed', code: 'to code' };

function nodeTag(model: string | null): string {
  return model && /nemotron/i.test(model) ? 'NEMOTRON' : 'MODEL';
}

function AgentNode({ role, round }: { role: TeamRole; round: TeamRoundView }) {
  const b = BOX[role];
  const node = round.nodes[role];
  const x = b.cx - b.w / 2;
  const y = b.cy - b.h / 2;
  const cover = node.coveredBy ? `covered by ${ROLE_LABEL[node.coveredBy]}` : node.coveredFor.length ? `${node.state === 'covering' ? 'for' : 'covered'} ${node.coveredFor.map((r) => ROLE_LABEL[r]).join(', ')}` : null;
  return <g className={`ts-node ts-agent ${STATE_CLASS[node.state]}`} data-role={role} data-state={node.state}>
    {node.state === 'thinking' || node.state === 'covering' ? <rect className="ts-pulse" x={x} y={y} width={b.w} height={b.h} rx={8}/> : null}
    <rect className="ts-box" x={x} y={y} width={b.w} height={b.h} rx={8}/>
    <text className="ts-tag ts-tag-model" x={x + 10} y={y + 14}>{nodeTag(round.model)}</text>
    <text className="ts-name" x={x + 10} y={y + 31}>{ROLE_LABEL[role]}</text>
    <text className="ts-state" x={x + 10} y={y + 46}>{node.stateLabel}</text>
    {cover && <text className="ts-cover" x={x + 10} y={y + 60}>{cover}</text>}
  </g>;
}

function gateLine(round: TeamRoundView): string {
  if (round.outcome === 'lead') return 'checks the Lead’s choice; findings only inform';
  if (round.outcome === 'deterministic') return 'Lead choice not used; code chose';
  if (round.status === 'running') return 'waiting for a choice to check';
  return 'no choice recorded for this round';
}

export interface TeamStageProps {
  round: TeamRoundView;
  mode: 'mock' | 'live';
  example: boolean;
  recorded: RecordedInfo | null;
}

/** The team round as a stage: three agents propose, the code gate checks, the coordinator acts. */
export function TeamStage({ round, mode, example, recorded }: TeamStageProps) {
  const fresh = useFreshEdges(round);
  const g = BOX.gate;
  const c = BOX.coordinator;
  const drawn = round.edges.map((e) => ({ e, line: edgeLine(e.from, e.to) })).filter((x): x is { e: TeamEdge; line: [Pt, Pt] } => x.line !== null);
  const summary = `Team round ${round.label}. ${(['cooling', 'workload', 'lead'] as const).map((r) => `${ROLE_LABEL[r]}: ${round.nodes[r].label}`).join('. ')}. Code safety gate: ${gateLine(round)}. Decided by ${round.decider}.`;
  const callsPct = Math.min(1, round.callsUsed / Math.max(1, round.budget.maxCalls));
  const wallPct = Math.min(1, round.wallMs / Math.max(1, round.budget.roundMs));
  return <div className={`ts-stage ts-status-${round.status}`}>
    <div className="ts-head">
      <p className="ts-rule">Findings inform. Code decides.</p>
      <span className="ts-badges">
        <RoundStatus round={round}/>
        {mode === 'live' ? <Badge tone="neutral">LIVE DB</Badge> : <Badge tone="mock">MOCK</Badge>}
        {example && <Badge tone="example">EXAMPLE</Badge>}
        {recorded && <Badge tone="example" title={`Recorded run · model ${recorded.model ?? 'not recorded'} · ${recorded.date} · database ${recorded.db}`}>RECORDED</Badge>}
      </span>
    </div>
    {recorded && <p className="ts-recorded">Recorded run · {recorded.model ?? 'model not recorded'} · {recorded.date} · <code>{recorded.db}</code>{recorded.timing === 'replay' ? ' · replay pacing, not recorded timing' : ''}</p>}
    <svg className="ts-svg" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-label={summary}>
      <defs>
        <marker id="ts-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" className="ts-arrowhead"/></marker>
      </defs>
      {drawn.map(({ e, line: [[x0, y0], [x1, y1]] }) => <g key={e.key} className={`ts-edge ts-edge-${e.consumption}${fresh.has(e.key) ? ' is-new' : ''}`} data-edge={e.key}>
        <line x1={x0} y1={y0} x2={x1} y2={y1} markerEnd="url(#ts-arrow)"/>
        {e.messageIds.length > 1 && <text className="ts-edge-count" x={(x0 + x1) / 2 + 5} y={(y0 + y1) / 2 - 3}>{e.messageIds.length}</text>}
        {fresh.has(e.key) && <circle className="ts-dot" r={4} cx={0} cy={0} style={{ '--x0': `${x0}px`, '--y0': `${y0}px`, '--x1': `${x1}px`, '--y1': `${y1}px` } as React.CSSProperties}/>}
      </g>)}
      {(['cooling', 'workload', 'lead'] as const).map((r) => <AgentNode key={r} role={r} round={round}/>)}
      <g className={`ts-node ts-gate ${round.outcome ? 'is-done' : 'is-idle'}`}>
        <rect className="ts-box" x={g.cx - g.w / 2} y={g.cy - g.h / 2} width={g.w} height={g.h} rx={3}/>
        <text className="ts-name" x={g.cx - g.w / 2 + 12} y={g.cy - 5}>Code safety gate</text>
        <text className="ts-tag ts-tag-code" x={g.cx + g.w / 2 - 12} y={g.cy - 6} textAnchor="end">CODE</text>
        <text className="ts-state" x={g.cx - g.w / 2 + 12} y={g.cy + 13}>{gateLine(round)}</text>
      </g>
      <g className="ts-edge ts-edge-structural"><line x1={150} y1={285} x2={150} y2={324} markerEnd="url(#ts-arrow)"/><text className="ts-edge-label" x={158} y={309}>code decides</text></g>
      <g className="ts-node ts-coord">
        <rect className="ts-box" x={c.cx - c.w / 2} y={c.cy - c.h / 2} width={c.w} height={c.h} rx={8}/>
        <text className="ts-name" x={c.cx - c.w / 2 + 12} y={c.cy - 3}>Coordinator</text>
        <text className="ts-tag ts-tag-code" x={c.cx + c.w / 2 - 12} y={c.cy - 4} textAnchor="end">CODE</text>
        <text className="ts-state" x={c.cx - c.w / 2 + 12} y={c.cy + 13}>writes allowed actions</text>
      </g>
    </svg>
    <ul className="ts-roles" aria-hidden="true">
      {(['cooling', 'workload', 'lead'] as const).map((r) => <li key={r} className={STATE_CLASS[round.nodes[r].state]}><strong>{ROLE_LABEL[r]}</strong> {round.nodes[r].label}</li>)}
    </ul>
    <ul className="ts-legend" aria-label="Edge legend">
      <li><span className="ts-key ts-key-solid" aria-hidden="true"/>recipient’s next input contained it</li>
      <li><span className="ts-key ts-key-dashed" aria-hidden="true"/>not consumed by the recipient</li>
    </ul>
    <div className="ts-budget" aria-label="Round budget">
      <Meter label="Model calls" value={`${round.callsUsed} of ${round.budget.maxCalls}`} pct={callsPct}/>
      <Meter label="Wall time" value={`${(round.wallMs / 1000).toFixed(1)} s of ${Math.round(round.budget.roundMs / 1000)} s`} pct={wallPct}/>
      <div className="ts-decider"><span className="ts-meter-label">Decided by</span><strong className={round.outcome === 'lead' ? 'ts-decider-lead' : 'ts-decider-code'}>{round.decider}</strong></div>
    </div>
    <p className="ts-foot">{round.budget.source === 'default' ? 'Budget not persisted with this trace; shown against the agent’s default (6 calls, 30 s). ' : ''}{round.timing === 'not recorded' ? 'Per-call timing not recorded (v1 trace): the order is real, the pacing is not.' : 'Per-call timing recorded by the agent.'}{round.model ? <> Model <code>{round.model}</code>.</> : ' Model not recorded.'}</p>
    <ul className="ts-edges" aria-label="Messages between parties">
      {round.edges.map((e) => <li key={e.key}><span>{partyLabel(e.from)} → {partyLabel(e.to)}</span><span className="ts-edges-meta">{e.messageIds.length} {e.messageIds.length === 1 ? 'message' : 'messages'} · {e.kinds.join(', ') || 'kind not recorded'} · {e.consumption === 'partial' ? `${e.notConsumed} not consumed` : EDGE_WORD[e.consumption]}</span></li>)}
    </ul>
  </div>;
}

function Meter({ label, value, pct }: { label: string; value: string; pct: number }) {
  return <div className="ts-meter">
    <span className="ts-meter-label">{label}</span>
    <strong className="ts-meter-value">{value}</strong>
    <span className="ts-meter-track" aria-hidden="true"><span className="ts-meter-fill" style={{ transform: `scaleX(${pct})` }}/></span>
  </div>;
}

function RoundStatus({ round }: { round: TeamRoundView }) {
  if (round.status === 'running') return <Badge tone="agent"><span className="ts-live-dot" aria-hidden="true"/>Running{round.phase ? ` · ${round.phase.replaceAll('_', ' ')}` : ''}</Badge>;
  if (round.status === 'interrupted') return <Badge tone="danger">Interrupted</Badge>;
  if (round.status === 'not_closed') return <Badge tone="warning">Close not recorded</Badge>;
  return <Badge tone="neutral">Closed</Badge>;
}

export interface RoundPickerProps { rounds: TeamRoundView[]; selected: string; onSelect: (roundKey: string) => void; dropped: number }

/** One button per persisted round, oldest first; only shown when more than one round survives. */
export function RoundPicker({ rounds, selected, onSelect, dropped }: RoundPickerProps) {
  if (rounds.length < 2) return dropped > 0 ? <p className="ts-dropped">{dropped} older {dropped === 1 ? 'round was' : 'rounds were'} dropped by the agent (it keeps the last 4).</p> : null;
  return <div className="ts-picker" role="group" aria-label="Choose a team round">
    {rounds.map((r) => <button key={r.key} type="button" className="ts-pick" aria-pressed={r.key === selected} onClick={() => onSelect(r.key)} title={r.roundId}>
      Round {r.label}<span className="ts-pick-meta">{r.status === 'running' ? 'running' : r.status === 'interrupted' ? 'interrupted' : r.covers.length ? 'with cover' : r.decider}</span>
    </button>)}
    {dropped > 0 && <span className="ts-dropped">+{dropped} older dropped</span>}
  </div>;
}
