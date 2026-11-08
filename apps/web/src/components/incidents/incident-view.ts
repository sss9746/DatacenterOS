// Pure derivations for the Incidents panel: four plain-English lines per incident (what happened, why, what the
// agents decided, status now) and the "evidence the agents recovered" strip. Every sentence is built from persisted
// rows (incident, evidence links/signals, the workflow for that incident, the ledger, the observed snapshot). When a
// fact is absent the line is omitted; nothing is estimated or invented.
import type { Incident, ObservedSnapshot } from '@dcos/contracts';
import type { ActionDetail, AgentActor, AgentEventInput, Evidence, WorkflowRecord } from '@dcos/db-client';
import { blockedReason, operationLabel, reasonText, reasonView } from '../ledger/action-view';
import { latestCandidateRound, persistedCandidateOptions, readVerification, resumeEvidence, resumedWithoutDuplicate, type CandidateOption } from '../workflows/workflow-view';
import { processName } from '../agent-room/room-view';
import { duration } from '../../lib/utils';

export type Tone = 'neutral' | 'agent' | 'warning' | 'danger';
export type ActorTag = 'NEMOTRON' | 'CODE' | null;

export interface StatusView { /** Short chip: Executing / Blocked / Verified / Needs a human. */ badge: string; /** One plain-English line. */ sentence: string; tone: Tone; incidentState: Incident['state'] }
export interface IncidentExplanation {
  incidentId: string;
  title: string;
  severity: Incident['severity'];
  severityTone: Tone;
  whatHappened: string;
  /** Null when no evidence links exist yet and the incident has no hypothesis. */
  why: string | null;
  /** Null when no workflow has been created for this incident. */
  decided: { text: string; actor: ActorTag } | null;
  status: StatusView;
  /** Raw identifiers for the "Evidence" disclosure. */
  evidence: { incidentId: string; workflowId: string | null; planId: string | null; linkedIds: string[]; signalCount: number; symptomCount: number; confidence: number; openedSimMs: number };
  example: boolean;
}

export const workflowIdOf = (incidentId: string) => `wf-${incidentId}`;
const EXAMPLE_RE = /^Example:\s*/;
export const stripExample = (s: string) => s.replace(EXAMPLE_RE, '').trim();
const pct = (x: number) => `${Math.round(x * 100)} %`;
const rackOf = (resourceId: string): string | null => /(?:^|-)r(\d+)(?:-|$)/.exec(resourceId)?.[1] ?? null;
const list = (items: string[]) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
/** Rack ids (`rack-r2`) or GPU ids (`gpu-r2-n1-0`) → "rack r2" / "racks r2–r4" / "racks r2, r5". */
const rackRange = (ids: string[]): string => {
  const nums = [...new Set(ids.map((id) => rackOf(id) ?? id))].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return '';
  const contiguous = nums.every((n, i) => i === 0 || n === nums[i - 1]! + 1);
  return nums.length === 1 ? `rack r${nums[0]}` : contiguous ? `racks r${nums[0]}–r${nums.at(-1)}` : `racks ${nums.map((n) => `r${n}`).join(', ')}`;
};
/** `pump-a` → "Pump A"; anything else is shown as its id. */
const pumpName = (id: string) => id.replace(/^pump-([a-z0-9]+)$/i, (_, x: string) => `Pump ${x.toUpperCase()}`);

export const actorTag = (actor: AgentActor | null | undefined): ActorTag => actor === 'nemotron' ? 'NEMOTRON' : actor === 'code' ? 'CODE' : null;

const reportedViolations = (a: ActionDetail) => Array.isArray(a.status.result.violations) ? (a.status.result.violations as unknown[]).filter((x): x is string => typeof x === 'string').map(reasonView) : [];

const simAt = (ms: number) => `sim ${duration(ms)}`;
const commandPhrase = (key: string, actions: readonly ActionDetail[]): string => {
  const d = actions.find((a) => a.status.command_key === key);
  if (!d) return key;
  const op = operationLabel(d.command.operation).toLowerCase();
  const subject = d.command.job_id ?? d.command.target_resource_id;
  const dest = Array.isArray(d.command.arguments.destination_gpu_ids) && d.command.arguments.destination_gpu_ids.length ? ` to ${rackRange(d.command.arguments.destination_gpu_ids as string[])}` : '';
  return `${op} ${subject}${dest}`;
};

/** Resources an incident is linked to, split by kind from the id prefix (the link rows carry no kind for resources). */
export function linkedResources(incidentId: string, evidence: Evidence | null) {
  const ids = (evidence?.links ?? []).filter((l) => l.incident_id === incidentId && l.link_kind === 'resource').map((l) => l.linked_id);
  const symptomIds = (evidence?.links ?? []).filter((l) => l.incident_id === incidentId && l.link_kind === 'symptom').map((l) => l.linked_id);
  const symptomResources = (evidence?.symptoms ?? []).filter((s) => symptomIds.includes(s.symptom_id)).map((s) => s.resource_id);
  const all = [...new Set([...ids, ...symptomResources])];
  return {
    all,
    cooling: all.filter((id) => /^(pump|cooling|loop|chiller)/.test(id)),
    racks: all.filter((id) => /^rack-/.test(id)),
    gpus: all.filter((id) => /^gpu-/.test(id)),
  };
}

/** Signals in the evidence window that touch the incident's resources (or GPUs on its racks). */
export function signalsFor(incidentId: string, evidence: Evidence | null) {
  const { all, racks } = linkedResources(incidentId, evidence);
  const rackNums = new Set(racks.map(rackOf).filter((x): x is string => x !== null));
  return (evidence?.signals ?? []).filter((s) => all.includes(s.resource_id) || (rackNums.size > 0 && rackNums.has(rackOf(s.resource_id) ?? '')));
}

/** "Pump A lost 60 % of its cooling; racks r2–r4 are heating (hottest GPU 84 °C)." from the observed snapshot. */
export function whatHappened(incident: Incident, evidence: Evidence | null, snapshot: ObservedSnapshot | null): string {
  const { cooling, racks, gpus } = linkedResources(incident.incident_id, evidence);
  const parts: string[] = [];
  for (const id of cooling) {
    const row = snapshot?.cooling.find((c) => c.resource_id === id);
    if (!row) continue;
    const lost = row.observed_capacity_estimate_w !== null && row.nominal_capacity_w > 0 ? 1 - row.observed_capacity_estimate_w / row.nominal_capacity_w : null;
    if (lost !== null && lost > 0.01) parts.push(`${pumpName(id)} lost ${pct(lost)} of its cooling`);
    else if (row.operating_state !== 'normal') parts.push(`${pumpName(id)} is ${row.operating_state}`);
  }
  if (racks.length && snapshot) {
    const nums = new Set(racks.map(rackOf).filter((x): x is string => x !== null));
    const temps = snapshot.gpus.filter((g) => nums.has(rackOf(g.resource_id) ?? '')).map((g) => g.temp_c);
    const hottest = temps.length ? Math.max(...temps) : null;
    parts.push(hottest !== null ? `${rackRange(racks)} ${racks.length > 1 ? 'are' : 'is'} heating (hottest GPU ${Math.round(hottest)} °C)` : `${rackRange(racks)} affected`);
  }
  for (const id of gpus) {
    const g = snapshot?.gpus.find((x) => x.resource_id === id);
    if (!g) { parts.push(`${id} affected`); continue; }
    const xid = g.last_xid_code !== null ? `reported XID ${g.last_xid_code}` : null;
    const avail = g.availability !== 'ready' ? `is ${g.availability}` : null;
    parts.push(`${id} ${[xid, avail].filter(Boolean).join(' and ') || 'affected'}`);
  }
  if (!parts.length) return stripExample(incident.title);
  const text = parts.join('; ');
  // Capitalise a leading word, never a leading resource id such as gpu-r7-n1-0.
  return `${/^[a-z]+(?:\s|$)/.test(text) ? text.charAt(0).toUpperCase() + text.slice(1) : text}.`;
}

/** Shared cause vs independent, from what the incident groups. */
export function whyGrouped(incident: Incident, evidence: Evidence | null, otherIncidents: readonly Incident[]): string | null {
  const { all, cooling, racks, gpus } = linkedResources(incident.incident_id, evidence);
  const signals = signalsFor(incident.incident_id, evidence);
  const hypothesis = incident.hypothesis ? stripExample(incident.hypothesis) : null;
  if (!all.length) return hypothesis;
  const grouped: string[] = [];
  if (cooling.length && racks.length) grouped.push(`${list(cooling.map(pumpName))} and ${rackRange(racks)} share one cooling loop, so their symptoms were grouped as one cause`);
  else if (racks.length > 1) grouped.push(`${rackRange(racks)} were grouped as one cause`);
  else if (gpus.length === 1 && !cooling.length && !racks.length) grouped.push(`a single GPU fault, kept separate from ${otherIncidents.length ? 'the other incident' : 'everything else'}`);
  else grouped.push(`${all.length} resource${all.length === 1 ? '' : 's'} grouped`);
  const counts = signals.length ? `${signals.length} signal${signals.length === 1 ? '' : 's'} in the evidence window` : null;
  const head = `${grouped.join('; ')}${counts ? ` (${counts})` : ''}.`;
  const sentence = `${head.charAt(0).toUpperCase()}${head.slice(1)}`;
  return hypothesis ? `${sentence} ${hypothesis}` : sentence;
}

const OPTION_WORDS: Record<string, string> = { keep: 'keep running', ckpt: 'checkpoint', checkpoint: 'checkpoint', cap: 'power cap', power_cap: 'power cap', move: 'move', migrate_restart: 'move', cordon: 'cordon', cordon_gpu: 'cordon', escalate: 'escalate', uncordon: 'uncordon' };
/** `job-b:move:r7` → "move job-b to r7"; `gpu-r7-n1-0:cordon` → "cordon gpu-r7-n1-0"; unknown shapes return the id. */
export function optionPhrase(optionId: string): string {
  const [subject, op, dest] = optionId.split(':');
  if (!subject || !op) return optionId;
  const word = OPTION_WORDS[op] ?? op.replaceAll('_', ' ');
  return `${word} ${subject}${dest ? ` to ${dest}` : ''}`;
}

/** Chosen option(s) and who chose them, from the persisted candidates or the latest plan round in the events. */
export function decisionFor(wf: WorkflowRecord | null, events: readonly AgentEventInput[], actions: readonly ActionDetail[] = []): { text: string; actor: ActorTag } | null {
  if (!wf) return null;
  const wfEvents = events.filter((e) => e.workflow_id === wf.workflow_id).sort((a, b) => a.sim_time_ms - b.sim_time_ms || a.observed_unix_ms - b.observed_unix_ms);
  const persisted = persistedCandidateOptions(wf.state);
  const round = persisted ? null : latestCandidateRound(wfEvents);
  const options: CandidateOption[] = persisted ?? round?.options ?? [];
  const chosen = options.filter((o) => o.chosen === true);
  const denied = options.filter((o) => o.blocked);
  const actor: ActorTag = persisted ? actorTag(chosen[0]?.actor ?? null) : actorTag(round?.choice?.actor ?? null);
  const reason = typeof wf.state.reason === 'string' ? stripExample(wf.state.reason) : null;
  const parts: string[] = [];
  const planActions = wf.plan_id ? actions.filter((a) => a.command.plan_id === wf.plan_id) : [];
  const planEvent = [...wfEvents].reverse().find((e) => e.stage === 'plan');
  const ledgerActor: ActorTag = actorTag(planEvent?.actor ?? null);
  if (chosen.length) parts.push(`Chose to ${list(chosen.map((o) => optionPhrase(o.option_id)))}`);
  else if (planActions.length) parts.push(`${ledgerActor === 'CODE' ? 'Deterministic plan: ' : 'Planned to '}${list([...new Set(planActions.map((a) => commandPhrase(a.status.command_key, actions)))])}${options.length > 1 ? ` (over ${options.length - 1} other option${options.length === 2 ? '' : 's'})` : ''}`);
  else if (options.length) parts.push(`Weighed ${options.length} option${options.length === 1 ? '' : 's'}; no choice recorded yet`);
  if (denied.length) parts.push(`${denied.length} option${denied.length === 1 ? '' : 's'} denied by the safety check (${list(denied.map((o) => optionPhrase(o.option_id)))})`);
  if (wf.state.superseded === true && reason) parts.push(`Replanned because ${reason.replace(/\.$/, '')}`);
  if (!parts.length) {
    const last = wfEvents.at(-1);
    if (!last) return null;
    return { text: stripExample(last.summary), actor: actorTag(last.actor) };
  }
  return { text: `${parts.join('. ')}.`, actor: chosen.length ? actor : ledgerActor ?? actor };
}

const STAGE_LABEL: Record<string, string> = {
  idle: 'Waiting to start', triage: 'Triaging', diagnose: 'Diagnosing', plan: 'Planning', simulate: 'Simulating', safety: 'Safety check',
  execute: 'Executing', verify: 'Verifying', replan: 'Replanning', done: 'Done', escalated: 'Needs a human',
};

/** Stage chip + one-line verdict: verified / blocked / needs a human, from the workflow row and the incident's ledger actions. */
export function statusNow(incident: Incident, wf: WorkflowRecord | null, actions: readonly ActionDetail[]): StatusView {
  const stage = wf?.stage ?? 'idle';
  const stageLabel = STAGE_LABEL[stage] ?? stage;
  const verification = wf ? readVerification(wf.state) : null;
  const blocked = actions.filter((a) => a.command.incident_ids.includes(incident.incident_id) && blockedReason(a.status, a, reportedViolations(a)) !== null);
  const base = { incidentState: incident.state };
  if (incident.state === 'escalated' || stage === 'escalated' || verification?.escalate === true) {
    return { ...base, badge: 'Needs a human', tone: 'warning', sentence: verification?.nextStep ? `Handed to a human. Next: ${stripExample(verification.nextStep).replace(/\.$/, '')}.` : 'Handed to a human; the agents stopped here.' };
  }
  if (verification?.verified === true) return { ...base, badge: 'Verified', tone: 'agent', sentence: verification.unresolved.length ? 'Done; recovery verified, but the hardware still needs service.' : 'Done; recovery verified.' };
  if (verification?.verified === false) return { ...base, badge: 'Verification failed', tone: 'danger', sentence: 'The verification check failed.' };
  if (blocked.length && stage !== 'done') return { ...base, badge: 'Blocked', tone: 'warning', sentence: `${stageLabel}; ${blocked.length} action${blocked.length === 1 ? '' : 's'} blocked by the safety check.` };
  if (!wf) return { ...base, badge: incident.state === 'resolved' ? 'Resolved' : 'No workflow', tone: 'neutral', sentence: incident.state === 'resolved' ? 'Resolved.' : 'No agent workflow has picked this incident up yet.' };
  const current = wf.current_command_key && actions.some((a) => a.status.command_key === wf.current_command_key) ? commandPhrase(wf.current_command_key, actions) : null;
  return { ...base, badge: stageLabel, tone: stage === 'done' ? 'agent' : 'neutral', sentence: stage === 'done' ? 'Done.' : `${stageLabel}${current ? `; waiting on ${current}` : ''}.` };
}

export interface ExplainInput {
  incidents: readonly Incident[];
  evidence: Evidence | null;
  workflows: readonly WorkflowRecord[];
  events: readonly AgentEventInput[];
  actions: readonly ActionDetail[];
  snapshot: ObservedSnapshot | null;
  example: boolean;
}

const SEVERITY_TONE: Record<Incident['severity'], Tone> = { low: 'neutral', medium: 'neutral', high: 'warning', critical: 'danger' };

export function explainIncidents(input: ExplainInput): IncidentExplanation[] {
  const { incidents, evidence, workflows, events, actions, snapshot, example } = input;
  return incidents.map((incident) => {
    const wf = workflows.find((w) => w.workflow_id === workflowIdOf(incident.incident_id)) ?? workflows.find((w) => w.incident_ids.includes(incident.incident_id)) ?? null;
    const others = incidents.filter((i) => i.incident_id !== incident.incident_id);
    const { all } = linkedResources(incident.incident_id, evidence);
    return {
      incidentId: incident.incident_id,
      title: stripExample(incident.title),
      severity: incident.severity,
      severityTone: SEVERITY_TONE[incident.severity],
      whatHappened: whatHappened(incident, evidence, snapshot),
      why: whyGrouped(incident, evidence, others),
      decided: decisionFor(wf, events, actions),
      status: statusNow(incident, wf, actions),
      evidence: {
        incidentId: incident.incident_id, workflowId: wf?.workflow_id ?? null, planId: wf?.plan_id ?? null, linkedIds: all,
        signalCount: signalsFor(incident.incident_id, evidence).length,
        symptomCount: (evidence?.links ?? []).filter((l) => l.incident_id === incident.incident_id && l.link_kind === 'symptom').length,
        confidence: incident.confidence, openedSimMs: incident.opened_sim_time_ms,
      },
      example,
    };
  });
}

// ------------------------------------------------------------------------------------------------ evidence strip

export type FactKind = 'takeover' | 'resume' | 'verified' | 'no-duplicate' | 'blocked' | 'unresolved' | 'progress' | 'placement';
export interface RecoveredFact { key: string; kind: FactKind; text: string; tone: Tone; /** Tooltip with the raw ids behind the sentence. */ detail: string | null }

/** Derived facts only: takeovers, resumes, verification, actions skipped because already done, blocked actions with reasons. */
export function recoveredFacts(workflows: readonly WorkflowRecord[], events: readonly AgentEventInput[], actions: readonly ActionDetail[]): RecoveredFact[] {
  const out: RecoveredFact[] = [];
  for (const wf of workflows) {
    const wfEvents = events.filter((e) => e.workflow_id === wf.workflow_id).sort((a, b) => a.sim_time_ms - b.sim_time_ms || a.observed_unix_ms - b.observed_unix_ms);
    const wfActions = actions.filter((a) => a.command.workflow_id === wf.workflow_id);
    const resumed = resumeEvidence(wfEvents, wf.state);
    if (resumed && resumed.source === 'workflow_state') {
      const prev = processName(resumed.previous_owner);
      const next = processName(resumed.by_worker);
      const noDup = resumedWithoutDuplicate(wfEvents, wfActions, resumed);
      const tail = noDup === true ? ', nothing re-run' : noDup === false ? ', one action was repeated' : '';
      const count = resumed.count !== null && resumed.count > 1 ? ` (resume #${resumed.count})` : '';
      const text = prev && next && prev !== next
        ? `${next} took over from ${prev} at ${simAt(resumed.sim_time_ms)}${tail}${count}`
        : `${next ?? 'a new agent process'} resumed at ${simAt(resumed.sim_time_ms)}${tail}${count}`;
      out.push({ key: `${wf.workflow_id}-resume`, kind: prev && next && prev !== next ? 'takeover' : 'resume', text, tone: 'neutral', detail: `${wf.workflow_id} · ${resumed.detail}` });
    }
    const skipped = wfEvents.flatMap((e) => e.tool_calls.filter((t) => t.tool === 'get_action_status' && /→\s*skip\s*$/.test(t.result_summary)).map((t) => t.args_summary.trim()));
    for (const key of [...new Set(skipped)]) out.push({ key: `${wf.workflow_id}-skip-${key}`, kind: 'no-duplicate', text: `${commandPhrase(key, actions)} had already succeeded, so it was skipped rather than run twice`, tone: 'agent', detail: key });
    const v = readVerification(wf.state);
    if (v?.verified === true) {
      const window = v.asOf ? (v.asOf.from !== null ? `over sim ${duration(v.asOf.from)}–${duration(v.asOf.to)}` : `at ${simAt(v.asOf.to)}`) : null;
      const outcome = v.outcome ? stripExample(v.outcome) : null;
      out.push({ key: `${wf.workflow_id}-verified`, kind: 'verified', text: `Recovery verified${window ? ` ${window}` : ''}${outcome ? `: ${outcome}` : ''}${v.actions ? ` (${v.actions.verified.length} of ${v.actions.completed.length} completed action${v.actions.completed.length === 1 ? '' : 's'} checked)` : ''}`, tone: 'agent', detail: `${wf.workflow_id} · ${v.source ?? 'source not recorded'}` });
      for (const c of v.checkpointOutcome) out.push({ key: `${wf.workflow_id}-ckpt-${c.job_id}`, kind: 'progress', text: `${c.job_id} checkpoint ${c.status}${c.progress_work_units !== null ? ` at ${c.progress_work_units} work units` : ''}${c.accessible === false ? ', not accessible' : ''}`, tone: c.accessible === false ? 'warning' : 'neutral', detail: c.checkpoint_id });
      for (const p of v.placementOutcome) out.push({ key: `${wf.workflow_id}-place-${p.job_id}`, kind: 'placement', text: `${p.job_id} now runs on ${p.racks.length ? rackRange(p.racks) : `${p.gpu_ids.length} GPUs`}`, tone: 'neutral', detail: p.gpu_ids.join(', ') });
      for (const u of v.unresolved) out.push({ key: `${wf.workflow_id}-unresolved-${u}`, kind: 'unresolved', text: `Still needs a human: ${stripExample(u).replace(/\.$/, '')}`, tone: 'warning', detail: v.nextStep ? stripExample(v.nextStep) : null });
    } else if (v?.verified === false) {
      out.push({ key: `${wf.workflow_id}-verified`, kind: 'verified', text: `Verification failed${v.handoff ? `: ${stripExample(v.handoff)}` : ''}`, tone: 'danger', detail: wf.workflow_id });
    }
  }
  for (const a of actions) {
    const reason = blockedReason(a.status, a, reportedViolations(a));
    if (!reason) continue;
    out.push({ key: `blocked-${a.status.command_key}`, kind: 'blocked', text: `Blocked: ${commandPhrase(a.status.command_key, actions)} — ${reasonText(reason.code)}`, tone: 'danger', detail: `${a.status.command_key} · ${reason.code} (${reason.source})` });
  }
  return out;
}
