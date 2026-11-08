// Pure derivation of the Agent room: threads (one per workflow), bubbles with seat + handoff, resume dividers and
// seat states. Everything is read from persisted events / workflow rows; nothing is estimated or fabricated.

import type { AgentEventInput, ToolCallSummary, WorkflowRecord } from '@dcos/db-client';
import type { Incident } from '@dcos/contracts';
import { resumeEvidence } from '../workflows/workflow-view';
import { RESUME_SUMMARY_RE, SEATS, seatOf, type Seat } from './seat-of';
import { PARTY_LABEL, parseTeamMessage, stripTeamHead, type ParsedTeamMessage } from './team-message';

export const RUN_THREAD_ID = 'run';
export const SUMMARY_MAX = 240;
export const SILENT_AFTER_MS = 10_000;
export const THINKING_WITHIN_MS = 10_000;

export interface Bubble {
  kind: 'bubble';
  id: string;
  seat: Seat;
  stage: AgentEventInput['stage'];
  summary: string;
  example: boolean;
  blocked: boolean;
  toolCalls: ToolCallSummary[];
  handoffTo: Seat | null;
  /** Owning agent process for this event (from the workflow's lease/resume markers); null when not recorded. */
  process: string | null;
  /** Home thread of the event (its workflow). */
  threadId: string;
  /** Present when a tool call is a well-formed `team_message`; the bubble then renders as a cross-agent message. */
  message: TeamMessageView | null;
  simTimeMs: number;
  observedUnixMs: number;
}

export interface Divider { kind: 'divider'; id: string; text: string; simTimeMs: number }
export type StreamItem = Bubble | Divider;

export const AGENTS_THREAD_ID = 'agents';
/** One agent-team message between Cooling, Workload, Lead and the Supervisor, as persisted in the feed row. */
export interface TeamMessageView extends ParsedTeamMessage {
  fromLabel: string;
  toLabel: string;
  /** Seats the route maps to (the room's travel dot runs between them). */
  fromSeat: Seat;
  toSeat: Seat;
  /** The feed summary without its `Cooling → Workload: ` head; the agent clips it, so it may end in `…`. */
  text: string;
  /** Persisted result: `consumed by …` or `not consumed`. Null when the row recorded neither. */
  consumption: string | null;
  /** True when the row says nobody's next model input contained this message. */
  notConsumed: boolean;
}

export interface Thread {
  id: string;
  title: string;
  accent: 'a' | 'b' | 'run' | 'agents';
  workflowStage: WorkflowRecord['stage'] | null;
  closed: boolean;
  items: StreamItem[];
  lastObservedUnixMs: number | null;
  /** True when every event in the thread carries the "Example:" prefix (the EXAMPLE chip then sits on the tab, not on bubbles). */
  allExample: boolean;
  /** Owning process from `workflow.lease_owner` only; null when absent. */
  owner: string | null;
  /** True when the lease expiry is in the past and the workflow is still open. */
  leaseLapsed: boolean;
  /** Seconds since the last event when the thread is open and quiet; null otherwise (and always null in example mode). */
  silentForS: number | null;
}

export type SeatState = 'idle' | 'thinking' | 'done';

export interface RoomView {
  threads: Thread[];
  seatStates: Record<Seat, SeatState>;
  counts: { events: number; nemotron: number; code: number; unattributed: number; processes: number };
}

export interface RoomInput {
  events: readonly AgentEventInput[];
  workflows: readonly WorkflowRecord[];
  incidents: readonly Incident[];
  nowUnixMs: number;
  example: boolean;
}

const EXAMPLE_PREFIX = /^Example:\s*/;

export function boundSummary(raw: string): { text: string; example: boolean } {
  const example = EXAMPLE_PREFIX.test(raw);
  const text = raw.replace(EXAMPLE_PREFIX, '').trim();
  return { text: text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : text, example };
}

export function resumeDividerText(e: { by_worker: string | null; count: number | null }): string {
  const who = e.by_worker ?? 'a new worker';
  const n = e.count !== null ? ` (#${e.count})` : '';
  return `Agent process stopped → new process resumed by ${who}${n}, reconciling…`;
}

/** `agent-alpha-12345` → `agent-alpha`; strips one trailing numeric pid segment. Null for null/empty. */
export function processName(workerId: string | null | undefined): string | null {
  if (!workerId) return null;
  const name = workerId.replace(/@[a-z0-9_-]+$/i, '').replace(/-\d+$/, '');
  return name || null;
}

export interface ResumeMarker { previous_owner: string | null; by_worker: string | null; at_sim_time_ms: number }

/** The persisted `state.resumed` marker (resume.ts shape) when its fields are well-typed; otherwise null. */
export function readResumeMarker(state: Record<string, unknown>): ResumeMarker | null {
  const m = state.resumed;
  if (!m || typeof m !== 'object') return null;
  const r = m as Record<string, unknown>;
  const at = typeof r.at_sim_time_ms === 'number' ? r.at_sim_time_ms : null;
  if (at === null) return null;
  const by = typeof r.by_worker === 'string' ? r.by_worker : null;
  const prev = typeof r.previous_owner === 'string' ? r.previous_owner : null;
  return { previous_owner: prev, by_worker: by, at_sim_time_ms: at };
}

/** Takeover wording only when two different processes are both recorded; otherwise the plain resume text. */
export function dividerText(resumed: { by_worker: string | null; count: number | null; previous_owner: string | null }): string {
  const prev = processName(resumed.previous_owner);
  const next = processName(resumed.by_worker);
  if (prev && next && prev !== next) {
    const n = resumed.count !== null ? `, #${resumed.count}` : '';
    return `${prev} stopped → ${next} took over (lease reclaimed${n}), reconciling…`;
  }
  return resumeDividerText(resumed);
}

/** `team_message` call → view model; anything else (or a malformed route) → null. */
export function teamMessageView(call: ToolCallSummary, summary: string): TeamMessageView | null {
  const parsed = parseTeamMessage(call);
  if (!parsed) return null;
  const consumption = /^(?:consumed by .+|not consumed)$/.test(call.result_summary.trim()) ? call.result_summary.trim() : null;
  return {
    ...parsed, fromLabel: PARTY_LABEL[parsed.from], toLabel: PARTY_LABEL[parsed.to], fromSeat: parsed.from, toSeat: parsed.to,
    text: stripTeamHead(summary), consumption, notConsumed: consumption === 'not consumed',
  };
}

/** Which process owned an event: before the resume marker → previous_owner, at/after → by_worker; no marker → lease_owner. */
export function processOfEvent(simTimeMs: number, marker: ResumeMarker | null, leaseOwner: string | null): string | null {
  return processName(workerOfEvent(simTimeMs, marker, leaseOwner));
}
export function workerOfEvent(simTimeMs: number, marker: ResumeMarker | null, leaseOwner: string | null): string | null {
  if (marker) return simTimeMs < marker.at_sim_time_ms ? marker.previous_owner : marker.by_worker;
  return leaseOwner;
}

const isClosed = (stage: WorkflowRecord['stage'] | null): boolean => stage === 'done' || stage === 'escalated';

/**
 * Where the resume divider goes: before the evidence event itself when the evidence is an event; otherwise before the
 * first resume-summary event at/after the persisted marker time (the pre-resume event often shares that sim time);
 * otherwise before the first event at/after it; otherwise at the end.
 */
export function resumeAnchorIndex(events: readonly AgentEventInput[], evidenceEventId: string, atSimMs: number): number {
  const byId = events.findIndex((e) => e.agent_event_id === evidenceEventId);
  if (byId >= 0) return byId;
  const bySummary = events.findIndex((e) => e.sim_time_ms >= atSimMs && RESUME_SUMMARY_RE.test(e.summary));
  if (bySummary >= 0) return bySummary;
  const byTime = events.findIndex((e) => e.sim_time_ms >= atSimMs);
  return byTime >= 0 ? byTime : events.length;
}

function threadTitle(workflowId: string, workflows: readonly WorkflowRecord[], incidents: readonly Incident[]): string {
  const wf = workflows.find((w) => w.workflow_id === workflowId);
  const title = wf?.incident_ids.map((id) => incidents.find((i) => i.incident_id === id)?.title).find((t): t is string => Boolean(t));
  return title ?? workflowId;
}

export function buildRoomView(input: RoomInput): RoomView {
  const { events, workflows, incidents, nowUnixMs, example } = input;
  const sorted = [...events].sort((a, b) => a.sim_time_ms - b.sim_time_ms || a.observed_unix_ms - b.observed_unix_ms);

  // Group by workflow, ordered by first event.
  const groups = new Map<string, AgentEventInput[]>();
  for (const e of sorted) {
    const key = e.workflow_id ?? RUN_THREAD_ID;
    const list = groups.get(key);
    if (list) list.push(e); else groups.set(key, [e]);
  }

  // A team message only renders as one when the persisted actor matches its seat (seatOf); otherwise it stays a plain bubble.
  const messageOf = (e: AgentEventInput, seat: Seat, text: string): TeamMessageView | null => {
    for (const call of e.tool_calls) {
      const view = teamMessageView(call, text);
      if (view) return view.fromSeat === seat ? view : null;
    }
    return null;
  };

  let wfIndex = 0;
  const threads: Thread[] = [];
  for (const [id, list] of groups) {
    const wf = id === RUN_THREAD_ID ? null : workflows.find((w) => w.workflow_id === id) ?? null;
    const accent: Thread['accent'] = id === RUN_THREAD_ID ? 'run' : wfIndex++ % 2 === 0 ? 'a' : 'b';
    const seats = list.map(seatOf);
    const marker = wf ? readResumeMarker(wf.state) : null;
    const leaseOwner = wf?.lease_owner ?? null;
    const bubbles: Bubble[] = list.map((e, i) => {
      const { text, example: ex } = boundSummary(e.summary);
      const next = seats[i + 1] ?? null;
      return {
        kind: 'bubble', id: e.agent_event_id, seat: seats[i]!, stage: e.stage, summary: text, example: ex,
        blocked: /\bBLOCKED\b/.test(e.summary), toolCalls: e.tool_calls, handoffTo: next !== null && next !== seats[i] ? next : null,
        process: wf ? processOfEvent(e.sim_time_ms, marker, leaseOwner) : null, threadId: id, message: messageOf(e, seats[i]!, text),
        simTimeMs: e.sim_time_ms, observedUnixMs: e.observed_unix_ms,
      };
    });

    const items: StreamItem[] = [];
    const resumed = wf ? resumeEvidence(list, wf.state) : null;
    const anchor = resumed ? resumeAnchorIndex(list, resumed.event_id, resumed.sim_time_ms) : -1;
    bubbles.forEach((b, i) => {
      if (resumed && i === anchor) items.push({ kind: 'divider', id: `${id}-resume-${resumed.event_id}`, text: dividerText(resumed), simTimeMs: resumed.sim_time_ms });
      items.push(b);
    });
    if (resumed && anchor === bubbles.length) items.push({ kind: 'divider', id: `${id}-resume-${resumed.event_id}`, text: dividerText(resumed), simTimeMs: resumed.sim_time_ms });

    const last = list.at(-1) ?? null;
    const closed = id === RUN_THREAD_ID ? false : isClosed(wf?.stage ?? null);
    const quietMs = last ? nowUnixMs - last.observed_unix_ms : 0;
    // In the recovery example the clocks are frozen, so "silent" would be a misleading claim: suppressed when example.
    const silentForS = !example && last && !closed && id !== RUN_THREAD_ID && quietMs > SILENT_AFTER_MS ? Math.floor(quietMs / 1000) : null;
    const owner = processName(leaseOwner);
    const leaseLapsed = wf !== null && owner !== null && !closed && wf.lease_expires_unix_ms < nowUnixMs;
    threads.push({ id, title: id === RUN_THREAD_ID ? 'Run' : threadTitle(id, workflows, incidents), accent, workflowStage: wf?.stage ?? null, closed, items, lastObservedUnixMs: last?.observed_unix_ms ?? null, allExample: bubbles.length > 0 && bubbles.every((b) => b.example), owner, leaseLapsed, silentForS });
  }

  // Shared "Between agents" lane: only agent-team messages, across all workflows, in time order.
  const crossAgent = threads.flatMap((t) => t.items.filter((i): i is Bubble => i.kind === 'bubble' && i.message !== null)).sort((a, b) => a.simTimeMs - b.simTimeMs || a.observedUnixMs - b.observedUnixMs);
  if (crossAgent.length) {
    const items: StreamItem[] = [...crossAgent];
    threads.push({ id: AGENTS_THREAD_ID, title: 'Team ↔', accent: 'agents', workflowStage: null, closed: false, items, lastObservedUnixMs: crossAgent.at(-1)?.observedUnixMs ?? null, allExample: crossAgent.every((b) => b.example), owner: null, leaseLapsed: false, silentForS: null });
  }

  // Seat states.
  const seatStates = Object.fromEntries([...SEATS.map((s) => s.id), 'unattributed'].map((s) => [s, 'idle'])) as Record<Seat, SeatState>;
  for (const s of sorted.map(seatOf)) seatStates[s] = 'done';
  const openThreads = threads.filter((t) => !t.closed && t.id !== RUN_THREAD_ID && t.id !== AGENTS_THREAD_ID);
  if (example) {
    const active = openThreads.at(-1) ?? threads.filter((t) => t.id !== RUN_THREAD_ID && t.id !== AGENTS_THREAD_ID).at(-1);
    const lastBubble = active?.items.filter((i): i is Bubble => i.kind === 'bubble').at(-1);
    if (lastBubble) seatStates[lastBubble.seat] = 'thinking';
  } else {
    for (const t of openThreads) {
      const lastBubble = t.items.filter((i): i is Bubble => i.kind === 'bubble').at(-1);
      if (lastBubble && nowUnixMs - lastBubble.observedUnixMs < THINKING_WITHIN_MS) seatStates[lastBubble.seat] = 'thinking';
    }
  }

  const processes = new Set<string>();
  for (const t of threads) {
    const wf = workflows.find((w) => w.workflow_id === t.id);
    if (!wf) continue;
    const marker = readResumeMarker(wf.state);
    for (const n of [processName(wf.lease_owner), processName(marker?.previous_owner), processName(marker?.by_worker)]) if (n) processes.add(n);
  }
  const counts = {
    processes: processes.size,
    events: sorted.length,
    nemotron: sorted.filter((e) => e.actor === 'nemotron').length,
    code: sorted.filter((e) => e.actor === 'code').length,
    unattributed: sorted.filter((e) => !e.actor).length,
  };
  return { threads, seatStates, counts };
}

export const seatLabelArrow = (from: Seat, to: Seat): string => `${from.toUpperCase()} → ${to.toUpperCase()}`;
