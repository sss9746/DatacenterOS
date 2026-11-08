// Pure derivation for the per-workflow board (R4.2 / R4.5). Everything here is read from persisted workflow rows,
// agent events and the action ledger projection. Nothing is estimated except an action's remaining time, which is
// derived from the ledger's sim due time and always labelled as an estimate. No scores or percentages are invented:
// candidate projections are the strings the agent's own simulate_plan tool calls reported.

import type { ActionDetail, AgentActor, AgentEventInput, AgentStage, ToolCallSummary, WorkflowRecord } from '@dcos/db-client';
import type { ActionCommand, ActionStatus, Incident, ObservedSnapshot } from '@dcos/contracts';

// ------------------------------------------------------------------------------------------------ stage track

export const TRACK = [
  { id: 'triage', label: 'Triage' },
  { id: 'diagnosis', label: 'Diagnosis' },
  { id: 'compare', label: 'Compare' },
  { id: 'safety', label: 'Safety' },
  { id: 'execute', label: 'Execute' },
  { id: 'verify', label: 'Verify' },
] as const;
export type TrackStage = (typeof TRACK)[number]['id'];

/** Agent stage → display step. `replan` returns to Compare (the card adds an explicit "replanning" state). */
export function trackStageOf(stage: AgentStage): TrackStage {
  switch (stage) {
    case 'triage': return 'triage';
    case 'diagnose': return 'diagnosis';
    case 'plan':
    case 'replan': return 'compare';
    case 'safety': return 'safety';
    case 'execute': return 'execute';
    case 'verify': return 'verify';
  }
}

/**
 * - `current`: where the workflow is now (persisted stage, or the last event stage for a closed workflow)
 * - `recorded`: an agent event for this workflow was published at this stage
 * - `run_level`: only a run-wide event exists (the agent publishes triage without a workflow id)
 * - `no_event`: before the current step, but no event for it was published (never shown as passed)
 * - `not_reached`: after the current step and nothing recorded
 * - `verified` / `review`: the Verify step of a closed workflow, from the persisted verification result
 * - `escalated`: the step at which the workflow was escalated to an operator
 */
export type StepState = 'current' | 'recorded' | 'run_level' | 'no_event' | 'not_reached' | 'verified' | 'review' | 'escalated';
export interface TrackStep { id: TrackStage; label: string; state: StepState; stateLabel: string }

const STEP_LABEL: Record<StepState, string> = {
  current: 'current',
  recorded: 'event recorded',
  run_level: 'run-wide event',
  no_event: 'no event',
  not_reached: 'not reached',
  verified: 'verified',
  review: 'operator review',
  escalated: 'escalated here',
};

// ------------------------------------------------------------------------------------------------ persisted state readers

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

export interface PersistedActions {
  completed: string[];
  verified: string[];
  unverified: string[];
  blocked: Array<{ command_key: string; violations: string[] }>;
  failed: Array<{ command_key: string; reason_code: string }>;
  not_run: string[];
}
export interface VerificationRecord {
  verified: boolean | null;
  escalate: boolean | null;
  handoff: string | null;
  /** Evidence sim time(s): R3 `verification_interval_sim_ms`, else `as_of_sim_time_ms` (number or pair). */
  asOf: { from: number | null; to: number } | null;
  /** Only when the agent persists an explicit field (R3 `next_human_action`); never mined from the handoff text. */
  nextStep: string | null;
  /** R3 `unresolved_infrastructure`: pump/GPU conditions that still need a human. */
  unresolved: string[];
  /** R3 fields (apps/agent/src/verify.ts `OperatorHandoff`); null when the agent did not persist them. */
  outcome: string | null;
  remainingRisk: string | null;
  source: string | null;
  hypotheses: string[];
  actions: PersistedActions | null;
  checkpointOutcome: Array<{ job_id: string; checkpoint_id: string; status: string; accessible: boolean | null; progress_work_units: number | null }>;
  placementOutcome: Array<{ job_id: string; gpu_ids: string[]; racks: string[] }>;
  affectedJobs: Array<{ job_id: string; status: string | null; progress_work_units: number | null; durable_work_units: number | null; racks: string[] }>;
}

/** R3 names first (`REQUIRED_HANDOFF_FIELDS`); the rest are accepted only for older agent builds. */
const NEXT_STEP_KEYS = ['next_human_action', 'next_human_step', 'next_operator_step', 'next_step', 'next_action'] as const;
const UNRESOLVED_KEYS = ['unresolved_infrastructure', 'unresolved'] as const;
const strList = (x: unknown): string[] => (Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string') : []);
const records = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? x.filter(isRecord) : []);

function readPersistedActions(x: unknown): PersistedActions | null {
  if (!isRecord(x)) return null;
  return {
    completed: strList(x.completed), verified: strList(x.verified), unverified: strList(x.unverified), not_run: strList(x.not_run),
    blocked: records(x.blocked).map((b) => ({ command_key: str(b.command_key) ?? 'unknown key', violations: strList(b.violations) })),
    failed: records(x.failed).map((f) => ({ command_key: str(f.command_key) ?? 'unknown key', reason_code: str(f.reason_code) ?? 'no reason code' })),
  };
}

/** `workflow.state.verification`, the agent's persisted operator handoff (R3 `OperatorHandoff`; older builds wrote only the first four fields). */
export function readVerification(state: Record<string, unknown>): VerificationRecord | null {
  const v = state.verification;
  if (!isRecord(v)) return null;
  const at = v.as_of_sim_time_ms;
  const interval = v.verification_interval_sim_ms;
  let asOf: VerificationRecord['asOf'] = null;
  if (Array.isArray(interval) && interval.length === 2 && num(interval[0]) !== null && num(interval[1]) !== null) asOf = { from: interval[0] as number, to: interval[1] as number };
  else if (num(at) !== null) asOf = { from: null, to: at as number };
  else if (Array.isArray(at) && at.length === 2 && num(at[0]) !== null && num(at[1]) !== null) asOf = { from: at[0] as number, to: at[1] as number };
  const nextStep = NEXT_STEP_KEYS.map((k) => str(v[k])).find((x) => x !== null) ?? null;
  const unresolvedRaw = UNRESOLVED_KEYS.map((k) => v[k]).find((x) => Array.isArray(x) || typeof x === 'string');
  const unresolved = Array.isArray(unresolvedRaw) ? unresolvedRaw.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : typeof unresolvedRaw === 'string' ? [unresolvedRaw] : [];
  const evidence = isRecord(v.evidence) ? v.evidence : {};
  return {
    verified: bool(v.verified), escalate: bool(v.escalate), handoff: str(v.handoff), asOf, nextStep, unresolved,
    outcome: str(v.outcome), remainingRisk: str(v.remaining_risk), source: str(v.source), hypotheses: strList(evidence.hypotheses),
    actions: readPersistedActions(v.actions),
    checkpointOutcome: records(v.checkpoint_outcome).map((c) => ({ job_id: str(c.job_id) ?? 'unknown job', checkpoint_id: str(c.checkpoint_id) ?? 'unknown checkpoint', status: str(c.status) ?? 'unknown', accessible: bool(c.accessible), progress_work_units: num(c.progress_work_units) })),
    placementOutcome: records(v.placement_outcome).map((p) => ({ job_id: str(p.job_id) ?? 'unknown job', gpu_ids: strList(p.gpu_ids), racks: strList(p.racks) })),
    affectedJobs: records(v.affected_jobs).map((j) => ({ job_id: str(j.job_id) ?? 'unknown job', status: str(j.status), progress_work_units: num(j.progress_work_units), durable_work_units: num(j.durable_work_units), racks: strList(j.racks) })),
  };
}

/** Planner attempt: `state.attempt` (persisted by plan/replan). `WorkflowRecord.attempt` is the lease-claim count, not this. */
export const planAttempt = (wf: WorkflowRecord): number | null => num(wf.state.attempt);

// ------------------------------------------------------------------------------------------------ actors

export interface ActorCounts { nemotron: number; code: number; unlabelled: number }
export function actorCounts(events: readonly AgentEventInput[]): ActorCounts {
  const out: ActorCounts = { nemotron: 0, code: 0, unlabelled: 0 };
  for (const e of events) {
    if (e.actor === 'nemotron') out.nemotron += 1;
    else if (e.actor === 'code') out.code += 1;
    else out.unlabelled += 1;
  }
  return out;
}
/** e.g. "3 Nemotron · 5 code", "No events". Never a blanket brand label. */
export function actorSummary(c: ActorCounts): string {
  const parts = [c.nemotron && `${c.nemotron} Nemotron`, c.code && `${c.code} code`, c.unlabelled && `${c.unlabelled} unlabelled`].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No events';
}
export function actorLabel(actor: AgentActor | undefined, example = false): string {
  const base = actor === 'nemotron' ? 'Nemotron' : actor === 'code' ? 'Code' : 'Actor not recorded';
  return example && actor ? `${base} (scripted)` : base;
}

// ------------------------------------------------------------------------------------------------ actions

const ACTIVE_STATUSES: ReadonlySet<ActionStatus['status']> = new Set(['requested', 'claimed', 'running']);
export const isSafetyBlocked = (s: ActionStatus): boolean => s.status === 'failed' && s.reason_code === 'SAFETY_REJECTED';
export const subjectOf = (cmd: ActionCommand): string => cmd.job_id ?? cmd.target_resource_id;
export const operationLabel = (op: ActionCommand['operation']): string => op.replaceAll('_', ' ');

export interface WaitInfo {
  command_key: string;
  operation: ActionCommand['operation'];
  subject: string;
  status: 'requested' | 'claimed' | 'running';
  claimed_by: string | null;
  started_sim_time_ms: number | null;
  due_sim_time_ms: number | null;
  /** Estimate only: due - current sim time. null when the ledger records no due time. */
  remaining_ms: number | null;
  /** Due time passed without a terminal ledger result. Elapsed time is not success. */
  overdue: boolean;
}

function waitInfo(d: ActionDetail, simNow: number | null): WaitInfo {
  const started = [...d.history].reverse().find((h) => h.status === 'running')?.sim_time_ms ?? null;
  const due = d.status.status === 'running' ? (d.due_sim_time_ms ?? num(d.status.result.due_sim_time_ms)) : null;
  const remaining = due !== null && simNow !== null ? due - simNow : null;
  return {
    command_key: d.command.command_key,
    operation: d.command.operation,
    subject: subjectOf(d.command),
    status: d.status.status as WaitInfo['status'],
    claimed_by: d.claimed_by,
    started_sim_time_ms: started,
    due_sim_time_ms: due,
    remaining_ms: remaining === null ? null : Math.max(0, remaining),
    overdue: remaining !== null && remaining <= 0,
  };
}

/**
 * What the workflow waits on: its persisted `current_command_key` if that action is still requested/claimed/running,
 * else the first such action of its current plan, else any of its actions still in flight (e.g. kept across a replan).
 */
export function waitingOn(wf: WorkflowRecord, actions: readonly ActionDetail[], simNow: number | null): WaitInfo | null {
  const active = actions.filter((a) => ACTIVE_STATUSES.has(a.status.status));
  if (!active.length) return null;
  const pick =
    active.find((a) => a.command.command_key === wf.current_command_key) ??
    active.find((a) => a.command.plan_id === wf.plan_id) ??
    active[0]!;
  return waitInfo(pick, simNow);
}

export interface ActionLine {
  command_key: string;
  operation: ActionCommand['operation'];
  subject: string;
  plan_id: string;
  status: ActionStatus['status'];
  reason: string | null;
  /** From the ledger's verify_action record; null = no verification recorded (ledger success alone is not verified). */
  verified: boolean | null;
  verification_note: string | null;
}

function verificationOf(d: ActionDetail): { verified: boolean | null; note: string | null } {
  for (let i = d.history.length - 1; i >= 0; i--) {
    const v = d.history[i]!.detail.verification;
    if (isRecord(v)) return { verified: bool(v.verified), note: str(v.note) };
  }
  const v = d.status.result.verification;
  return isRecord(v) ? { verified: bool(v.verified), note: str(v.note) } : { verified: null, note: null };
}

function actionLine(d: ActionDetail): ActionLine {
  const s = d.status;
  const violations = Array.isArray(s.result.violations) ? s.result.violations.map(String) : [];
  const v = verificationOf(d);
  return {
    command_key: d.command.command_key,
    operation: d.command.operation,
    subject: subjectOf(d.command),
    plan_id: d.command.plan_id,
    status: s.status,
    reason: violations.length ? violations.join(', ') : s.reason_code,
    verified: v.verified,
    verification_note: v.note,
  };
}

export interface ActionGroups { inProgress: ActionLine[]; completed: ActionLine[]; blocked: ActionLine[]; failed: ActionLine[] }
/** BLOCKED = failed + SAFETY_REJECTED. `completed` = ledger succeeded (verification shown separately). */
export function groupActions(actions: readonly ActionDetail[]): ActionGroups {
  const out: ActionGroups = { inProgress: [], completed: [], blocked: [], failed: [] };
  for (const d of actions) {
    const line = actionLine(d);
    if (ACTIVE_STATUSES.has(d.status.status)) out.inProgress.push(line);
    else if (d.status.status === 'succeeded') out.completed.push(line);
    else if (isSafetyBlocked(d.status)) out.blocked.push(line);
    else out.failed.push(line);
  }
  return out;
}

export interface OutcomeLine { command_key: string; kind: 'checkpoint' | 'placement'; subject: string; ledger: string; observed: string }

const outcomeText = (d: ActionDetail): string => {
  for (let i = d.history.length - 1; i >= 0; i--) {
    const o = d.history[i]!.detail.outcome;
    if (isRecord(o)) return `ledger outcome ${str(o.status) ?? 'unknown'}${str(o.reason_code) ? ` (${o.reason_code as string})` : ''}`;
  }
  return `ledger status ${d.status.status}`;
};

/** Checkpoint and placement outcomes: ledger outcome + what the current snapshot shows (labelled as currently observed). */
export function outcomes(actions: readonly ActionDetail[], snapshot: ObservedSnapshot | null): OutcomeLine[] {
  const out: OutcomeLine[] = [];
  for (const d of actions) {
    const cmd = d.command;
    if (cmd.operation === 'checkpoint') {
      const cp = snapshot?.checkpoints.find((c) => c.command_key === cmd.command_key);
      out.push({ command_key: cmd.command_key, kind: 'checkpoint', subject: subjectOf(cmd), ledger: outcomeText(d), observed: cp ? `checkpoint ${cp.checkpoint_id} ${cp.status}, ${cp.accessible ? 'accessible' : 'not accessible'}` : 'no checkpoint row for this command' });
    } else if (cmd.operation === 'migrate_restart') {
      const dest = Array.isArray(cmd.arguments.destination_gpu_ids) ? cmd.arguments.destination_gpu_ids.map(String) : [];
      const job = cmd.job_id ? snapshot?.job_states.find((j) => j.job_id === cmd.job_id) : undefined;
      const onDest = !!job && dest.length > 0 && job.allocated_gpu_ids.length === dest.length && dest.every((g) => job.allocated_gpu_ids.includes(g));
      out.push({ command_key: cmd.command_key, kind: 'placement', subject: subjectOf(cmd), ledger: outcomeText(d), observed: job ? `${job.job_id} ${job.status}, ${onDest ? 'on the planned destination' : 'not on the planned destination'} (${dest.length} GPUs planned)` : 'job not in snapshot' });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ infrastructure

export interface InfraLine { resource_id: string; kind: 'cooling' | 'gpu'; state: string }
export interface InfraView { cooling: InfraLine[]; relatedGpus: InfraLine[]; otherGpus: InfraLine[] }

/** Unresolved infrastructure from the CURRENT observed snapshot. Agent actions never repair pumps or GPUs. */
export function unresolvedInfra(snapshot: ObservedSnapshot | null, commands: readonly ActionCommand[]): InfraView {
  if (!snapshot) return { cooling: [], relatedGpus: [], otherGpus: [] };
  const touched = new Set<string>();
  for (const c of commands) {
    touched.add(c.target_resource_id);
    if (Array.isArray(c.arguments.destination_gpu_ids)) c.arguments.destination_gpu_ids.forEach((g) => touched.add(String(g)));
  }
  const cooling = snapshot.cooling.filter((c) => c.operating_state !== 'normal').map((c) => ({ resource_id: c.resource_id, kind: 'cooling' as const, state: c.operating_state }));
  const gpus = snapshot.gpus.filter((g) => g.availability !== 'ready').map((g) => ({ resource_id: g.resource_id, kind: 'gpu' as const, state: `${g.availability}${g.last_xid_code !== null ? ` · XID ${g.last_xid_code}` : ''}` }));
  return { cooling, relatedGpus: gpus.filter((g) => touched.has(g.resource_id)), otherGpus: gpus.filter((g) => !touched.has(g.resource_id)) };
}

// ------------------------------------------------------------------------------------------------ resume evidence

const RECONCILE_RE = /→\s*(skip|wait|claim_start|resubmit_same_key|blocked|reclaim_after_timeout|needs_operator)\s*$/;
const RESUME_SUMMARY_RE = /^(?:Example:\s*)?(?:resumed after agent restart|continuing \S+ from stage \S+ after agent restart)/i;

export interface ResumeEvidence { source: 'workflow_state' | 'reconcile_tool_calls' | 'event_summary'; event_id: string; sim_time_ms: number; detail: string }

/**
 * "Resumed" only with evidence. The agent persists no resume field, so the strongest signal is the resume path's
 * ledger reconciliation tool calls (`get_action_status` → a reconcile decision such as `skip`); the fallback is the
 * resume/continuation event summary. Lease re-claims alone (`WorkflowRecord.attempt` > 1) are NOT treated as a resume:
 * the agent also re-claims after an error retry.
 */
export function resumeEvidence(events: readonly AgentEventInput[], state: Record<string, unknown> = {}): ResumeEvidence | null {
  // Primary: the persisted marker `state.resumed = { by_worker, at_sim_time_ms, action }` written by the resume path.
  const marker = state.resumed;
  if (isRecord(marker) && num(marker.at_sim_time_ms) !== null) {
    const parts = [str(marker.by_worker) ? `by ${marker.by_worker as string}` : null, str(marker.action)].filter((x): x is string => x !== null);
    return { source: 'workflow_state', event_id: 'workflow.state.resumed', sim_time_ms: marker.at_sim_time_ms as number, detail: parts.join(' · ') || 'resume recorded' };
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const calls = e.tool_calls.filter((t) => t.tool === 'get_action_status' && RECONCILE_RE.test(t.result_summary));
    if (calls.length) return { source: 'reconcile_tool_calls', event_id: e.agent_event_id, sim_time_ms: e.sim_time_ms, detail: calls.map((t) => `${t.args_summary}: ${t.result_summary}`).join('; ') };
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (RESUME_SUMMARY_RE.test(e.summary)) return { source: 'event_summary', event_id: e.agent_event_id, sim_time_ms: e.sim_time_ms, detail: e.summary };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ candidates

export interface Projection { simulated: string; reported: string; lost_wu: number | null; delay_s: number | null; actor: AgentActor | null }
export interface CandidateOption extends Projection {
  option_id: string;
  /** evaluate_safety result as reported ("allowed" / "denied: …"); null when no safety call was published. */
  safety: string | null;
  blocked: boolean;
  /** true/false only when an option-id choice was published (choose_options); null = choice not identifiable. */
  chosen: boolean | null;
}
export interface CandidateRound {
  event_ids: string[];
  sim_time_ms: number;
  options: CandidateOption[];
  /** Final simulate_plan of the chosen commands together (no option id). */
  combined: Projection | null;
  choice: { option_ids: string[]; actor: AgentActor | null; reported: string } | null;
  narrative: { summary: string; actor: AgentActor | null }[];
  /** Latest event is a replan with no plan event after it yet. */
  pending: boolean;
}

const LOST_RE = /lost\s+(-?[\d.]+)\s*wu/i;
const DELAY_RE = /delay\s+(-?[\d.]+)\s*s\b/i;
const parseNum = (re: RegExp, s: string): number | null => {
  const m = re.exec(s);
  return m ? (Number.isFinite(Number(m[1])) ? Number(m[1]) : null) : null;
};
function projection(call: ToolCallSummary): Projection {
  return { simulated: call.args_summary, reported: call.result_summary, lost_wu: parseNum(LOST_RE, call.result_summary), delay_s: parseNum(DELAY_RE, call.result_summary), actor: call.actor ?? null };
}
/** evaluate_safety args: `{"option_id":"job-a:ckpt"}` in plan events, a bare option id in the BLOCKED safety event. */
function optionIdOf(args: string): string | null {
  try {
    const parsed: unknown = JSON.parse(args);
    if (isRecord(parsed) && typeof parsed.option_id === 'string') return parsed.option_id;
  } catch { /* bare id */ }
  const bare = args.trim();
  return bare && !/[\s{}]/.test(bare) ? bare : null;
}

/** The latest plan/replan round of one workflow's events (in publication order). */
export function latestCandidateRound(events: readonly AgentEventInput[]): CandidateRound | null {
  let end = -1;
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.stage === 'plan' || events[i]!.stage === 'replan') { end = i; break; }
  if (end < 0) return null;
  let start = end;
  // A replan publishes "replanning …" then the replan narrative (choice + combined projection), then the plan event.
  for (let i = end - 1; i >= 0 && events[i]!.stage === 'replan'; i--) start = i;
  let stop = end;
  while (stop + 1 < events.length && events[stop + 1]!.stage === 'safety') stop += 1;
  const round = events.slice(start, stop + 1);

  const byId = new Map<string, CandidateOption>();
  let combined: Projection | null = null;
  let choice: CandidateRound['choice'] = null;
  for (const e of round) {
    const calls = e.tool_calls;
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;
      if (call.tool === 'simulate_plan') {
        const next = calls[i + 1];
        const id = next?.tool === 'evaluate_safety' ? optionIdOf(next.args_summary) : null;
        if (id && next) {
          byId.delete(id); // a re-rank publishes the option again; keep the latest projection, in its new position
          byId.set(id, { ...projection(call), option_id: id, safety: next.result_summary, blocked: /^denied/i.test(next.result_summary), chosen: null });
          i += 1;
        } else combined = projection(call);
      } else if (call.tool === 'evaluate_safety') {
        const id = optionIdOf(call.args_summary);
        if (!id) continue;
        const prev = byId.get(id);
        const blocked = /^denied/i.test(call.result_summary);
        if (prev) byId.set(id, { ...prev, safety: call.result_summary, blocked: prev.blocked || blocked });
        else byId.set(id, { option_id: id, simulated: '', reported: 'no projection published', lost_wu: null, delay_s: null, actor: call.actor ?? null, safety: call.result_summary, blocked, chosen: null });
      } else if (call.tool === 'choose_options') {
        const ids = call.actor === 'nemotron' ? call.result_summary.split(',').map((s) => s.replace(/\(approval\)/i, '').trim()).filter(Boolean) : [];
        choice = { option_ids: ids, actor: call.actor ?? null, reported: call.result_summary };
      }
    }
  }
  const chosenIds = choice && choice.option_ids.length ? new Set(choice.option_ids) : null;
  const options = [...byId.values()].map((o) => ({ ...o, chosen: chosenIds ? chosenIds.has(o.option_id) : null }));
  return {
    event_ids: round.map((e) => e.agent_event_id),
    sim_time_ms: events[end]!.sim_time_ms,
    options,
    combined,
    choice,
    narrative: round.filter((e) => e.stage === 'plan' || e.stage === 'replan').map((e) => ({ summary: e.summary, actor: e.actor ?? null })),
    pending: events[end]!.stage === 'replan',
  };
}

// ------------------------------------------------------------------------------------------------ workflow view

export type StatusKind = 'opened' | 'in_progress' | 'waiting' | 'replanning' | 'escalated' | 'verified' | 'operator_review' | 'closed_unverified';
export interface WorkflowStatus { kind: StatusKind; label: string; detail: string }

export interface WorkflowView {
  workflow: WorkflowRecord;
  incidents: Array<{ incident_id: string; title: string | null; hypothesis: string | null; state: Incident['state'] | null }>;
  steps: TrackStep[];
  current: TrackStage | null;
  status: WorkflowStatus;
  waiting: WaitInfo | null;
  resumed: ResumeEvidence | null;
  verification: VerificationRecord | null;
  escalationReason: string | null;
  replan: { reason: string | null; previous_plan_id: string | null } | null;
  planId: string | null;
  attempt: number | null;
  events: AgentEventInput[];
  actors: ActorCounts;
  lastEventSimMs: number | null;
  actions: ActionDetail[];
  groups: ActionGroups;
  outcomes: OutcomeLine[];
  affectedJobs: string[];
  infra: InfraView;
  candidates: CandidateRound | null;
  /** Show the handoff block: closed, escalated, or a verification result exists. */
  terminal: boolean;
  nextStep: { text: string; source: 'verification' | 'escalation_reason' } | null;
}

const fmtSim = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
};
export const formatSpan = fmtSim;

function buildSteps(current: TrackStage | null, events: readonly AgentEventInput[], runLevelTriage: boolean, wf: WorkflowRecord, verification: VerificationRecord | null): TrackStep[] {
  const seen = new Set(events.map((e) => trackStageOf(e.stage)));
  const cur = current === null ? -1 : TRACK.findIndex((t) => t.id === current);
  return TRACK.map((t, i) => {
    let state: StepState;
    if (i === cur) {
      if (wf.stage === 'escalated') state = 'escalated';
      else if (wf.stage === 'done' && t.id === 'verify' && verification) state = verification.verified ? 'verified' : 'review';
      else state = 'current';
    } else if (seen.has(t.id)) state = 'recorded';
    else if (t.id === 'triage' && runLevelTriage) state = 'run_level';
    else state = i < cur ? 'no_event' : 'not_reached';
    return { id: t.id, label: t.label, state, stateLabel: STEP_LABEL[state] };
  });
}

function currentStep(wf: WorkflowRecord, events: readonly AgentEventInput[], verification: VerificationRecord | null): TrackStage | null {
  if (wf.stage === 'idle') return null;
  if (wf.stage === 'escalated' || wf.stage === 'done') {
    if (wf.stage === 'done' && verification) return 'verify';
    const last = events.at(-1);
    return last ? trackStageOf(last.stage) : null;
  }
  return trackStageOf(wf.stage);
}

function statusOf(wf: WorkflowRecord, v: VerificationRecord | null, waiting: WaitInfo | null, escalationReason: string | null, replanReason: string | null): WorkflowStatus {
  switch (wf.stage) {
    case 'escalated':
      return { kind: 'escalated', label: 'Escalated to operator', detail: escalationReason ?? (v && v.verified === false ? 'Verification did not confirm recovery; needs operator review.' : 'Escalation reason not recorded.') };
    case 'done':
      if (!v) return { kind: 'closed_unverified', label: 'Closed · no verification recorded', detail: str(wf.state.note) ?? 'The workflow closed without a persisted verification result.' };
      if (v.verified) return { kind: 'verified', label: 'Verified', detail: 'The agent persisted a verified result from fresh observed snapshots.' };
      return { kind: 'operator_review', label: 'Closed · operator review', detail: 'Verification did not confirm recovery.' };
    case 'replan':
      return { kind: 'replanning', label: 'Replanning', detail: replanReason ?? 'Replan reason not recorded.' };
    case 'idle':
      return { kind: 'opened', label: 'Opened', detail: 'The workflow lease is claimed; no stage has been persisted yet.' };
    default:
      if (waiting) return { kind: 'waiting', label: 'Waiting', detail: waitText(waiting) };
      if (wf.stage === 'verify') return { kind: 'in_progress', label: 'Verifying', detail: 'Verification is running; no result has been persisted yet.' };
      return { kind: 'in_progress', label: 'In progress', detail: `Persisted stage: ${wf.stage}.` };
  }
}

/** Plain-English wait line. Remaining time is always marked as an estimate from the sim due time. */
export function waitText(w: WaitInfo): string {
  const what = `${operationLabel(w.operation)} ${w.subject}`;
  if (w.status === 'requested') return `Waiting for ${what} to be claimed (requested in the ledger).`;
  if (w.status === 'claimed') return `Waiting for ${what} to start (claimed${w.claimed_by ? ` by ${w.claimed_by}` : ''}).`;
  if (w.due_sim_time_ms === null || w.remaining_ms === null) return `Waiting on ${what} (running; no due time recorded).`;
  if (w.overdue) return `Waiting on ${what}: due time passed, no ledger result yet. Elapsed time is not success.`;
  return `Waiting on ${what}: about ${fmtSim(w.remaining_ms)} sim remaining (estimate from the ledger due time, not a result).`;
}

export interface BoardInput {
  workflows: readonly WorkflowRecord[];
  events: readonly AgentEventInput[];
  actionDetails: readonly ActionDetail[];
  incidents: readonly Incident[];
  snapshot: ObservedSnapshot | null;
}

const ORDER: Partial<Record<WorkflowRecord['stage'], number>> = { escalated: 1, done: 2 };

export function buildWorkflowViews(input: BoardInput): WorkflowView[] {
  const eventsByWf = new Map<string, AgentEventInput[]>();
  let runLevelTriage = false;
  for (const e of input.events) {
    if (!e.workflow_id) { if (e.stage === 'triage') runLevelTriage = true; continue; }
    const list = eventsByWf.get(e.workflow_id);
    if (list) list.push(e); else eventsByWf.set(e.workflow_id, [e]);
  }
  const actionsByWf = new Map<string, ActionDetail[]>();
  for (const d of input.actionDetails) {
    const list = actionsByWf.get(d.command.workflow_id);
    if (list) list.push(d); else actionsByWf.set(d.command.workflow_id, [d]);
  }
  const incidentById = new Map(input.incidents.map((i) => [i.incident_id, i]));
  const simNow = input.snapshot?.clock.sim_time_ms ?? null;

  return [...input.workflows]
    .sort((a, b) => (ORDER[a.stage] ?? 0) - (ORDER[b.stage] ?? 0) || a.workflow_id.localeCompare(b.workflow_id))
    .map((wf) => {
      const events = eventsByWf.get(wf.workflow_id) ?? [];
      const actions = actionsByWf.get(wf.workflow_id) ?? [];
      const verification = readVerification(wf.state);
      const escalationReason = str(wf.state.escalation_reason);
      const replan = wf.stage === 'replan' || wf.state.superseded === true ? { reason: str(wf.state.reason), previous_plan_id: str(wf.state.previous_plan_id) } : null;
      const terminal = wf.stage === 'done' || wf.stage === 'escalated';
      const waiting = terminal ? null : waitingOn(wf, actions, simNow);
      const current = currentStep(wf, events, verification);
      const persistedCommands = Array.isArray(wf.state.commands) ? (wf.state.commands as unknown[]).filter((c): c is ActionCommand => isRecord(c) && typeof c.command_key === 'string' && typeof c.target_resource_id === 'string') : [];
      const commands = [...actions.map((a) => a.command), ...persistedCommands.filter((c) => !actions.some((a) => a.command.command_key === c.command_key))];
      const incidentIds = wf.incident_ids.length ? wf.incident_ids : [...new Set(events.map((e) => e.incident_id).filter((x): x is string => !!x))];
      const nextStep = verification?.nextStep ? { text: verification.nextStep, source: 'verification' as const } : wf.stage === 'escalated' && escalationReason ? { text: escalationReason, source: 'escalation_reason' as const } : null;
      return {
        workflow: wf,
        incidents: incidentIds.map((id) => {
          const inc = incidentById.get(id);
          return { incident_id: id, title: inc?.title ?? null, hypothesis: inc?.hypothesis ?? null, state: inc?.state ?? null };
        }),
        steps: buildSteps(current, events, runLevelTriage, wf, verification),
        current,
        status: statusOf(wf, verification, waiting, escalationReason, replan?.reason ?? null),
        waiting,
        resumed: resumeEvidence(events, wf.state),
        verification,
        escalationReason,
        replan,
        planId: wf.plan_id ?? str(wf.state.plan_id),
        attempt: planAttempt(wf),
        events,
        actors: actorCounts(events),
        lastEventSimMs: events.length ? Math.max(...events.map((e) => e.sim_time_ms)) : null,
        actions,
        groups: groupActions(actions),
        outcomes: outcomes(actions, input.snapshot),
        affectedJobs: [...new Set(commands.map((c) => c.job_id).filter((j): j is string => !!j))],
        infra: unresolvedInfra(input.snapshot, commands),
        candidates: latestCandidateRound(events),
        terminal: terminal || verification !== null,
        nextStep,
      };
    });
}
