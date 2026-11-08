// Pure derivation of the per-workflow Decision trace: Detect → Options → Cost → Safety → Decision → Execute → Verify.
// Every value comes from persisted workflow rows (`state.candidates[]`, `state.verification`), plan rows, agent events
// and the action-ledger projection. Nothing is estimated or invented: a step whose data is missing says "not recorded",
// a metric the planner did not compute stays null ("not simulated"), and the choice is attributed only to the actor the
// agent recorded (`decided_by` / tool-call actor).

import type { ActionDetail, AgentActor, Evidence, PlanRecord } from '@dcos/db-client';
import type { Incident, IncidentLink } from '@dcos/contracts';
import { reasonText } from '../ledger/action-view';
import { isSafetyBlocked, operationLabel, subjectOf, type CandidateOption, type CandidateRound, type CandidateSafety, type WorkflowView } from '../workflows/workflow-view';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

// ------------------------------------------------------------------------------------------------ option naming

const OPTION_WORDS: Record<string, string> = {
  keep_running: 'Keep running', keep: 'Keep running', power_cap: 'Power cap', cap: 'Power cap', checkpoint: 'Checkpoint', ckpt: 'Checkpoint',
  checkpoint_then_migrate: 'Checkpoint, then migrate', migrate_restart: 'Migrate and restart', move: 'Move', pause_job: 'Pause job', pause: 'Pause job',
  escalate: 'Escalate to operator', cordon_gpu: 'Cordon GPU', cordon: 'Cordon GPU', uncordon_gpu: 'Uncordon GPU',
};

/** Plain-English option name from the persisted `option` kind (`checkpoint_then_migrate`) or an event option id (`job-b:move:r7`). */
export function optionName(o: CandidateOption): string {
  const raw = o.persisted ? o.persisted.option : o.option_id.includes(':') ? o.option_id.slice(o.option_id.indexOf(':') + 1) : o.option_id;
  const [head, ...rest] = raw.split(':');
  const parts = (head ?? raw).split('+').map((p) => OPTION_WORDS[p] ?? p.replaceAll('_', ' '));
  const name = parts.join(' + ');
  return rest.length ? `${name} → ${rest.join(' ')}` : name;
}

/** Job (or target) an option belongs to: persisted `job_id`, else the id prefix of an event option id. */
export const optionJob = (o: CandidateOption): string => o.persisted?.job_id ?? (o.option_id.includes(':') ? o.option_id.slice(0, o.option_id.indexOf(':')) : o.option_id);

const isKeepRunning = (o: CandidateOption): boolean => (o.persisted ? o.persisted.option === 'keep_running' : /:keep(_running)?$/.test(o.option_id));

// ------------------------------------------------------------------------------------------------ step shapes

export type StepId = 'detect' | 'options' | 'cost' | 'safety' | 'decision' | 'execute' | 'verify';
export interface StepMeta { id: StepId; index: number; title: string; summary: string; recorded: boolean }

export interface DetectIncident {
  incident_id: string;
  title: string | null;
  severity: Incident['severity'] | null;
  state: Incident['state'] | null;
  hypothesis: string | null;
  opened_sim_time_ms: number | null;
  /** Incident links (resource / symptom ids) from the evidence window; empty when none were received. */
  resources: string[];
  symptoms: string[];
}
export interface TriageLine { actor: AgentActor | null; summary: string; sim_time_ms: number; stage: string; tools: string[] }
export interface DetectStep extends StepMeta { id: 'detect'; incidents: DetectIncident[]; triage: TriageLine[] }

export interface OptionRow {
  option_id: string;
  job: string;
  name: string;
  commands: string;
  lost_wu: number | null;
  deficit_wu: number | null;
  gpu_waste_s: number | null;
  /** Lowest predicted lost work among this job's simulated options (ties all flagged). */
  lowest_cost: boolean;
  /** The do-nothing baseline (`keep_running`), used for the "chosen saves X wu" comparison. */
  keep_running: boolean;
  chosen: boolean | null;
  safety: CandidateSafety | null;
  safety_label: string;
  violations: Array<{ code: string; text: string }>;
  reason: string | null;
  actor: AgentActor | null;
  snapshot_epoch: number | null;
}
export interface OptionsStep extends StepMeta {
  id: 'options';
  source: CandidateRound['source'] | null;
  show_deficit: boolean;
  jobs: Array<{ job: string; rows: OptionRow[] }>;
  pending: boolean;
}

export interface CostBar { option_id: string; name: string; lost_wu: number | null; chosen: boolean | null; width_pct: number | null }
export interface CostJob {
  job: string;
  bars: CostBar[];
  /** Only when BOTH the chosen option and keep-running carry a predicted lost-work number. */
  saving: { chosen: string; chosen_wu: number; keep_wu: number; saved_wu: number } | null;
}
export interface CostStep extends StepMeta { id: 'cost'; jobs: CostJob[] }

export interface LedgerSafety {
  decision: string;
  violations: Array<{ code: string; text: string }>;
  checked_decision_epoch: number | null;
}
export interface LedgerSafetyLine {
  command_key: string;
  label: string;
  blocked: boolean;
  request: LedgerSafety | null;
  start: LedgerSafety | null;
  /** Ledger reason code when the action failed for another reason. */
  reason_code: string | null;
}
export interface SafetyStep extends StepMeta { id: 'safety'; options: OptionRow[]; ledger: LedgerSafetyLine[] }

export interface DecisionLine { job: string; option_id: string; name: string; actor: AgentActor | null; reason: string | null; snapshot_epoch: number | null; as_of_sim_time_ms: number | null }
export interface DecisionStep extends StepMeta {
  id: 'decision';
  lines: DecisionLine[];
  plan: { plan_id: string; explanation: string | null; based_on_decision_epoch: number; lost_wu: number; gpu_waste_s: number; commands: number } | null;
  attempt: number | null;
  replan: { reason: string | null; previous_plan_id: string | null } | null;
}

export interface ExecuteLine {
  command_key: string;
  label: string;
  status: string;
  blocked: boolean;
  lifecycle: Array<{ status: string; sim_time_ms: number }>;
  requested_sim_time_ms: number;
  started_sim_time_ms: number | null;
  due_sim_time_ms: number | null;
  attempt: number;
  reason_code: string | null;
  /** Reconcile decision the resume path recorded for this key (`succeeded → skip`), null when none. */
  reconciled: string | null;
}
export interface ExecuteStep extends StepMeta { id: 'execute'; lines: ExecuteLine[]; resumed: { by: string | null; from: string | null; sim_time_ms: number } | null }

export interface VerifyCheck { command_key: string; operation: string; label: string; ok: boolean | null; note: string | null; evidence: Array<{ key: string; value: string }> }
export interface VerifyStep extends StepMeta {
  id: 'verify';
  outcome: 'recovered' | 'not_verified' | 'escalated' | 'pending' | 'not_recorded';
  outcome_label: string;
  persisted_outcome: string | null;
  window: { from: number | null; to: number } | null;
  checks: VerifyCheck[];
  jobs: Array<{ job: string; status: string | null; progress_wu: number | null; durable_wu: number | null; racks: string[] }>;
  placements: Array<{ job: string; gpus: string[]; racks: string[] }>;
  unresolved: string[];
  next_human_action: string | null;
  remaining_risk: string | null;
  handoff: string | null;
}

export type TraceStep = DetectStep | OptionsStep | CostStep | SafetyStep | DecisionStep | ExecuteStep | VerifyStep;
export interface DecisionTrace { workflow_id: string; steps: TraceStep[] }

export interface TraceContext {
  plans?: readonly PlanRecord[];
  incidents?: readonly Incident[];
  evidence?: Evidence | null;
}

// ------------------------------------------------------------------------------------------------ helpers

const SAFETY_LABEL: Record<CandidateSafety, string> = { allow: 'Allowed', needs_approval: 'Needs approval', deny: 'Denied', not_checked: 'Not checked' };
const violation = (code: string) => ({ code, text: reasonText(code) });

/** Event-derived safety strings ("allowed", "denied: CODE_A, CODE_B") → enum + codes. Unknown text stays `null` (shown verbatim). */
function parseEventSafety(s: string | null): { safety: CandidateSafety | null; codes: string[] } {
  if (!s) return { safety: null, codes: [] };
  const m = /^(allowed|denied|needs[ _]approval|not[ _]checked)\s*:?\s*(.*)$/i.exec(s.trim());
  if (!m) return { safety: null, codes: [] };
  const head = m[1]!.toLowerCase().replace(' ', '_');
  const safety: CandidateSafety = head === 'allowed' ? 'allow' : head === 'denied' ? 'deny' : head === 'needs_approval' ? 'needs_approval' : 'not_checked';
  const codes = (m[2] ?? '').split(/[,;]/).map((c) => c.trim()).filter((c) => /^[A-Z][A-Z0-9_]+$/.test(c));
  return { safety, codes };
}

function optionRows(round: CandidateRound | null): OptionRow[] {
  if (!round) return [];
  const rows = round.options.map<OptionRow>((o) => {
    const p = o.persisted;
    const ev = p ? null : parseEventSafety(o.safety);
    const safety = p ? p.safety : ev!.safety;
    const codes = p ? p.violations : ev!.codes;
    return {
      option_id: o.option_id,
      job: optionJob(o),
      name: optionName(o),
      commands: o.simulated,
      lost_wu: o.lost_wu,
      deficit_wu: p?.deficit_wu ?? null,
      gpu_waste_s: p?.gpu_waste_s ?? null,
      lowest_cost: false,
      keep_running: isKeepRunning(o),
      chosen: o.chosen,
      safety,
      safety_label: safety ? SAFETY_LABEL[safety] : o.safety ?? 'Not recorded',
      violations: codes.map(violation),
      reason: p?.reason ?? null,
      actor: o.actor,
      snapshot_epoch: p?.snapshot_epoch ?? null,
    };
  });
  const minByJob = new Map<string, number>();
  for (const r of rows) if (r.lost_wu !== null) minByJob.set(r.job, Math.min(minByJob.get(r.job) ?? Infinity, r.lost_wu));
  // Two options of one job with the same kind (migrate to r7 vs r8) are told apart by the destination in their commands summary.
  const nameCount = new Map<string, number>();
  for (const r of rows) nameCount.set(`${r.job}|${r.name}`, (nameCount.get(`${r.job}|${r.name}`) ?? 0) + 1);
  return rows.map((r) => ({
    ...r,
    name: (nameCount.get(`${r.job}|${r.name}`) ?? 0) > 1 && destinationOf(r.commands) ? `${r.name} → ${destinationOf(r.commands)}` : r.name,
    lowest_cost: r.lost_wu !== null && minByJob.get(r.job) === r.lost_wu,
  }));
}
/** Trailing destination token of a commands summary (`… migrate_restart r8` → `r8`), null when there is none. */
const destinationOf = (commands: string): string | null => {
  const m = /\b(r\d+|rack-[\w-]+|gpu-[\w-]+)\s*$/.exec(commands.trim());
  return m ? m[1]! : null;
};

const groupByJob = <T extends { job: string }>(rows: readonly T[]): Array<{ job: string; rows: T[] }> => {
  const order: string[] = [];
  const by = new Map<string, T[]>();
  for (const r of rows) {
    if (!by.has(r.job)) { by.set(r.job, []); order.push(r.job); }
    by.get(r.job)!.push(r);
  }
  return order.map((job) => ({ job, rows: by.get(job)! }));
};

const ledgerSafety = (s: ActionDetail['safety']): LedgerSafety | null => (s ? { decision: s.decision, violations: s.violations.map(violation), checked_decision_epoch: s.checked_decision_epoch } : null);
const actionLabel = (d: ActionDetail): string => `${operationLabel(d.command.operation)} ${subjectOf(d.command)}`;

/** Evidence the verifier wrote to the ledger for this command (`verifyAction` detail), minus the fields shown elsewhere. */
function ledgerVerificationEvidence(d: ActionDetail | undefined): Array<{ key: string; value: string }> {
  if (!d) return [];
  let v: Record<string, unknown> | null = null;
  for (let i = d.history.length - 1; i >= 0 && !v; i--) if (isRecord(d.history[i]!.detail.verification)) v = d.history[i]!.detail.verification as Record<string, unknown>;
  if (!v && isRecord(d.status.result.verification)) v = d.status.result.verification;
  if (!v) return [];
  const skip = new Set(['verified', 'note', 'problems', 'verified_by']);
  return Object.entries(v).filter(([k]) => !skip.has(k)).map(([key, value]) => ({ key: key.replaceAll('_', ' '), value: fmt(value) }));
}
const fmt = (v: unknown): string => (v === null || v === undefined ? 'not recorded' : Array.isArray(v) ? (v.length ? v.map(fmt).join(', ') : 'none') : typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));

const RECONCILE_RE = /→\s*(skip|wait|claim_start|resubmit_same_key|blocked|reclaim_after_timeout|needs_operator)\s*$/;

// ------------------------------------------------------------------------------------------------ steps

function detectStep(view: WorkflowView, ctx: TraceContext): DetectStep {
  const byId = new Map((ctx.incidents ?? []).map((i) => [i.incident_id, i]));
  const links: readonly IncidentLink[] = ctx.evidence?.links ?? [];
  const incidents = view.incidents.map<DetectIncident>((i) => {
    const full = byId.get(i.incident_id);
    const mine = links.filter((l) => l.incident_id === i.incident_id);
    return {
      incident_id: i.incident_id, title: i.title, severity: full?.severity ?? null, state: i.state, hypothesis: i.hypothesis,
      opened_sim_time_ms: full ? full.opened_sim_time_ms : null,
      resources: [...new Set(mine.filter((l) => l.link_kind === 'resource').map((l) => l.linked_id))],
      symptoms: [...new Set(mine.filter((l) => l.link_kind === 'symptom').map((l) => l.linked_id))],
    };
  });
  const triage = view.events.filter((e) => e.stage === 'triage' || e.stage === 'diagnose').map<TriageLine>((e) => ({ actor: e.actor ?? null, summary: e.summary, sim_time_ms: e.sim_time_ms, stage: e.stage, tools: e.tool_calls.map((t) => t.tool) }));
  const recorded = incidents.length > 0 || triage.length > 0;
  const summary = incidents.length ? incidents.map((i) => i.title ?? i.incident_id).join(' · ') : 'No incident linked';
  return { id: 'detect', index: 1, title: 'Detect', summary, recorded, incidents, triage };
}

function optionsStep(view: WorkflowView): OptionsStep {
  const round = view.candidates;
  const rows = optionRows(round);
  const jobs = groupByJob(rows);
  const summary = rows.length ? `${rows.length} ${rows.length === 1 ? 'option' : 'options'} across ${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}` : 'No candidate options recorded';
  return { id: 'options', index: 2, title: 'Options considered', summary, recorded: rows.length > 0, source: round?.source ?? null, show_deficit: round?.showDeficit ?? false, jobs, pending: round?.pending ?? false };
}

function costStep(rows: readonly OptionRow[]): CostStep {
  const jobs = groupByJob(rows).map<CostJob>(({ job, rows: mine }) => {
    const values = mine.map((r) => r.lost_wu).filter((x): x is number => x !== null);
    const max = values.length ? Math.max(...values) : 0;
    const bars = mine.map<CostBar>((r) => ({ option_id: r.option_id, name: r.name, lost_wu: r.lost_wu, chosen: r.chosen, width_pct: r.lost_wu === null ? null : max > 0 ? Math.round((r.lost_wu / max) * 100) : 0 }));
    const chosen = mine.find((r) => r.chosen === true);
    const keep = mine.find((r) => r.keep_running);
    const saving = chosen && keep && chosen.lost_wu !== null && keep.lost_wu !== null && chosen !== keep ? { chosen: chosen.name, chosen_wu: chosen.lost_wu, keep_wu: keep.lost_wu, saved_wu: Math.round((keep.lost_wu - chosen.lost_wu) * 1000) / 1000 } : null;
    return { job, bars, saving };
  });
  const simulated = rows.filter((r) => r.lost_wu !== null).length;
  const summary = simulated ? `${simulated} of ${rows.length} options simulated for lost work` : rows.length ? 'No option carries a predicted lost-work number' : 'No candidate options recorded';
  return { id: 'cost', index: 3, title: 'Cost comparison', summary, recorded: simulated > 0, jobs };
}

function safetyStep(view: WorkflowView, rows: readonly OptionRow[]): SafetyStep {
  const ledger = view.actions.map<LedgerSafetyLine>((d) => ({
    command_key: d.command.command_key, label: actionLabel(d), blocked: isSafetyBlocked(d.status),
    request: ledgerSafety(d.safety), start: ledgerSafety(d.start_safety), reason_code: d.status.reason_code,
  }));
  const denied = rows.filter((r) => r.safety === 'deny').length;
  const approval = rows.filter((r) => r.safety === 'needs_approval').length;
  const blocked = ledger.filter((l) => l.blocked).length;
  const bits = [denied && `${denied} denied`, approval && `${approval} need approval`, blocked && `${blocked} BLOCKED in the ledger`].filter(Boolean) as string[];
  const checked = rows.filter((r) => r.safety && r.safety !== 'not_checked').length;
  const summary = bits.length ? bits.join(' · ') : checked ? `${checked} options checked, all allowed` : rows.length || ledger.length ? 'No safety result recorded' : 'No options or actions recorded';
  return { id: 'safety', index: 4, title: 'Safety check', summary, recorded: checked > 0 || ledger.some((l) => l.request || l.start), options: [...rows], ledger };
}

function decisionStep(view: WorkflowView, rows: readonly OptionRow[], ctx: TraceContext): DecisionStep {
  const round = view.candidates;
  const lines = rows.filter((r) => r.chosen === true).map<DecisionLine>((r) => {
    const persisted = round?.options.find((o) => o.option_id === r.option_id)?.persisted;
    const actor = r.actor ?? round?.choice?.actor ?? null;
    const reason = r.reason ?? (round?.source === 'events' ? round.narrative.at(-1)?.summary ?? null : null);
    return { job: r.job, option_id: r.option_id, name: r.name, actor, reason, snapshot_epoch: r.snapshot_epoch, as_of_sim_time_ms: persisted?.as_of_sim_time_ms ?? null };
  });
  const planRow = view.planId ? (ctx.plans ?? []).find((p) => p.plan_id === view.planId) ?? null : null;
  const plan = planRow ? { plan_id: planRow.plan_id, explanation: str(planRow.explanation), based_on_decision_epoch: planRow.based_on_decision_epoch, lost_wu: planRow.expected_lost_work_units, gpu_waste_s: planRow.expected_gpu_busy_waste_s, commands: planRow.command_keys.length } : null;
  const summary = lines.length ? lines.map((l) => `${l.job}: ${l.name}`).join(' · ') : round?.choice ? `Choice published without option ids: ${round.choice.reported}` : 'No decision recorded';
  return { id: 'decision', index: 5, title: 'Decision', summary, recorded: lines.length > 0 || plan !== null, lines, plan, attempt: view.attempt, replan: view.replan };
}

function executeStep(view: WorkflowView): ExecuteStep {
  const reconciled = new Map<string, string>();
  for (const e of view.events) for (const t of e.tool_calls) if (t.tool === 'get_action_status' && RECONCILE_RE.test(t.result_summary)) reconciled.set(t.args_summary.trim(), t.result_summary);
  const lines = [...view.actions]
    .sort((a, b) => a.command.requested_sim_time_ms - b.command.requested_sim_time_ms || a.command.command_key.localeCompare(b.command.command_key))
    .map<ExecuteLine>((d) => ({
      command_key: d.command.command_key, label: actionLabel(d),
      status: isSafetyBlocked(d.status) ? 'BLOCKED' : d.status.status.replaceAll('_', ' '), blocked: isSafetyBlocked(d.status),
      lifecycle: d.history.map((h) => ({ status: h.status, sim_time_ms: h.sim_time_ms })),
      requested_sim_time_ms: d.command.requested_sim_time_ms,
      started_sim_time_ms: d.history.find((h) => h.status === 'running')?.sim_time_ms ?? null,
      due_sim_time_ms: d.due_sim_time_ms ?? num(d.status.result.due_sim_time_ms),
      attempt: d.status.attempt, reason_code: d.status.reason_code,
      reconciled: reconciled.get(d.command.command_key) ?? null,
    }));
  const done = lines.filter((l) => l.status === 'succeeded').length;
  const blocked = lines.filter((l) => l.blocked).length;
  const summary = lines.length ? [`${done} of ${lines.length} succeeded`, blocked && `${blocked} BLOCKED`].filter(Boolean).join(' · ') : 'No action requested yet';
  const resumed = view.resumed ? { by: view.resumed.by_worker, from: view.resumed.previous_owner, sim_time_ms: view.resumed.sim_time_ms } : null;
  return { id: 'execute', index: 6, title: 'Execute', summary, recorded: lines.length > 0, lines, resumed };
}

function verifyStep(view: WorkflowView): VerifyStep {
  const v = view.verification;
  const raw = isRecord(view.workflow.state.verification) ? view.workflow.state.verification : null;
  const byKey = new Map(view.actions.map((a) => [a.command.command_key, a]));
  const checks = (Array.isArray(raw?.checks) ? raw.checks.filter(isRecord) : []).map<VerifyCheck>((c) => {
    const key = str(c.command_key) ?? 'unknown key';
    const d = byKey.get(key);
    const operation = str(c.operation) ?? d?.command.operation ?? 'unknown operation';
    return { command_key: key, operation, label: d ? actionLabel(d) : operation.replaceAll("_", " "), ok: bool(c.ok), note: str(c.note), evidence: ledgerVerificationEvidence(d) };
  });
  const escalated = view.workflow.stage === 'escalated';
  const outcome: VerifyStep['outcome'] = !v ? (escalated ? 'escalated' : view.terminal ? 'not_recorded' : 'pending') : v.verified === true ? 'recovered' : escalated ? 'escalated' : 'not_verified';
  const outcome_label = { recovered: 'Recovered', not_verified: 'Not verified', escalated: 'Escalated', pending: 'Not yet verified', not_recorded: 'Verification not recorded' }[outcome];
  const summary = v ? `${outcome_label} · ${checks.filter((c) => c.ok === true).length}/${checks.length} checks passed` : escalated ? `${outcome_label} · ${view.escalationReason ?? 'reason not recorded'}` : outcome === 'pending' ? 'The workflow is still running; the verifier has not written a result' : outcome_label;
  return {
    id: 'verify', index: 7, title: 'Verify', summary, recorded: v !== null, outcome, outcome_label, persisted_outcome: v?.outcome ?? null, window: v?.asOf ?? null, checks,
    jobs: (v?.affectedJobs ?? []).map((j) => ({ job: j.job_id, status: j.status, progress_wu: j.progress_work_units, durable_wu: j.durable_work_units, racks: j.racks })),
    placements: (v?.placementOutcome ?? []).map((p) => ({ job: p.job_id, gpus: p.gpu_ids, racks: p.racks })),
    unresolved: v?.unresolved ?? [], next_human_action: v?.nextStep ?? (escalated ? view.escalationReason : null), remaining_risk: v?.remainingRisk ?? null, handoff: v?.handoff ?? null,
  };
}

/** The seven-step trace for one workflow view. Pure; safe to call on every render. */
export function decisionTrace(view: WorkflowView, ctx: TraceContext = {}): DecisionTrace {
  const options = optionsStep(view);
  const rows = options.jobs.flatMap((j) => j.rows);
  return {
    workflow_id: view.workflow.workflow_id,
    steps: [detectStep(view, ctx), options, costStep(rows), safetyStep(view, rows), decisionStep(view, rows, ctx), executeStep(view), verifyStep(view)],
  };
}

/** Actors behind a trace, for the header: which steps Nemotron decided vs deterministic code. */
export function traceActors(trace: DecisionTrace): { nemotron: number; code: number } {
  const decision = trace.steps.find((s): s is DecisionStep => s.id === 'decision');
  const out = { nemotron: 0, code: 0 };
  for (const l of decision?.lines ?? []) if (l.actor === 'nemotron') out.nemotron += 1; else if (l.actor === 'code') out.code += 1;
  return out;
}
