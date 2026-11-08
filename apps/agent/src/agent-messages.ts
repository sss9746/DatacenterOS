// Agent-to-agent messages over the existing `agent_event` rows (no new table, no contract change). A message is
// an event whose `tool_calls` carries `{ tool: 'agent_message', args_summary: 'from=<a> to=<b|all> topic=<t>',
// result_summary: <text ≤ 200 chars> }`. Agents subscribe through DbPort.onAgentEvents (optional) and react from
// their REAL state (open incidents, planned destinations, in-flight actions); a message is never a safety input,
// the ledger and evaluateSafety still decide. Facts always come from code; actor is `code` unless the wording came
// from Nemotron. Rate limit: ≤ 1 message per topic per workflow per 5 s; identical bodies are sent once.

import type { AgentEventInput, AgentStage, AgentActor, DbPort, ToolCallSummary } from './ports.js';
import type { EventPublisher } from './events.js';
import type { Zone } from './zones.js';

export const AGENT_MESSAGE_TOOL = 'agent_message';
export const BROADCAST = 'all';
export const MESSAGE_TOPICS = ['cross_zone_move', 'ack', 'conflict', 'incident_update', 'takeover', 'stand_by'] as const;
export type MessageTopic = (typeof MESSAGE_TOPICS)[number];
export const MAX_MESSAGE_CHARS = 200;
export const DEFAULT_MESSAGE_RATE_MS = 5_000;
/** Messages older than this (by the shared clock) are ignored on receipt: a restarted agent never replays history. */
export const DEFAULT_MESSAGE_MAX_AGE_MS = 60_000;
const MAX_REMEMBERED = 500;

export interface AgentMessage {
  event_id: string;
  from: string;
  to: string;
  topic: MessageTopic;
  text: string;
  workflow_id: string | null;
  incident_id: string | null;
  sim_time_ms: number;
  actor: AgentActor;
}

// ---------------------------------------------------------------------------------------------- wire format

export const formatMessageArgs = (from: string, to: string, topic: MessageTopic): string => `from=${from} to=${to} topic=${topic}`;

const ARGS_RE = /^from=(\S+) to=(\S+) topic=(\S+)$/;

export function parseMessageArgs(args: string): { from: string; to: string; topic: MessageTopic } | null {
  const m = ARGS_RE.exec(args.trim());
  if (!m) return null;
  const topic = m[3]!;
  if (!(MESSAGE_TOPICS as readonly string[]).includes(topic)) return null;
  return { from: m[1]!, to: m[2]!, topic: topic as MessageTopic };
}

export const clipMessage = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_MESSAGE_CHARS ? flat : `${flat.slice(0, MAX_MESSAGE_CHARS - 1)}…`;
};

/** Every agent message carried by one event (normally 0 or 1). */
export function messagesIn(ev: AgentEventInput): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const t of ev.tool_calls) {
    if (t.tool !== AGENT_MESSAGE_TOOL) continue;
    const head = parseMessageArgs(t.args_summary);
    if (!head) continue;
    out.push({
      event_id: ev.agent_event_id,
      ...head,
      text: t.result_summary,
      workflow_id: ev.workflow_id,
      incident_id: ev.incident_id,
      sim_time_ms: ev.sim_time_ms,
      actor: t.actor ?? ev.actor ?? 'code',
    });
  }
  return out;
}

/** Addressed to `agentName` (directly or broadcast) and not sent by it. */
export const isAddressedTo = (m: Pick<AgentMessage, 'from' | 'to'>, agentName: string): boolean =>
  m.from !== agentName && (m.to === agentName || m.to === BROADCAST);

/** Agent name of a worker id `<name>-<pid>` (the harness/CLI convention); the id itself when it has no pid suffix. */
export const agentNameOfWorker = (workerId: string): string => workerId.replace(/-\d+$/, '');

// ---------------------------------------------------------------------------------------------- cross-zone moves

export interface MoveAnnouncement {
  job_id: string;
  dest_racks: string[];
  gpu_count: number;
  /** Checkpoint status as the sender knows it: planned | running | complete | none. */
  checkpoint: string;
}

export const formatMove = (a: MoveAnnouncement): string =>
  `move job=${a.job_id} dest_racks=${a.dest_racks.join(',')} gpus=${a.gpu_count} checkpoint=${a.checkpoint}`;

const MOVE_RE = /^move job=(\S+) dest_racks=(\S+) gpus=(\d+) checkpoint=(\S+)$/;

export function parseMove(text: string): MoveAnnouncement | null {
  const m = MOVE_RE.exec(text.trim());
  if (!m) return null;
  return { job_id: m[1]!, dest_racks: m[2]!.split(',').filter(Boolean), gpu_count: Number(m[3]), checkpoint: m[4]! };
}

/** What a receiving agent knows about itself when it answers a cross-zone move (facts from its own live state). */
export interface OwnWorkflowFacts {
  workflow_id: string;
  incident_ids: string[];
  /** Racks of the resources linked to this workflow's incidents. */
  incident_racks: string[];
  /** Racks of the destination GPUs in this workflow's current plan. */
  planned_dest_racks: string[];
  /** Command keys currently claimed/running under this workflow. */
  in_flight: string[];
}

export interface OwnFacts {
  agentName: string;
  zone: Zone | null;
  workflows: OwnWorkflowFacts[];
}

const overlap = (a: readonly string[], b: readonly string[]): string[] => a.filter((x) => b.includes(x)).sort();

/**
 * ack or conflict for an announced move, from the receiver's own facts only. Conflict when the announced racks
 * overlap a destination this agent has planned or in flight. Otherwise ack with what the sender should know
 * (an open incident on those racks), or a plain all-clear. Never a safety verdict: the ledger still decides.
 */
export function respondToMove(move: MoveAnnouncement, own: OwnFacts): { topic: 'ack' | 'conflict'; text: string } {
  for (const w of own.workflows) {
    const hit = overlap(w.planned_dest_racks, move.dest_racks);
    if (hit.length === 0) continue;
    const flight = w.in_flight.length ? `, ${w.in_flight.length} action(s) in flight` : '';
    return { topic: 'conflict', text: clipMessage(`conflict: ${w.workflow_id} already plans a move onto ${hit.join(',')}${flight}; ledger/safety decide`) };
  }
  const warnings: string[] = [];
  for (const w of own.workflows) {
    const hit = overlap(w.incident_racks, move.dest_racks);
    if (hit.length) warnings.push(`open incident ${w.incident_ids[0] ?? w.workflow_id} on ${hit.join(',')}; avoid it`);
  }
  const zone = own.zone ? ` (zone ${own.zone})` : '';
  if (warnings.length) return { topic: 'ack', text: clipMessage(`ack${zone}: ${warnings.join('; ')}`) };
  return { topic: 'ack', text: clipMessage(`ack${zone}: no open incidents or planned moves on ${move.dest_racks.join(',')}`) };
}

// ---------------------------------------------------------------------------------------------- messenger

export interface SendInput {
  topic: MessageTopic;
  to: string;
  text: string;
  stage: AgentStage;
  workflowId?: string | null;
  incidentId?: string | null;
  /** `nemotron` only when the wording came from the model; facts are always code's. */
  actor?: AgentActor;
}

export interface MessengerDeps {
  db: DbPort;
  events: EventPublisher;
  runId: string;
  agentName: string;
  now: () => number;
  log?: (m: string) => void;
  rateLimitMs?: number;
  maxAgeMs?: number;
}

export interface Messenger {
  /** True when the DB port can deliver other agents' events (otherwise this agent only sends). */
  readonly supported: boolean;
  /** Publish a message; null when rate-limited or an exact repeat. Never throws. */
  send(input: SendInput): Promise<AgentMessage | null>;
  /** React to messages addressed to this agent (or broadcast) from other agents. */
  subscribe(handler: (m: AgentMessage) => void | Promise<void>): () => void;
  /** Sent and received messages, oldest first. */
  transcript(): AgentMessage[];
  dispose(): void;
}

export function createMessenger(deps: MessengerDeps): Messenger {
  const { db, events, runId, agentName, now } = deps;
  const log = deps.log ?? (() => undefined);
  const rateLimitMs = deps.rateLimitMs ?? DEFAULT_MESSAGE_RATE_MS;
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MESSAGE_MAX_AGE_MS;
  const lastSent = new Map<string, number>();
  const sentBodies = new Set<string>();
  const seen = new Set<string>();
  const transcript: AgentMessage[] = [];
  const handlers = new Set<(m: AgentMessage) => void | Promise<void>>();
  let unsub: (() => void) | null = null;

  const remember = (set: Set<string>, v: string): void => {
    set.add(v);
    if (set.size > MAX_REMEMBERED) set.delete(set.values().next().value as string);
  };

  async function send(input: SendInput): Promise<AgentMessage | null> {
    const text = clipMessage(input.text);
    const wf = input.workflowId ?? null;
    const rateKey = `${input.topic}|${wf ?? '-'}`;
    const body = `${input.topic}|${input.to}|${wf ?? '-'}|${text}`;
    if (sentBodies.has(body)) return null;
    const last = lastSent.get(rateKey);
    if (last !== undefined && now() - last < rateLimitMs) {
      log(`message ${input.topic} for ${wf ?? '-'} rate-limited`);
      return null;
    }
    lastSent.set(rateKey, now());
    remember(sentBodies, body);
    const actor: AgentActor = input.actor ?? 'code';
    const call: ToolCallSummary = { tool: AGENT_MESSAGE_TOOL, args_summary: formatMessageArgs(agentName, input.to, input.topic), result_summary: text, actor };
    try {
      const ev = await events.emit(input.stage, {
        workflowId: wf,
        incidentId: input.incidentId ?? null,
        summary: `${agentName} → ${input.to} [${input.topic}] ${text}`,
        actor,
        toolCalls: [call],
      });
      const m: AgentMessage = { event_id: ev.agent_event_id, from: agentName, to: input.to, topic: input.topic, text, workflow_id: wf, incident_id: input.incidentId ?? null, sim_time_ms: ev.sim_time_ms, actor };
      transcript.push(m);
      return m;
    } catch (e) {
      log(`message ${input.topic} failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  function deliver(list: AgentEventInput[]): void {
    for (const ev of list) {
      if (seen.has(ev.agent_event_id)) continue;
      remember(seen, ev.agent_event_id);
      if (ev.run_id !== runId) continue;
      if (now() - ev.observed_unix_ms > maxAgeMs) continue;
      for (const m of messagesIn(ev)) {
        if (!isAddressedTo(m, agentName)) continue;
        transcript.push(m);
        for (const h of handlers) {
          try {
            void Promise.resolve(h(m)).catch((e: unknown) => log(`message handler failed: ${e instanceof Error ? e.message : String(e)}`));
          } catch (e) {
            log(`message handler failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }
  }

  const supported = typeof db.onAgentEvents === 'function';

  function subscribe(handler: (m: AgentMessage) => void | Promise<void>): () => void {
    handlers.add(handler);
    if (supported && !unsub) unsub = db.onAgentEvents!((list) => deliver(list));
    return () => {
      handlers.delete(handler);
    };
  }

  return {
    supported,
    send,
    subscribe,
    transcript: () => [...transcript],
    dispose: () => {
      unsub?.();
      unsub = null;
      handlers.clear();
    },
  };
}
