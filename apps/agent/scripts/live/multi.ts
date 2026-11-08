// Pure helpers for the multi-agent live cases (L7/L8): naming children, mapping lease owners back to agents,
// choosing an isolated GPU from OBSERVED state (never a guessed rack), the message transcript and its checks.
// Nothing here touches the network, the clock or the filesystem; test/live/multi.test.ts covers it.

import type { ObservedSnapshot } from '@dcos/contracts';
import type { ActionDetail, AgentEventInput, WorkflowRecord } from '@dcos/db-client';
import { messagesIn, type AgentMessage, type MessageTopic } from '../../src/agent-messages.js';
import { incidentZone, type Zone } from '../../src/zones.js';
import type { IncidentLink } from '@dcos/contracts';
import { check, intentOf, type Check } from './asserts.js';
import { rackOfGpu } from './faults.js';

export interface AgentIdentity {
  name: string;
  pid: number;
  zone: Zone | null;
}

/** The worker id main.ts derives from AGENT_NAME + pid (config.ts workerIdFor). */
export const workerIdOf = (a: Pick<AgentIdentity, 'name' | 'pid'>): string => `${a.name}-${a.pid}`;

/** Which spawned agent owns a lease (`<name>-<pid>`), or null for an unknown / absent owner. */
export function agentForOwner<A extends Pick<AgentIdentity, 'name' | 'pid'>>(owner: string | null | undefined, agents: readonly A[]): A | null {
  if (!owner) return null;
  return agents.find((a) => workerIdOf(a) === owner) ?? null;
}

/** Demo GPU ids only (`gpu-rN-nM-K`): the real-GPU twin and anything unrecognised are never faulted. */
const DEMO_GPU_RE = /^gpu-r\d+-n\d+-\d+$/;

/**
 * A ready, unallocated, XID-free GPU on a rack that is neither excluded (the pump loop, the planned destination)
 * nor hosting any job, chosen deterministically (lowest id). Null when the observed state offers none.
 */
export function pickIsolatedGpu(snap: ObservedSnapshot, opts: { excludeGpus?: readonly string[]; excludeRacks?: readonly string[] } = {}): string | null {
  const excludedGpus = new Set(opts.excludeGpus ?? []);
  const excludedRacks = new Set(opts.excludeRacks ?? []);
  const allocated = new Set(snap.allocations.map((a) => a.gpu_id));
  for (const j of snap.job_states) for (const g of j.allocated_gpu_ids) allocated.add(g);
  const busyRacks = new Set([...allocated].map((g) => rackOfGpu(g)).filter((r): r is string => r !== null));
  const candidates = snap.gpus
    .filter((g) => DEMO_GPU_RE.test(g.resource_id) && g.availability === 'ready' && (g.last_xid_code === null || g.last_xid_code === undefined))
    .filter((g) => !excludedGpus.has(g.resource_id) && !allocated.has(g.resource_id))
    .filter((g) => {
      const rack = rackOfGpu(g.resource_id);
      return rack !== null && !excludedRacks.has(rack) && !busyRacks.has(rack);
    })
    .map((g) => g.resource_id)
    .sort();
  return candidates[0] ?? null;
}

/** Racks of the given GPU ids (demo id shape), sorted and unique. */
export const racksOf = (gpuIds: readonly string[]): string[] => [...new Set(gpuIds.map(rackOfGpu).filter((r): r is string => r !== null))].sort();

// ------------------------------------------------------------------------------------ ownership

export type OwnerMap = Record<string, string | null>;

/** workflow_id -> lease_owner for every workflow. */
export const workflowOwners = (workflows: readonly WorkflowRecord[]): OwnerMap => Object.fromEntries(workflows.map((w) => [w.workflow_id, w.lease_owner]));

/** Both workflows exist and are non-terminal in the same observed state (overlapping active intervals). */
export function bothActive(workflows: readonly WorkflowRecord[], a: string, b: string): boolean {
  const open = (id: string) => {
    const w = workflows.find((x) => x.workflow_id === id);
    return !!w && w.stage !== 'done' && w.stage !== 'escalated';
  };
  return open(a) && open(b);
}

/** Informational (always ok): who owned what, and whether the work was split across different agents. */
export function checkWorkDistribution(owners: OwnerMap, agents: readonly AgentIdentity[]): Check {
  const byWf = Object.entries(owners).map(([wf, o]) => `${wf} -> ${agentForOwner(o, agents)?.name ?? o ?? 'none'}`);
  const distinct = new Set(Object.values(owners).filter((o): o is string => !!o));
  const split = distinct.size > 1;
  return check('work distribution across agents (informational)', true, `${split ? 'SPLIT' : 'single agent'}: ${byWf.join('; ')}`, { owners, split });
}

/** Two workflows are owned by two DIFFERENT live agents. */
export function checkOwnedByDifferentAgents(owners: OwnerMap, a: string, b: string, agents: readonly AgentIdentity[]): Check {
  const oa = agentForOwner(owners[a], agents);
  const ob = agentForOwner(owners[b], agents);
  const ok = oa !== null && ob !== null && oa.name !== ob.name;
  return check('two workflows owned by two different agents', ok, `${a} -> ${oa?.name ?? owners[a] ?? 'none'}, ${b} -> ${ob?.name ?? owners[b] ?? 'none'}`, { [a]: owners[a] ?? null, [b]: owners[b] ?? null });
}

/** Each incident's workflow is owned by the agent whose zone matches the incident's zone (zones from observed state). */
export function checkZoneAffinity(workflows: readonly WorkflowRecord[], links: readonly IncidentLink[], snap: ObservedSnapshot, agents: readonly AgentIdentity[]): Check {
  const rows: string[] = [];
  let ok = true;
  for (const w of workflows) {
    const inc = w.incident_ids[0];
    const zone = inc ? incidentZone(inc, links, snap) : null;
    const owner = agentForOwner(w.lease_owner, agents);
    const expected = zone ? agents.find((a) => a.zone === zone) : undefined;
    const match = !expected || !owner || owner.name === expected.name;
    if (!match) ok = false;
    rows.push(`${w.workflow_id} zone=${zone ?? '?'} owner=${owner?.name ?? w.lease_owner ?? 'none'}${expected ? ` expected=${expected.name}` : ''}`);
  }
  return check('each incident went to its zone\'s agent', ok, rows.join('; ') || 'no workflows', { rows });
}

// ------------------------------------------------------------------------------------ ledger

/**
 * No two agents acted on the same intent: at most one non-cancelled/failed ledger row per `operation:subject`
 * across ALL workflows (a replan cancels its obsolete row first, so it passes). Distinct retries of one logical
 * step reuse the key (idempotent), so a second row for the same intent is a duplicate submission.
 */
export function checkNoDuplicateIntents(details: readonly ActionDetail[]): Check {
  const live = new Map<string, string[]>();
  for (const d of details) {
    if (d.status.status === 'cancelled' || d.status.status === 'failed') continue;
    const intent = intentOf(d.command.command_key).split(':').slice(1).join(':'); // drop the workflow prefix
    const keys = live.get(intent) ?? [];
    keys.push(d.command.command_key);
    live.set(intent, keys);
  }
  const dups = [...live].filter(([, keys]) => keys.length > 1);
  return check('no duplicate command for one intent across agents', dups.length === 0, dups.length ? dups.map(([i, k]) => `${i}: ${k.join(' + ')}`).join(' | ') : `${details.length} ledger rows, one per intent`, {
    duplicates: Object.fromEntries(dups),
  });
}

// ------------------------------------------------------------------------------------ messages

/** Every agent-to-agent message in the event feed, oldest first. */
export const messageTranscript = (events: readonly AgentEventInput[]): AgentMessage[] =>
  [...events].sort((a, b) => a.sim_time_ms - b.sim_time_ms || a.observed_unix_ms - b.observed_unix_ms).flatMap((e) => messagesIn(e));

/** Every `agent_message` tool call parses (from/to/topic present and a known topic). */
export function checkMessagesWellFormed(events: readonly AgentEventInput[]): Check {
  const raw = events.flatMap((e) => e.tool_calls.filter((t) => t.tool === 'agent_message'));
  const parsed = messageTranscript(events);
  const ok = raw.length === parsed.length && parsed.every((m) => m.from && m.to && m.topic && m.text.length > 0 && m.text.length <= 200);
  return check('all agent messages carry from/to/topic', ok, `${parsed.length}/${raw.length} messages parse${raw.length ? `; topics: ${[...new Set(parsed.map((m) => m.topic))].join(',')}` : ''}`, {
    total: raw.length,
    parsed: parsed.length,
  });
}

/** A message of `topic` from one agent name to another (or broadcast) exists. */
export function findMessages(transcript: readonly AgentMessage[], topic: MessageTopic, from?: string, to?: string): AgentMessage[] {
  return transcript.filter((m) => m.topic === topic && (!from || m.from === from) && (!to || m.to === to || m.to === 'all'));
}

/** A cross_zone_move was answered by another agent (ack or conflict addressed to the sender). */
export function checkMoveAcknowledged(transcript: readonly AgentMessage[]): Check {
  const moves = findMessages(transcript, 'cross_zone_move');
  const replies = transcript.filter((m) => (m.topic === 'ack' || m.topic === 'conflict') && moves.some((mv) => mv.from === m.to && mv.from !== m.from));
  const ok = moves.length > 0 && replies.length > 0;
  return check('cross_zone_move answered with ack/conflict', ok, `${moves.length} move(s) announced, ${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}${replies[0] ? `: ${replies[0].from} ${replies[0].topic} "${replies[0].text.slice(0, 100)}"` : ''}`, {
    moves: moves.map((m) => m.text),
    replies: replies.map((m) => `${m.from} ${m.topic}: ${m.text}`),
  });
}

/** The survivor broadcast a takeover naming the dead worker and the workflow. */
export function checkTakeoverAnnounced(transcript: readonly AgentMessage[], wfId: string, deadWorker: string | null, survivor: string): Check {
  const hits = findMessages(transcript, 'takeover', survivor).filter((m) => m.workflow_id === wfId || m.text.includes(wfId));
  const named = hits.filter((m) => !deadWorker || m.text.includes(deadWorker));
  return check('takeover message after the kill', named.length > 0, named[0] ? `${named[0].from}: ${named[0].text}` : `no takeover message from ${survivor} for ${wfId} (${hits.length} takeover messages seen)`, {
    messages: hits.map((m) => m.text),
  });
}
