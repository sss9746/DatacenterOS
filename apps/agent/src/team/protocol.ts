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
}

export interface TeamTrace {
  version: 1;
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
}

export interface TeamFeedEvent {
  stage: AgentStage;
  summary: string; // e.g. `Cooling → Workload: ...`
  actor: AgentActor;
  toolCalls: ToolCallSummary[]; // tool name `team_message`
  incidentId?: string;
}

export const TEAM_LIMITS = { summaryChars: 400, evidenceIds: 12, resourceIds: 12, messages: 24 } as const;
export const TEAM_MESSAGE_TOOL = 'team_message';

// ---------------------------------------------------------------------------------------------- tool arguments

const idList = z.array(z.string().min(1));
const text = z.string().trim().min(1);

/** `question_for_peer` is required; a null question must say why none is needed. */
export const submitFindingArgsSchema = z
  .object({
    summary: text,
    evidence_ids: idList,
    resource_ids: idList,
    question_for_peer: text.nullable(),
    no_question_reason: text.nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.question_for_peer === null && !v.no_question_reason) {
      ctx.addIssue({ code: 'custom', path: ['no_question_reason'], message: 'a null question_for_peer must carry a reason' });
    }
  });
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

/** A copy that holds the persisted limits; only the most recent messages are kept. */
export function boundTrace(t: TeamTrace): TeamTrace {
  return { ...t, messages: t.messages.slice(-TEAM_LIMITS.messages).map(boundMessage) };
}

// ---------------------------------------------------------------------------------------------- feed

const LABEL: Record<TeamParty, string> = { cooling: 'Cooling', workload: 'Workload', lead: 'Lead', supervisor: 'Supervisor' };

function feedEvent(summary: string, actor: AgentActor, args: string, result: string, incidentId?: string): TeamFeedEvent {
  return {
    stage: 'plan',
    summary: clip(summary, MAX_SUMMARY_CHARS),
    actor,
    toolCalls: [{ tool: TEAM_MESSAGE_TOOL, args_summary: args, result_summary: result, actor }],
    ...(incidentId !== undefined ? { incidentId } : {}),
  };
}

/** One event per message, then code-labelled events for advice that never arrived and for a deterministic outcome. */
export function teamFeedEvents(trace: TeamTrace, incidentId?: string): TeamFeedEvent[] {
  const events = trace.messages.map((m) => {
    const failed = m.kind === 'cover' ? trace.covers.find((c) => c.covered_by === m.from)?.failed_role : undefined;
    const head = failed ? `${LABEL[m.from]} covering for ${LABEL[failed]}` : `${LABEL[m.from]} → ${LABEL[m.to]}`;
    const consumed = m.consumed_by.length > 0 ? `consumed by ${m.consumed_by.join(', ')}` : 'not consumed';
    return feedEvent(`${head}: ${m.summary}`, m.from === 'supervisor' ? 'code' : 'nemotron', `${m.kind} ${m.from}->${m.to}`, consumed, incidentId);
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
