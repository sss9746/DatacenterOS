// Pure assertion helpers for the R5 live recovery harness. Every function takes contract shapes
// (ObservedSnapshot pieces, ActionDetail[], WorkflowRecord[], Incident links) and returns a Check.
// Nothing here touches the network, the clock or the filesystem, so test/live/asserts.test.ts covers it.

import type { ActionStatus, Checkpoint, Incident, IncidentLink, JobGpuAllocation, JobState, ObservedSnapshot } from '@dcos/contracts';
import type { ActionDetail, AgentEventInput, WorkflowRecord } from '@dcos/db-client';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** Structured evidence for the JSON artifact (ids, counts); never secrets. */
  evidence?: Record<string, unknown>;
}

export const check = (name: string, ok: boolean, detail: string, evidence?: Record<string, unknown>): Check =>
  evidence ? { name, ok, detail, evidence } : { name, ok, detail };

export const TERMINAL_STATUSES: ReadonlySet<ActionStatus['status']> = new Set(['succeeded', 'failed', 'cancelled']);
export const OPEN_STATUSES: ReadonlySet<ActionStatus['status']> = new Set(['requested', 'claimed', 'running', 'needs_reconciliation']);

// ------------------------------------------------------------------------------------ allocations

export interface AllocationReport {
  ok: boolean;
  /** gpu_id -> job_ids (only entries with more than one job). */
  doubled: Record<string, string[]>;
  /** Mismatches between job_gpu_allocation rows and job_state.allocated_gpu_ids. */
  inconsistent: string[];
}

/** No GPU may be allocated to two jobs; allocation rows and job states must agree. */
export function allocationUniqueness(allocations: readonly JobGpuAllocation[], jobStates: readonly JobState[]): AllocationReport {
  const byGpu = new Map<string, Set<string>>();
  for (const a of allocations) {
    const s = byGpu.get(a.gpu_id) ?? new Set<string>();
    s.add(a.job_id);
    byGpu.set(a.gpu_id, s);
  }
  for (const j of jobStates) {
    for (const g of j.allocated_gpu_ids) {
      const s = byGpu.get(g) ?? new Set<string>();
      s.add(j.job_id);
      byGpu.set(g, s);
    }
  }
  const doubled: Record<string, string[]> = {};
  for (const [g, jobs] of byGpu) if (jobs.size > 1) doubled[g] = [...jobs].sort();

  const inconsistent: string[] = [];
  const rowsByJob = new Map<string, Set<string>>();
  for (const a of allocations) {
    const s = rowsByJob.get(a.job_id) ?? new Set<string>();
    s.add(a.gpu_id);
    rowsByJob.set(a.job_id, s);
  }
  for (const j of jobStates) {
    const rows = rowsByJob.get(j.job_id) ?? new Set<string>();
    const state = new Set(j.allocated_gpu_ids);
    const same = rows.size === state.size && [...rows].every((g) => state.has(g));
    if (!same) inconsistent.push(`${j.job_id}: rows=[${[...rows].sort().join(',')}] state=[${[...state].sort().join(',')}]`);
  }
  return { ok: Object.keys(doubled).length === 0 && inconsistent.length === 0, doubled, inconsistent };
}

export function checkAllocationUniqueness(allocations: readonly JobGpuAllocation[], jobStates: readonly JobState[]): Check {
  const r = allocationUniqueness(allocations, jobStates);
  const parts = [
    ...Object.entries(r.doubled).map(([g, jobs]) => `${g} -> ${jobs.join('+')}`),
    ...r.inconsistent,
  ];
  return check('no GPU allocated to two jobs', r.ok, r.ok ? `${allocations.length} allocation rows, all unique` : parts.join(' | '), {
    doubled: r.doubled,
    inconsistent: r.inconsistent,
  });
}

// ------------------------------------------------------------------------------------ checkpoints

export interface CheckpointOnceReport {
  ok: boolean;
  completeForKey: number;
  writingForKey: number;
  failedForKey: number;
  newCompleteForJob: number;
}

/**
 * The checkpoint identified by `commandKey` completed exactly once (one `complete` row for the key, no
 * second `writing`), and the job gained exactly `expectNewForJob` complete checkpoints since `baselineCompleteForJob`.
 */
export function checkpointOnce(
  checkpoints: readonly Checkpoint[],
  commandKey: string,
  jobId: string,
  baselineCompleteForJob: number,
  expectNewForJob = 1,
): CheckpointOnceReport {
  const forKey = checkpoints.filter((c) => c.command_key === commandKey);
  const completeForKey = forKey.filter((c) => c.status === 'complete').length;
  const writingForKey = forKey.filter((c) => c.status === 'writing' || c.status === 'requested').length;
  const failedForKey = forKey.filter((c) => c.status === 'failed').length;
  const completeForJob = checkpoints.filter((c) => c.job_id === jobId && c.status === 'complete').length;
  const newCompleteForJob = completeForJob - baselineCompleteForJob;
  return {
    ok: completeForKey === 1 && writingForKey === 0 && newCompleteForJob === expectNewForJob,
    completeForKey,
    writingForKey,
    failedForKey,
    newCompleteForJob,
  };
}

export function checkCheckpointOnce(checkpoints: readonly Checkpoint[], commandKey: string, jobId: string, baseline: number): Check {
  const r = checkpointOnce(checkpoints, commandKey, jobId, baseline);
  return check(
    'checkpoint completed exactly once',
    r.ok,
    `complete_for_key=${r.completeForKey} writing_for_key=${r.writingForKey} failed_for_key=${r.failedForKey} new_complete_for_${jobId}=${r.newCompleteForJob}`,
    { command_key: commandKey, ...r },
  );
}

/** L5: no new durable checkpoint for the key (the write failed on the due tick) and the job's durable work did not grow. */
export function checkNoNewDurableCheckpoint(
  checkpoints: readonly Checkpoint[],
  commandKey: string,
  jobId: string,
  baselineCompleteForJob: number,
  durableBefore: number,
  durableAfter: number,
): Check {
  const r = checkpointOnce(checkpoints, commandKey, jobId, baselineCompleteForJob, 0);
  const ok = r.completeForKey === 0 && r.newCompleteForJob === 0 && durableAfter <= durableBefore + 1e-9;
  return check('no new durable checkpoint after source fault on due tick', ok, `complete_for_key=${r.completeForKey} failed_for_key=${r.failedForKey} durable ${durableBefore} -> ${durableAfter}`, {
    command_key: commandKey,
    ...r,
    durable_before: durableBefore,
    durable_after: durableAfter,
  });
}

// ------------------------------------------------------------------------------------ destinations

export interface PlannedDestination {
  command_key: string;
  job_id: string;
  gpu_ids: string[];
  /** Where the harness saw it: the public ledger row, or the workflow's persisted execute state. */
  source: 'ledger' | 'workflow_state';
  status: ActionStatus['status'] | 'planned';
}

const destArg = (args: Record<string, unknown> | undefined): string[] | null => {
  const d = args?.destination_gpu_ids;
  return Array.isArray(d) && d.length > 0 && d.every((x) => typeof x === 'string') ? [...(d as string[])] : null;
};

/**
 * Planned (not yet terminal) migrate destinations for `jobId`, read ONLY from public plan/ledger data:
 * open migrate_restart actions in the ledger, then migrate commands persisted in the workflow's execute
 * state that have not been submitted yet. Never guesses a rack.
 */
export function extractPlannedDestinations(details: readonly ActionDetail[], workflows: readonly WorkflowRecord[], jobId: string): PlannedDestination[] {
  const out: PlannedDestination[] = [];
  const seen = new Set<string>();
  for (const d of details) {
    const c = d.command;
    if (c.operation !== 'migrate_restart' || c.job_id !== jobId) continue;
    if (TERMINAL_STATUSES.has(d.status.status)) continue;
    const gpus = destArg(c.arguments);
    if (!gpus) continue;
    seen.add(c.command_key);
    out.push({ command_key: c.command_key, job_id: jobId, gpu_ids: gpus, source: 'ledger', status: d.status.status });
  }
  for (const wf of workflows) {
    const cmds = (wf.state as { commands?: unknown }).commands;
    if (!Array.isArray(cmds)) continue;
    for (const raw of cmds) {
      const c = raw as { operation?: unknown; job_id?: unknown; command_key?: unknown; arguments?: Record<string, unknown> };
      if (c.operation !== 'migrate_restart' || c.job_id !== jobId || typeof c.command_key !== 'string' || seen.has(c.command_key)) continue;
      const gpus = destArg(c.arguments);
      if (!gpus) continue;
      const completed = (wf.state as { completed_keys?: unknown }).completed_keys;
      if (Array.isArray(completed) && completed.includes(c.command_key)) continue;
      seen.add(c.command_key);
      out.push({ command_key: c.command_key, job_id: jobId, gpu_ids: gpus, source: 'workflow_state', status: 'planned' });
    }
  }
  return out;
}

/** The migrate that ended up running/succeeding for the job, with its destination. */
export function finalMigrate(details: readonly ActionDetail[], jobId: string): { command_key: string; status: ActionStatus['status']; gpu_ids: string[] } | null {
  const cands = details.filter((d) => d.command.operation === 'migrate_restart' && d.command.job_id === jobId && (d.status.status === 'succeeded' || d.status.status === 'running'));
  const best = cands.sort((a, b) => b.command.requested_sim_time_ms - a.command.requested_sim_time_ms)[0];
  if (!best) return null;
  return { command_key: best.command.command_key, status: best.status.status, gpu_ids: destArg(best.command.arguments) ?? [] };
}

/** L2: the move that targeted the failed GPU is cancelled/superseded/failed and the move that ran excludes it. */
export function checkDestinationReplanned(details: readonly ActionDetail[], jobId: string, obsoleteKey: string, failedGpu: string): Check[] {
  const obsolete = details.find((d) => d.command.command_key === obsoleteKey);
  const obsoleteStatus = obsolete?.status.status ?? 'absent';
  const obsoleteSettled = obsoleteStatus === 'cancelled' || obsoleteStatus === 'failed' || obsoleteStatus === 'absent';
  const out: Check[] = [
    check('obsolete move cancelled/superseded', obsoleteSettled, `${obsoleteKey}: ${obsoleteStatus}${obsolete?.status.reason_code ? ` (${obsolete.status.reason_code})` : ''}`, {
      command_key: obsoleteKey,
      status: obsoleteStatus,
      reason_code: obsolete?.status.reason_code ?? null,
    }),
  ];
  const final = finalMigrate(details, jobId);
  if (!final) {
    out.push(check('new destination excludes failed GPU', false, 'no running/succeeded migrate found for the job', { failed_gpu: failedGpu }));
    return out;
  }
  const excludes = !final.gpu_ids.includes(failedGpu) && final.command_key !== obsoleteKey;
  out.push(check('new destination excludes failed GPU', excludes, `${final.command_key} (${final.status}) -> [${final.gpu_ids.join(',')}]`, {
    command_key: final.command_key,
    status: final.status,
    gpu_ids: final.gpu_ids,
    failed_gpu: failedGpu,
  }));
  return out;
}

// ------------------------------------------------------------------------------------ command keys

export interface KeyDiff {
  retained: string[];
  added: string[];
  /** New keys whose (workflow, operation, subject) intent already existed before: a retry that minted a new key. */
  newKeysForExistingIntent: string[];
  changedPayload: string[];
}

/** `wf:operation:subject:n` -> `wf:operation:subject`. */
export const intentOf = (key: string): string => key.replace(/:(\d+)$/, '');

const payloadOf = (d: ActionDetail): string =>
  JSON.stringify({ op: d.command.operation, t: d.command.target_resource_id, j: d.command.job_id, a: d.command.arguments, dep: d.command.depends_on_command_keys });

/**
 * Compare ledger rows before and after a restart. A reconciled restart keeps every pre-kill key with the
 * same payload; a replan legitimately ADDS keys with a new ordinal, which the caller decides how to judge.
 */
export function diffCommandKeys(before: readonly ActionDetail[], after: readonly ActionDetail[]): KeyDiff {
  const b = new Map(before.map((d) => [d.command.command_key, d]));
  const a = new Map(after.map((d) => [d.command.command_key, d]));
  const retained: string[] = [];
  const changedPayload: string[] = [];
  for (const [k, d] of b) {
    const cur = a.get(k);
    if (!cur) continue;
    retained.push(k);
    if (payloadOf(cur) !== payloadOf(d)) changedPayload.push(k);
  }
  const added = [...a.keys()].filter((k) => !b.has(k));
  const intents = new Set([...b.keys()].map(intentOf));
  const newKeysForExistingIntent = added.filter((k) => intents.has(intentOf(k)));
  return { retained, added, newKeysForExistingIntent, changedPayload };
}

/**
 * L1: same accepted command keys reconciled. Every pre-kill key survives with the same payload, and no
 * new key was minted for an intent that already had one (that would be a duplicate retry).
 */
export function checkKeysReconciled(before: readonly ActionDetail[], after: readonly ActionDetail[], opts: { allowReplan?: boolean } = {}): Check {
  const d = diffCommandKeys(before, after);
  const lost = before.map((x) => x.command.command_key).filter((k) => !d.retained.includes(k));
  const dupRetry = opts.allowReplan ? [] : d.newKeysForExistingIntent;
  const ok = lost.length === 0 && d.changedPayload.length === 0 && dupRetry.length === 0;
  return check(
    'same accepted command keys reconciled',
    ok,
    ok
      ? `${d.retained.length} keys retained, ${d.added.length} added${opts.allowReplan ? ' (replan allowed)' : ''}`
      : [lost.length ? `lost: ${lost.join(',')}` : '', d.changedPayload.length ? `payload changed: ${d.changedPayload.join(',')}` : '', dupRetry.length ? `new key for existing intent: ${dupRetry.join(',')}` : '']
          .filter(Boolean)
          .join(' | '),
    { retained: d.retained, added: d.added, lost, changed_payload: d.changedPayload, new_keys_for_existing_intent: d.newKeysForExistingIntent },
  );
}

// ------------------------------------------------------------------------------------ workflows

export function checkWorkflowReclaimed(before: WorkflowRecord | null, after: WorkflowRecord | null): Check {
  if (!before || !after) return check('workflow reclaimed by fresh process', false, `before=${before?.workflow_id ?? 'none'} after=${after?.workflow_id ?? 'none'}`);
  const ownerChanged = after.lease_owner !== null && after.lease_owner !== before.lease_owner;
  const tokenAdvanced = after.fencing_token > before.fencing_token;
  const attemptUp = after.attempt > before.attempt;
  const ok = ownerChanged && tokenAdvanced && attemptUp;
  return check('workflow reclaimed by fresh process', ok, `owner ${before.lease_owner} -> ${after.lease_owner}, token ${before.fencing_token} -> ${after.fencing_token}, attempt ${before.attempt} -> ${after.attempt}`, {
    workflow_id: after.workflow_id,
    owner_before: before.lease_owner,
    owner_after: after.lease_owner,
    token_before: before.fencing_token.toString(),
    token_after: after.fencing_token.toString(),
    attempt_before: before.attempt,
    attempt_after: after.attempt,
  });
}

/** Final state: a verified recovery (`done`) or an explicit, reasoned escalation (`escalated` with a reason). */
export function checkRecoveredOrEscalated(wf: WorkflowRecord | null): Check {
  if (!wf) return check('workflow recovered or explicitly escalated', false, 'workflow missing');
  const reason = (wf.state as { escalation_reason?: unknown }).escalation_reason;
  if (wf.stage === 'done') return check('workflow recovered or explicitly escalated', true, 'done', { stage: wf.stage });
  if (wf.stage === 'escalated') {
    const ok = typeof reason === 'string' && reason.length > 0;
    return check('workflow recovered or explicitly escalated', ok, ok ? `escalated: ${String(reason)}` : 'escalated without a reason', { stage: wf.stage, reason: reason ?? null });
  }
  return check('workflow recovered or explicitly escalated', false, `stage ${wf.stage}`, { stage: wf.stage });
}

// ------------------------------------------------------------------------------------ settlement / handoff

export const SETTLED_STAGES: ReadonlySet<WorkflowRecord['stage']> = new Set(['done', 'escalated']);

export interface SettledReport {
  settled: boolean;
  /** Workflows still in a non-terminal stage, as `workflow_id@stage`. */
  pending: string[];
  total: number;
}

/**
 * Every workflow of the run is `done` or `escalated`. An empty list counts as settled (nothing is left
 * running); callers that need a minimum number of workflows check `total` themselves.
 */
export function allWorkflowsSettled(workflows: readonly WorkflowRecord[]): SettledReport {
  const pending = workflows.filter((w) => !SETTLED_STAGES.has(w.stage)).map((w) => `${w.workflow_id}@${w.stage}`);
  return { settled: pending.length === 0, pending, total: workflows.length };
}

export type Handoff =
  | { kind: 'verification'; verification: Record<string, unknown> }
  | { kind: 'escalation'; reason: string }
  | null;

/**
 * The handoff a workflow persisted for the operator: a non-empty `state.verification` object, or, for a
 * workflow that escalated WITHOUT verifying, a non-empty `state.escalation_reason`. Anything else (settled
 * with neither, or still running) is no handoff. Mirrors the L3 "fresh process recorded a handoff" rule.
 */
export function handoffOf(wf: WorkflowRecord): Handoff {
  const v = (wf.state as { verification?: unknown }).verification;
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length > 0) {
    return { kind: 'verification', verification: v as Record<string, unknown> };
  }
  const reason = (wf.state as { escalation_reason?: unknown }).escalation_reason;
  if (wf.stage === 'escalated' && typeof reason === 'string' && reason.length > 0) return { kind: 'escalation', reason };
  return null;
}

/** Per-workflow: the settled workflow left a handoff (verification object, or an escalation with a reason). */
export function checkHandoffRecorded(wf: WorkflowRecord): Check {
  const name = `handoff/verification persisted for ${wf.workflow_id}`;
  const h = handoffOf(wf);
  const evidence = { workflow_id: wf.workflow_id, stage: wf.stage, handoff: h?.kind ?? null };
  if (!h) {
    const v = (wf.state as { verification?: unknown }).verification;
    const vDesc = v === undefined ? 'absent' : v && typeof v === 'object' && !Array.isArray(v) ? 'empty object' : JSON.stringify(v).slice(0, 60);
    return check(name, false, `stage ${wf.stage}: state.verification ${vDesc}, no escalation_reason`, evidence);
  }
  if (h.kind === 'verification') return check(name, true, `stage ${wf.stage}: verification ${JSON.stringify(h.verification).slice(0, 160)}`, evidence);
  return check(name, true, `escalated: ${h.reason.slice(0, 160)}`, evidence);
}

// ------------------------------------------------------------------------------------ incidents

export interface IncidentSeparation {
  ok: boolean;
  coolingIncidentId: string | null;
  gpuIncidentId: string | null;
}

/** Two incidents: one linked to the cooling resources, another linked to the failed GPU (or its node); not the same row. */
export function incidentsAreSeparate(
  incidents: readonly Incident[],
  links: readonly IncidentLink[],
  coolingResourceIds: readonly string[],
  gpuResourceIds: readonly string[],
): IncidentSeparation {
  const cooling = new Set(coolingResourceIds);
  const gpu = new Set(gpuResourceIds);
  const live = new Set(incidents.map((i) => i.incident_id));
  const linkedTo = (ids: Set<string>) => links.filter((l) => l.link_kind === 'resource' && ids.has(l.linked_id) && live.has(l.incident_id)).map((l) => l.incident_id);
  const coolingIds = [...new Set(linkedTo(cooling))];
  const gpuIds = [...new Set(linkedTo(gpu))];
  const gpuOnly = gpuIds.filter((id) => !coolingIds.includes(id));
  const coolingOnly = coolingIds.filter((id) => !gpuIds.includes(id));
  const coolingIncidentId = coolingOnly[0] ?? coolingIds[0] ?? null;
  const gpuIncidentId = gpuOnly[0] ?? null;
  return { ok: coolingIncidentId !== null && gpuIncidentId !== null && coolingIncidentId !== gpuIncidentId, coolingIncidentId, gpuIncidentId };
}

export function checkSeparateIncidents(incidents: readonly Incident[], links: readonly IncidentLink[], coolingIds: readonly string[], gpuIds: readonly string[]): Check {
  const r = incidentsAreSeparate(incidents, links, coolingIds, gpuIds);
  return check('separate incident for the destination GPU fault', r.ok, `cooling=${r.coolingIncidentId ?? 'none'} gpu=${r.gpuIncidentId ?? 'none'} (${incidents.length} incidents)`, {
    cooling_incident_id: r.coolingIncidentId,
    gpu_incident_id: r.gpuIncidentId,
    incident_ids: incidents.map((i) => i.incident_id),
  });
}

// ------------------------------------------------------------------------------------ safety (L6)

/** Any action that ran or succeeded while carrying a nonempty violation list is a hard-safety breach. */
export function checkHardSafetyHeld(details: readonly ActionDetail[]): Check {
  const breaches = details.filter((d) => {
    const executed = d.status.status === 'running' || d.status.status === 'succeeded';
    const viol = (d.safety?.violations.length ?? 0) > 0 || (d.start_safety?.violations.length ?? 0) > 0 || d.safety?.decision === 'deny';
    return executed && viol;
  });
  return check('hard safety held (no violated action executed)', breaches.length === 0, breaches.length ? breaches.map((b) => `${b.command.command_key}: ${b.status.status} with ${[...(b.safety?.violations ?? []), ...(b.start_safety?.violations ?? [])].join('/')}`).join(' | ') : `${details.length} ledger rows, none executed with violations`, {
    breaches: breaches.map((b) => b.command.command_key),
  });
}

export interface FallbackAttribution {
  codeEvents: number;
  nemotronEvents: number;
  fallbackNotices: number;
  unattributed: number;
}

/** Every agent event names an actor; deterministic fallbacks are tagged `code` and say so in the summary. */
export function fallbackAttribution(events: readonly AgentEventInput[]): FallbackAttribution {
  let codeEvents = 0;
  let nemotronEvents = 0;
  let fallbackNotices = 0;
  let unattributed = 0;
  for (const e of events) {
    if (e.actor === 'code') codeEvents += 1;
    else if (e.actor === 'nemotron') nemotronEvents += 1;
    else unattributed += 1;
    if (/LLM unavailable|fallback|deterministic/i.test(e.summary) && e.actor === 'code') fallbackNotices += 1;
  }
  return { codeEvents, nemotronEvents, fallbackNotices, unattributed };
}

/**
 * L6: with the model unreachable, every event must carry an actor, at least one `code` event exists, and
 * NO event claims `nemotron` (a fallback that is attributed to the model would be a false claim).
 */
export function checkFallbackAttributed(events: readonly AgentEventInput[], opts: { expectNoNemotron: boolean }): Check {
  const r = fallbackAttribution(events);
  const ok = events.length > 0 && r.unattributed === 0 && r.codeEvents > 0 && (!opts.expectNoNemotron || r.nemotronEvents === 0);
  return check('fallback events attributed to actor code', ok, `events=${events.length} code=${r.codeEvents} nemotron=${r.nemotronEvents} fallback_notices=${r.fallbackNotices} unattributed=${r.unattributed}`, { ...r, events: events.length });
}

// ------------------------------------------------------------------------------------ team mode
//
// Local structural views of what the agent persists (the frozen interface, section 4). The team module is built
// separately and is deliberately not imported here: the harness judges the persisted JSON, not the agent's types.

export const TEAM_MAX_CALLS = 6;
const TEAM_ROLES: ReadonlySet<string> = new Set(['cooling', 'workload', 'lead']);
const SPECIALIST_ROLES: ReadonlySet<string> = new Set(['cooling', 'workload']);

export interface TeamMessageView {
  id: string;
  from: string;
  to: string;
  kind: string;
  summary: string;
  consumed_by: string[];
}

export interface TeamTraceView {
  /** 1 (no live progress) or 2. Absent only on hand-built views in tests. */
  version?: 1 | 2;
  /** v2 only: `running` / `interrupted` traces are never counted as rounds. */
  status?: 'running' | 'closed' | 'interrupted';
  round_id: string;
  snapshot_sim_ms: number;
  model: string | null;
  calls_used: number;
  wall_ms: number;
  outcome: 'lead' | 'deterministic';
  messages: TeamMessageView[];
  covers: { failed_role: string; covered_by: string }[];
  missing_roles: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

const isTeamMessage = (m: unknown): boolean =>
  isRecord(m) && typeof m.id === 'string' && typeof m.from === 'string' && typeof m.to === 'string' && typeof m.kind === 'string' && typeof m.summary === 'string' && isStringArray(m.consumed_by);

const isCover = (c: unknown): boolean => isRecord(c) && typeof c.failed_role === 'string' && typeof c.covered_by === 'string';

const TRACE_STATUSES: ReadonlySet<unknown> = new Set(['running', 'closed', 'interrupted']);

const isTeamCall = (c: unknown): boolean =>
  isRecord(c) && typeof c.role === 'string' && typeof c.phase === 'string' && typeof c.started_ms === 'number' && (c.ended_ms === null || typeof c.ended_ms === 'number') && typeof c.status === 'string';

/** v2 additions (live progress): status, phase, start time, budget and per-call records. */
const isV2Extension = (raw: Record<string, unknown>): boolean =>
  TRACE_STATUSES.has(raw.status) &&
  typeof raw.phase === 'string' &&
  typeof raw.started_unix_ms === 'number' &&
  isRecord(raw.budget) &&
  Array.isArray(raw.calls) &&
  raw.calls.every(isTeamCall);

/**
 * A persisted team trace (`state.team` or a `state.team_rounds.rounds` entry), or null when it does not have the
 * frozen shape. Version 1 and 2 are accepted; a v2 trace of any status parses (use `isClosedRound` to count it).
 * All original fields are kept.
 */
export function parseTeamTrace(raw: unknown): TeamTraceView | null {
  if (!isRecord(raw) || (raw.version !== 1 && raw.version !== 2)) return null;
  if (raw.version === 2 && !isV2Extension(raw)) return null;
  const ok =
    typeof raw.round_id === 'string' &&
    typeof raw.snapshot_sim_ms === 'number' &&
    (raw.model === null || typeof raw.model === 'string') &&
    typeof raw.calls_used === 'number' &&
    typeof raw.wall_ms === 'number' &&
    (raw.outcome === 'lead' || raw.outcome === 'deterministic') &&
    Array.isArray(raw.messages) &&
    raw.messages.every(isTeamMessage) &&
    Array.isArray(raw.covers) &&
    raw.covers.every(isCover) &&
    isStringArray(raw.missing_roles);
  return ok ? (raw as unknown as TeamTraceView) : null;
}

export interface ObservedRound {
  workflow_id: string;
  trace: TeamTraceView;
}

/** A finished round: every v1 trace, or a v2 trace whose status is `closed` (not `running` / `interrupted`). */
export const isClosedRound = (t: TeamTraceView): boolean => t.version !== 2 || t.status === 'closed';

/**
 * `state.team` holds the latest round and `state.team_rounds.rounds` the last few before it; the observer still
 * accumulates every closed round it sees across reads (deduped by workflow + round_id, the latest read wins).
 */
export interface TeamStore {
  rounds: Map<string, ObservedRound>;
  /** Workflows whose `state.team` (or a history entry) was present but did not have the frozen shape. */
  malformed: Set<string>;
}

export const newTeamStore = (): TeamStore => ({ rounds: new Map(), malformed: new Set() });

export function recordTeamRounds(store: TeamStore, workflows: readonly WorkflowRecord[]): void {
  for (const wf of workflows) {
    const state = wf.state as { team?: unknown; team_rounds?: unknown };
    const history = isRecord(state.team_rounds) && Array.isArray(state.team_rounds.rounds) ? state.team_rounds.rounds : [];
    if (state.team_rounds !== undefined && state.team_rounds !== null && !(isRecord(state.team_rounds) && Array.isArray(state.team_rounds.rounds))) {
      store.malformed.add(wf.workflow_id);
    }
    // Oldest first, then the current round: a later entry for the same round_id replaces an earlier one.
    for (const raw of [...history, state.team]) {
      if (raw === undefined || raw === null) continue;
      const trace = parseTeamTrace(raw);
      if (!trace) {
        store.malformed.add(wf.workflow_id);
        continue;
      }
      if (isClosedRound(trace)) store.rounds.set(`${wf.workflow_id}|${trace.round_id}`, { workflow_id: wf.workflow_id, trace });
    }
  }
}

export interface TeamCheckOptions {
  /** False when no model can decide (--no-llm, missing credentials, L6's forced outage): a `lead` outcome is then a false claim. */
  expectLead: boolean;
  malformed?: readonly string[];
}

/** Applied under --team-mode multi only. A fallback never satisfies the Lead check; it is named in the detail instead. */
export function checkTeamRounds(rounds: readonly ObservedRound[], opts: TeamCheckOptions): Check[] {
  const malformed = opts.malformed ?? [];
  const malformedNote = malformed.length ? `; malformed state.team on ${malformed.join(', ')}` : '';
  if (rounds.length === 0) {
    if (!opts.expectLead) return [check('team: no Lead claim without a model', malformed.length === 0, `no team round recorded${malformedNote}`, { rounds: 0, malformed })];
    return [check('team: round recorded', false, `no valid workflow.state.team observed${malformedNote}`, { rounds: 0, malformed })];
  }

  const lead = rounds.filter((r) => r.trace.outcome === 'lead');
  const fallback = rounds.filter((r) => r.trace.outcome === 'deterministic');
  const fallbackIds = fallback.map((r) => r.trace.round_id);
  const missing = [...new Set(fallback.flatMap((r) => r.trace.missing_roles))].sort();
  const fallbackNote = fallback.length ? `; FALLBACK to deterministic code in ${fallback.length} round(s) [${fallbackIds.join(', ')}]${missing.length ? `, missing roles: ${missing.join(',')}` : ''}` : '';
  const counts = { rounds: rounds.length, lead_rounds: lead.length, fallback_rounds: fallback.length, fallback_round_ids: fallbackIds, missing_roles: missing };

  const out: Check[] = [];
  if (opts.expectLead) {
    out.push(check('team: Lead decided', lead.length > 0, `${lead.length}/${rounds.length} round(s) decided by the Lead${fallbackNote}${malformedNote}`, counts));
    const answers = rounds.flatMap((r) => r.trace.messages.filter((m) => m.kind === 'answer' && SPECIALIST_ROLES.has(m.from)).map((m) => ({ round_id: r.trace.round_id, ...m })));
    const consumed = answers.filter((m) => m.consumed_by.length > 0);
    out.push(check('team: specialist answer consumed by a role', consumed.length > 0, consumed.length ? consumed.map((m) => `${m.id} ${m.from} -> [${m.consumed_by.join(',')}]`).join('; ') : `${answers.length} specialist answer(s), none reached a role's model input`, { answers: answers.length, consumed: consumed.map((m) => m.id) }));
  } else {
    out.push(check('team: no Lead claim without a model', lead.length === 0, `${fallback.length}/${rounds.length} round(s) deterministic, ${lead.length} claim the Lead${malformedNote}`, counts));
  }

  const over = rounds.filter((r) => !(r.trace.calls_used >= 0 && r.trace.calls_used <= TEAM_MAX_CALLS));
  out.push(check(`team: at most ${TEAM_MAX_CALLS} model calls per round`, over.length === 0, over.length ? over.map((r) => `${r.trace.round_id}: ${r.trace.calls_used} calls`).join('; ') : `max ${Math.max(...rounds.map((r) => r.trace.calls_used))} calls across ${rounds.length} round(s)`, { calls: rounds.map((r) => ({ round_id: r.trace.round_id, calls_used: r.trace.calls_used })) }));

  const coverProblems: string[] = [];
  const covers: string[] = [];
  for (const r of rounds) {
    for (const c of r.trace.covers) {
      covers.push(`${c.covered_by} covered ${c.failed_role}`);
      if (!TEAM_ROLES.has(c.failed_role) || !TEAM_ROLES.has(c.covered_by) || c.failed_role === c.covered_by) coverProblems.push(`${r.trace.round_id}: invalid cover ${c.covered_by} for ${c.failed_role}`);
    }
    if (r.trace.covers.length === 0 && r.trace.messages.some((m) => m.kind === 'cover')) coverProblems.push(`${r.trace.round_id}: cover message without a recorded cover`);
  }
  out.push(check('team: covers recorded with their roles', coverProblems.length === 0, coverProblems.length ? coverProblems.join('; ') : covers.length ? covers.join('; ') : 'no cover occurred', { covers }));
  return out;
}

// ------------------------------------------------------------------------------------ model provenance

export interface LlmLogStats {
  nemotron_ok: number;
  nemotron_failed: number;
  endpoint_failovers: number;
}

export const newLlmLogStats = (): LlmLogStats => ({ nemotron_ok: 0, nemotron_failed: 0, endpoint_failovers: 0 });

/** Counts the agent's own log lines (`nemotron ok`, `nemotron failed`, `nim endpoint_failed`). */
export function tallyLlmLogLine(stats: LlmLogStats, line: string): void {
  if (/\bnemotron ok\b/.test(line)) stats.nemotron_ok += 1;
  else if (/\bnemotron failed\b/.test(line)) stats.nemotron_failed += 1;
  else if (/\bnim endpoint_failed\b/.test(line)) stats.endpoint_failovers += 1;
}

export interface Provenance {
  /** What the harness configured; the fields below are what the run actually did. */
  configured_model: string;
  llm_mode: string;
  events: FallbackAttribution;
  log: LlmLogStats;
  team: { models: string[]; lead_rounds: number; fallback_rounds: number };
}

export function buildProvenance(configuredModel: string, llmMode: string, events: readonly AgentEventInput[], log: LlmLogStats, rounds: readonly ObservedRound[]): Provenance {
  return {
    configured_model: configuredModel,
    llm_mode: llmMode,
    events: fallbackAttribution(events),
    log: { ...log },
    team: {
      models: [...new Set(rounds.map((r) => r.trace.model).filter((m): m is string => m !== null))].sort(),
      lead_rounds: rounds.filter((r) => r.trace.outcome === 'lead').length,
      fallback_rounds: rounds.filter((r) => r.trace.outcome === 'deterministic').length,
    },
  };
}

export const describeProvenance = (p: Provenance): string =>
  `configured ${p.configured_model} (${p.llm_mode}); events nemotron=${p.events.nemotronEvents} code=${p.events.codeEvents} fallback_notices=${p.events.fallbackNotices}; log nemotron_ok=${p.log.nemotron_ok} nemotron_failed=${p.log.nemotron_failed} endpoint_failovers=${p.log.endpoint_failovers}; team models=[${p.team.models.join(',')}] lead=${p.team.lead_rounds} fallback=${p.team.fallback_rounds}`;

/** Scene B: every event names who decided, so model and code work cannot be confused in the evidence. */
export function checkProvenanceReported(p: Provenance): Check {
  const total = p.events.codeEvents + p.events.nemotronEvents + p.events.unattributed;
  return check('model/fallback provenance reported', total > 0 && p.events.unattributed === 0, describeProvenance(p), { ...p });
}

// ------------------------------------------------------------------------------------ Scene B

export interface RecoveryView {
  status: 'waiting' | 'resumed' | 'expired';
  job_ids: string[];
  blocked_reason: string;
  first_wait_unix_ms: number;
  attempts: number;
  fingerprint: string;
}

export function parseRecovery(raw: unknown): RecoveryView | null {
  if (!isRecord(raw)) return null;
  const ok =
    (raw.status === 'waiting' || raw.status === 'resumed' || raw.status === 'expired') &&
    isStringArray(raw.job_ids) &&
    typeof raw.blocked_reason === 'string' &&
    typeof raw.first_wait_unix_ms === 'number' &&
    typeof raw.attempts === 'number' &&
    typeof raw.fingerprint === 'string';
  return ok ? (raw as unknown as RecoveryView) : null;
}

export const recoveryOf = (wf: WorkflowRecord): RecoveryView | null => parseRecovery((wf.state as { recovery?: unknown }).recovery);

export interface RecoverySample {
  workflow_id: string;
  lease_owner: string | null;
  attempt: number;
  wall_unix_ms: number;
  recovery: RecoveryView;
}

const MAX_RECOVERY_SAMPLES = 400;

/** Append one sample per workflow whenever its recovery state or owner changes (bounded). */
export function recordRecoverySamples(samples: RecoverySample[], workflows: readonly WorkflowRecord[], wallUnixMs: number): void {
  for (const wf of workflows) {
    const recovery = recoveryOf(wf);
    if (!recovery) continue;
    const prev = samples.filter((s) => s.workflow_id === wf.workflow_id).at(-1);
    if (prev && prev.lease_owner === wf.lease_owner && prev.recovery.status === recovery.status && prev.recovery.first_wait_unix_ms === recovery.first_wait_unix_ms && prev.recovery.attempts === recovery.attempts) continue;
    if (samples.length >= MAX_RECOVERY_SAMPLES) samples.shift();
    samples.push({ workflow_id: wf.workflow_id, lease_owner: wf.lease_owner, attempt: wf.attempt, wall_unix_ms: wallUnixMs, recovery });
  }
}

/** Union of job ids currently waiting across every workflow. */
export function waitingJobIds(workflows: readonly WorkflowRecord[]): string[] {
  return [...new Set(workflows.flatMap((w) => {
    const r = recoveryOf(w);
    return r?.status === 'waiting' ? r.job_ids : [];
  }))].sort();
}

export function checkRecoveryWaiting(workflows: readonly WorkflowRecord[], expected: readonly string[], excluded: readonly string[]): Check {
  const waiting = waitingJobIds(workflows);
  const missing = expected.filter((j) => !waiting.includes(j));
  const wrong = excluded.filter((j) => waiting.includes(j));
  return check('recovery waiting for the checkpoint-backed jobs', missing.length === 0 && wrong.length === 0, `waiting=[${waiting.join(',')}]${missing.length ? ` missing=[${missing.join(',')}]` : ''}${wrong.length ? ` must_not_wait=[${wrong.join(',')}]` : ''}`, { waiting, missing, wrongly_waiting: wrong });
}

export interface NodeOutageView {
  allDown: boolean;
  allUp: boolean;
  unreachable: string[];
}

/** Observed node state only. `allUp` also requires every GPU on those nodes to be reachable again. */
export function nodeOutage(snapshot: Pick<ObservedSnapshot, 'nodes' | 'gpus'>, nodeIds: readonly string[]): NodeOutageView {
  const rows = nodeIds.map((id) => snapshot.nodes.find((n) => n.resource_id === id));
  const unreachable = rows.filter((n) => n?.availability === 'unreachable').map((n) => n!.resource_id);
  const ids = new Set(nodeIds);
  const gpusDown = snapshot.gpus.some((g) => ids.has(g.node_id) && g.availability === 'unreachable');
  return {
    allDown: rows.length > 0 && rows.every((n) => n?.availability === 'unreachable'),
    allUp: rows.length > 0 && rows.every((n) => n?.availability === 'ready') && !gpusDown,
    unreachable,
  };
}

/**
 * No migrate_restart may be requested inside [startSimMs, endSimMs). `endSimMs` is the true fault end, not when the
 * harness happened to observe the return, so polling lag cannot turn a legitimate restart into a violation.
 */
export function checkNoRestartDuringOutage(details: readonly ActionDetail[], startSimMs: number, endSimMs: number): Check {
  const bad = details.filter((d) => d.command.operation === 'migrate_restart' && d.command.requested_sim_time_ms >= startSimMs && d.command.requested_sim_time_ms < endSimMs);
  return check('no migrate_restart requested during the outage', bad.length === 0, bad.length ? bad.map((d) => `${d.command.command_key}@${d.command.requested_sim_time_ms}=${d.status.status}`).join(', ') : `none in sim [${startSimMs}, ${endSimMs})`, { start_sim_ms: startSimMs, end_sim_ms: endSimMs, violations: bad.map((d) => d.command.command_key) });
}

export interface CheckpointBaseline {
  job_id: string;
  checkpoint_id: string;
  durable_work_units: number;
}

/** The completed, accessible checkpoint a job could restart from, or null. */
export function checkpointBaseline(job: JobState | null, checkpoints: readonly Checkpoint[]): CheckpointBaseline | null {
  if (!job?.latest_checkpoint_id) return null;
  const row = checkpoints.find((c) => c.checkpoint_id === job.latest_checkpoint_id);
  if (!row || row.status !== 'complete' || !row.accessible) return null;
  return { job_id: job.job_id, checkpoint_id: row.checkpoint_id, durable_work_units: job.durable_work_units };
}

export function checkRestartFromCheckpoint(details: readonly ActionDetail[], job: JobState | null, checkpoints: readonly Checkpoint[], baseline: CheckpointBaseline, sinceSimMs: number): Check {
  const name = `${baseline.job_id} restarted from its completed checkpoint`;
  if (!job) return check(name, false, 'job state missing');
  const moved = finalMigrate(details.filter((d) => d.command.requested_sim_time_ms >= sinceSimMs), baseline.job_id);
  const problems: string[] = [];
  if (!moved) problems.push('no running/succeeded migrate_restart after the nodes returned');
  else {
    if (moved.status !== 'succeeded') problems.push(`migrate ${moved.status}`);
    if (!sameGpuSet(job.allocated_gpu_ids, moved.gpu_ids)) problems.push('job is not on the migrate destination');
  }
  if (job.status !== 'running' && job.status !== 'checkpointing' && job.status !== 'completed') problems.push(`job is ${job.status}`);
  const ck = checkpoints.find((c) => c.checkpoint_id === job.latest_checkpoint_id);
  if (!ck || ck.status !== 'complete' || !ck.accessible) problems.push(`latest checkpoint ${job.latest_checkpoint_id ?? 'none'} is not complete and accessible`);
  if (job.durable_work_units < baseline.durable_work_units) problems.push(`durable work fell to ${job.durable_work_units}`);
  if (job.progress_work_units < baseline.durable_work_units) problems.push(`progress ${job.progress_work_units} is below the checkpoint's ${baseline.durable_work_units}`);
  return check(name, problems.length === 0, problems.length ? problems.join('; ') : `${moved!.command_key} -> [${moved!.gpu_ids.join(',')}], checkpoint ${job.latest_checkpoint_id}, progress ${job.progress_work_units} >= ${baseline.durable_work_units}`, { job_id: baseline.job_id, baseline_checkpoint: baseline.checkpoint_id, latest_checkpoint: job.latest_checkpoint_id, command_key: moved?.command_key ?? null, problems });
}

export const checkWorkAdvanced = (jobId: string, before: number, after: number): Check =>
  check(`${jobId} work advancing after restart`, after > before, `progress ${before} -> ${after}`, { before, after });

/** Exactly one placement per job since the outage began: a duplicate restart after a crash would show up as two. */
export function checkSinglePlacement(details: readonly ActionDetail[], jobIds: readonly string[], sinceSimMs: number): Check {
  const counts = Object.fromEntries(jobIds.map((id) => [id, details.filter((d) => d.command.operation === 'migrate_restart' && d.command.job_id === id && d.command.requested_sim_time_ms >= sinceSimMs && (d.status.status === 'running' || d.status.status === 'succeeded')).map((d) => d.command.command_key)]));
  const bad = Object.entries(counts).filter(([, keys]) => keys.length !== 1);
  return check('exactly one placement per restarted job', bad.length === 0, Object.entries(counts).map(([id, keys]) => `${id}: ${keys.length} [${keys.join(',')}]`).join('; '), { placements: counts });
}

/** A job excluded from automatic restart must have no restart request at all since the outage, and stay failed. */
export function checkNotRestarted(details: readonly ActionDetail[], job: JobState | null, jobId: string, sinceSimMs: number): Check {
  const rows = details.filter((d) => d.command.operation === 'migrate_restart' && d.command.job_id === jobId && d.command.requested_sim_time_ms >= sinceSimMs);
  const ok = rows.length === 0 && job?.status === 'failed' && job.allocated_gpu_ids.length === 0;
  return check(`${jobId} not restarted`, ok, `${rows.length} restart request(s) [${rows.map((d) => `${d.command.command_key}=${d.status.status}`).join(',')}]; job ${job?.status ?? 'missing'} on [${job?.allocated_gpu_ids.join(',') ?? ''}]`, { requests: rows.map((d) => d.command.command_key), status: job?.status ?? null });
}

/** The job is named in a persisted operator handoff, or in an `escalate` action targeting it. */
export function checkJobInOperatorHandoff(workflows: readonly WorkflowRecord[], details: readonly ActionDetail[], jobId: string): Check {
  const named = new RegExp(`(?<![\\w-])${jobId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
  const handoffs = workflows.filter((w) => {
    const h = handoffOf(w);
    return h !== null && named.test(h.kind === 'verification' ? JSON.stringify(h.verification) : h.reason);
  }).map((w) => w.workflow_id);
  const escalations = details.filter((d) => d.command.operation === 'escalate' && (d.command.job_id === jobId || d.command.target_resource_id === jobId)).map((d) => d.command.command_key);
  return check(`${jobId} handed off to an operator`, handoffs.length + escalations.length > 0, `handoffs=[${handoffs.join(',')}] escalations=[${escalations.join(',')}]`, { handoffs, escalations });
}

/** SBK: the fresh process kept the original wait start, so the 120 s deadline really survives the restart. */
export function checkFirstWaitPreserved(before: RecoverySample, samples: readonly RecoverySample[]): Check {
  const name = `first_wait_unix_ms preserved for ${before.workflow_id}`;
  const after = samples.filter((s) => s.workflow_id === before.workflow_id && s.lease_owner !== null && s.lease_owner !== before.lease_owner);
  if (after.length === 0) return check(name, false, `no recovery state observed from a new owner (old owner ${before.lease_owner})`, { first_wait_unix_ms: before.recovery.first_wait_unix_ms });
  const changed = after.filter((s) => s.recovery.first_wait_unix_ms !== before.recovery.first_wait_unix_ms);
  return check(name, changed.length === 0, changed.length ? `changed to ${changed.map((s) => s.recovery.first_wait_unix_ms).join(',')}` : `${before.recovery.first_wait_unix_ms} across ${after.length} sample(s) from the new owner`, { first_wait_unix_ms: before.recovery.first_wait_unix_ms, new_owner_samples: after.length });
}

// ------------------------------------------------------------------------------------ misc

export const allPassed = (checks: readonly Check[]): boolean => checks.every((c) => c.ok);

/** Sort GPU ids stably so two destination lists compare by content. */
export const sameGpuSet = (a: readonly string[], b: readonly string[]): boolean => [...a].sort().join() === [...b].sort().join();
