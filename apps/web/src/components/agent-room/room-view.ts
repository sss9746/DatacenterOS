// Pure derivation of the Agent room: threads (one per workflow), bubbles with seat + handoff, resume dividers and
// seat states. Everything is read from persisted events / workflow rows; nothing is estimated or fabricated.

import type { AgentEventInput, ToolCallSummary, WorkflowRecord } from '@dcos/db-client';
import type { Incident } from '@dcos/contracts';
import { resumeEvidence } from '../workflows/workflow-view';
import { RESUME_SUMMARY_RE, SEATS, seatOf, type Seat } from './seat-of';

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
  simTimeMs: number;
  observedUnixMs: number;
}

export interface Divider { kind: 'divider'; id: string; text: string; simTimeMs: number }
export type StreamItem = Bubble | Divider;

export interface Thread {
  id: string;
  title: string;
  accent: 'a' | 'b' | 'run';
  workflowStage: WorkflowRecord['stage'] | null;
  closed: boolean;
  items: StreamItem[];
  lastObservedUnixMs: number | null;
  /** Seconds since the last event when the thread is open and quiet; null otherwise (and always null in example mode). */
  silentForS: number | null;
}

export type SeatState = 'idle' | 'thinking' | 'done';

export interface RoomView {
  threads: Thread[];
  seatStates: Record<Seat, SeatState>;
  counts: { events: number; nemotron: number; code: number; unattributed: number };
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

  let wfIndex = 0;
  const threads: Thread[] = [];
  for (const [id, list] of groups) {
    const wf = id === RUN_THREAD_ID ? null : workflows.find((w) => w.workflow_id === id) ?? null;
    const accent: Thread['accent'] = id === RUN_THREAD_ID ? 'run' : wfIndex++ % 2 === 0 ? 'a' : 'b';
    const seats = list.map(seatOf);
    const bubbles: Bubble[] = list.map((e, i) => {
      const { text, example: ex } = boundSummary(e.summary);
      const next = seats[i + 1] ?? null;
      return {
        kind: 'bubble', id: e.agent_event_id, seat: seats[i]!, stage: e.stage, summary: text, example: ex,
        blocked: /\bBLOCKED\b/.test(e.summary), toolCalls: e.tool_calls, handoffTo: next !== null && next !== seats[i] ? next : null,
        simTimeMs: e.sim_time_ms, observedUnixMs: e.observed_unix_ms,
      };
    });

    const items: StreamItem[] = [];
    const resumed = wf ? resumeEvidence(list, wf.state) : null;
    const anchor = resumed ? resumeAnchorIndex(list, resumed.event_id, resumed.sim_time_ms) : -1;
    bubbles.forEach((b, i) => {
      if (resumed && i === anchor) items.push({ kind: 'divider', id: `${id}-resume-${resumed.event_id}`, text: resumeDividerText(resumed), simTimeMs: resumed.sim_time_ms });
      items.push(b);
    });
    if (resumed && anchor === bubbles.length) items.push({ kind: 'divider', id: `${id}-resume-${resumed.event_id}`, text: resumeDividerText(resumed), simTimeMs: resumed.sim_time_ms });

    const last = list.at(-1) ?? null;
    const closed = id === RUN_THREAD_ID ? false : isClosed(wf?.stage ?? null);
    const quietMs = last ? nowUnixMs - last.observed_unix_ms : 0;
    // In the recovery example the clocks are frozen, so "silent" would be a misleading claim: suppressed when example.
    const silentForS = !example && last && !closed && id !== RUN_THREAD_ID && quietMs > SILENT_AFTER_MS ? Math.floor(quietMs / 1000) : null;
    threads.push({ id, title: id === RUN_THREAD_ID ? 'Run' : threadTitle(id, workflows, incidents), accent, workflowStage: wf?.stage ?? null, closed, items, lastObservedUnixMs: last?.observed_unix_ms ?? null, silentForS });
  }

  // Seat states.
  const seatStates = Object.fromEntries([...SEATS.map((s) => s.id), 'unattributed'].map((s) => [s, 'idle'])) as Record<Seat, SeatState>;
  for (const s of sorted.map(seatOf)) seatStates[s] = 'done';
  const openThreads = threads.filter((t) => !t.closed && t.id !== RUN_THREAD_ID);
  if (example) {
    const active = openThreads.at(-1) ?? threads.filter((t) => t.id !== RUN_THREAD_ID).at(-1);
    const lastBubble = active?.items.filter((i): i is Bubble => i.kind === 'bubble').at(-1);
    if (lastBubble) seatStates[lastBubble.seat] = 'thinking';
  } else {
    for (const t of openThreads) {
      const lastBubble = t.items.filter((i): i is Bubble => i.kind === 'bubble').at(-1);
      if (lastBubble && nowUnixMs - lastBubble.observedUnixMs < THINKING_WITHIN_MS) seatStates[lastBubble.seat] = 'thinking';
    }
  }

  const counts = {
    events: sorted.length,
    nemotron: sorted.filter((e) => e.actor === 'nemotron').length,
    code: sorted.filter((e) => e.actor === 'code').length,
    unattributed: sorted.filter((e) => !e.actor).length,
  };
  return { threads, seatStates, counts };
}

export const seatLabelArrow = (from: Seat, to: Seat): string => `${from.toUpperCase()} → ${to.toUpperCase()}`;
