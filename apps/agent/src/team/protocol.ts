// Agent-team protocol (plans/MULTI-AGENT-HACKATHON-PLAN.md §0): trace types, specialist tool-argument schemas,
// bounding helpers and the feed projection. Models supply content only; routing and identity come from code.

import { z } from 'zod';
import { MAX_SUMMARY_CHARS } from '../events.js';
import type { AgentActor, AgentStage, ToolCallSummary } from '../ports.js';

export const TEAM_ROLES = ['cooling', 'workload', 'lead'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export type TeamParty = TeamRole | 'supervisor';
export type TeamMessageKind = 'question' | 'answer' | 'finding' | 'objection' | 'cover' | 'decision';

export interface TeamMessage {
  id: string;
  round_id: string;
  from: TeamParty;
  to: TeamParty;
  kind: TeamMessageKind;
  reply_to: string | null;
  summary: string; // at most 400 characters
  evidence_ids: string[]; // at most 12
  resource_ids: string[]; // at most 12
  /** Roles whose next model input contained this message. Empty means nobody consumed it. */
  consumed_by: TeamRole[];
  /** v2: wall ms from round start to when code posted the message. Absent on v1 traces. */
  t_ms?: number;
}

/** v2: where the round is. `closed` only on a finished trace. */
export type TeamPhase = 'findings' | 'peer_answers' | 'cover' | 'decide' | 'closed';
export type TeamCallStatus = 'running' | 'ok' | 'timeout' | 'rejected' | 'failed';

/**
 * v2: one model call. Times are wall ms from round start. `ok` = a reply arrived and code accepted it; `rejected` =
 * a reply arrived but code refused it (no or invalid tool call, unknown citations); `timeout` = no reply in time;
 * `failed` = the request errored. A breaker-open request never reached a model and is not recorded.
 */
export interface TeamCall {
  role: TeamRole;
  phase: TeamPhase;
  started_ms: number;
  ended_ms: number | null;
  status: TeamCallStatus;
}

export type TeamTraceStatus = 'running' | 'closed' | 'interrupted';

export interface TeamTrace {
  /** 1 = written before live progress existed (no v2 fields); 2 = every trace written now. */
  version: 1 | 2;
  round_id: string; // `${workflowId}:a${attempt}:e${decision_epoch}`
  snapshot_sim_ms: number;
  model: string | null;
  calls_used: number;
  wall_ms: number;
  /** 'lead' = the Lead's choices were used; 'deterministic' = choices was null. */
  outcome: 'lead' | 'deterministic';
  messages: TeamMessage[]; // at most 24
  covers: { failed_role: TeamRole; covered_by: TeamRole }[];
  missing_roles: TeamRole[];
  // ---- v2 only (optional on the type so v1 traces still parse; every new trace sets them)
  /** `running` while the round is in progress (live progress writes); `interrupted` = the agent died mid-round. */
  status?: TeamTraceStatus;
  phase?: TeamPhase;
  started_unix_ms?: number;
  /** TEAM_BUDGET at the time of the round. */
  budget?: { max_calls: number; round_ms: number; call_timeout_ms: number };
  calls?: TeamCall[]; // at most 12
}

/** `workflow.state.team_rounds`: earlier rounds of this workflow, oldest first. `state.team` is the current one. */
export interface TeamRoundHistory {
  rounds: TeamTrace[]; // at most 4
  /** Older rounds that no longer fit. */
  dropped: number;
}

export interface TeamFeedEvent {
  stage: AgentStage;
  summary: string; // e.g. `Cooling → Workload: ...`
  actor: AgentActor;
  /** The message's cited evidence ids (the agent event's `evidence_ids`); absent when it cites none. */
  evidenceIds?: string[];
  toolCalls: ToolCallSummary[]; // tool name `team_message`
  incidentId?: string;
}

export const TEAM_LIMITS = { summaryChars: 400, evidenceIds: 12, resourceIds: 12, messages: 24, calls: 12, historyRounds: 4 } as const;
export const TEAM_MESSAGE_TOOL = 'team_message';

// ---------------------------------------------------------------------------------------------- tool arguments

const idList = z.array(z.string().min(1));
const text = z.string().trim().min(1);

/**
 * Recorded when a model sets `question_for_peer` to null but gives no reason. The reason is
 * code-authored, never the model's words, so surfaces must not attribute it to the model.
 */
export const NO_QUESTION_REASON_UNSTATED = 'not stated by the model (recorded by code)';

/**
 * `question_for_peer` is required; a null question should say why none is needed. When the reason is
 * missing we record {@link NO_QUESTION_REASON_UNSTATED} instead of rejecting the whole finding: the
 * summary and evidence are still usable by the Lead, and dropping them cost the peer conversation in
 * the 2026-11-08 L3 dev run. A reason the model *did* give is kept verbatim.
 */
export const submitFindingArgsSchema = z
  .object({
    summary: text,
    evidence_ids: idList,
    resource_ids: idList,
    question_for_peer: text.nullable(),
    no_question_reason: text.nullish(),
  })
  .transform((v) => ({
    ...v,
    no_question_reason:
      v.question_for_peer === null ? (v.no_question_reason ?? NO_QUESTION_REASON_UNSTATED) : v.no_question_reason,
  }));
export type SubmitFindingArgs = z.infer<typeof submitFindingArgsSchema>;

export const answerPeerArgsSchema = z.object({
  answer: text,
  evidence_ids: idList,
  resource_ids: idList,
});
export type AnswerPeerArgs = z.infer<typeof answerPeerArgsSchema>;

// ---------------------------------------------------------------------------------------------- bounds

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

export const boundSummary = (s: string, max: number = TEAM_LIMITS.summaryChars): string => clip(s.replace(/\s+/g, ' ').trim(), max);

export const boundIds = (ids: readonly string[], max: number = TEAM_LIMITS.evidenceIds): string[] => [...new Set(ids)].slice(0, max);

export function boundMessage(m: TeamMessage): TeamMessage {
  return {
    ...m,
    summary: boundSummary(m.summary),
    evidence_ids: boundIds(m.evidence_ids, TEAM_LIMITS.evidenceIds),
    resource_ids: boundIds(m.resource_ids, TEAM_LIMITS.resourceIds),
    consumed_by: [...new Set(m.consumed_by)],
  };
}

/** Copies of the most recent calls, at most TEAM_LIMITS.calls. */
export const boundCalls = (calls: readonly TeamCall[]): TeamCall[] => calls.slice(-TEAM_LIMITS.calls).map((c) => ({ ...c }));

/** A copy that holds the persisted limits; only the most recent messages (and calls) are kept. */
export function boundTrace(t: TeamTrace): TeamTrace {
  return {
    ...t,
    messages: t.messages.slice(-TEAM_LIMITS.messages).map(boundMessage),
    ...(t.calls ? { calls: boundCalls(t.calls) } : {}),
    ...(t.budget ? { budget: { ...t.budget } } : {}),
  };
}

// ---------------------------------------------------------------------------------------------- feed

const LABEL: Record<TeamParty, string> = { cooling: 'Cooling', workload: 'Workload', lead: 'Lead', supervisor: 'Supervisor' };

function feedEvent(summary: string, actor: AgentActor, args: string, result: string, incidentId?: string, evidenceIds: readonly string[] = []): TeamFeedEvent {
  return {
    stage: 'plan',
    summary: clip(summary, MAX_SUMMARY_CHARS),
    actor,
    toolCalls: [{ tool: TEAM_MESSAGE_TOOL, args_summary: args, result_summary: result, actor }],
    ...(evidenceIds.length > 0 ? { evidenceIds: [...evidenceIds] } : {}),
    ...(incidentId !== undefined ? { incidentId } : {}),
  };
}

/** `<kind> <from>-><to>` (parsed by the web feed), then ` ev=<id>,<id>` when the message cites evidence. */
export const teamMessageArgs = (m: Pick<TeamMessage, 'kind' | 'from' | 'to' | 'evidence_ids'>): string =>
  `${m.kind} ${m.from}->${m.to}${m.evidence_ids.length > 0 ? ` ev=${m.evidence_ids.join(',')}` : ''}`;

/** One event per message, then code-labelled events for advice that never arrived and for a deterministic outcome. */
export function teamFeedEvents(trace: TeamTrace, incidentId?: string): TeamFeedEvent[] {
  const events = trace.messages.map((m) => {
    const failed = m.kind === 'cover' ? trace.covers.find((c) => c.covered_by === m.from)?.failed_role : undefined;
    const head = failed ? `${LABEL[m.from]} covering for ${LABEL[failed]}` : `${LABEL[m.from]} → ${LABEL[m.to]}`;
    const consumed = m.consumed_by.length > 0 ? `consumed by ${m.consumed_by.join(', ')}` : 'not consumed';
    return feedEvent(`${head}: ${m.summary}`, m.from === 'supervisor' ? 'code' : 'nemotron', teamMessageArgs(m), consumed, incidentId, m.evidence_ids);
  });
  if (trace.missing_roles.length > 0) {
    const who = trace.missing_roles.map((r) => LABEL[r]).join(', ');
    events.push(feedEvent(`Missing team advice: ${who}`, 'code', 'missing_roles', who, incidentId));
  }
  if (trace.outcome === 'deterministic') {
    events.push(
      feedEvent(
        `Recovery Lead made no usable choice after ${trace.calls_used} model calls; using the deterministic choice over safety-checked options`,
        'code',
        'outcome',
        'deterministic',
        incidentId,
      ),
    );
  }
  return events;
}
