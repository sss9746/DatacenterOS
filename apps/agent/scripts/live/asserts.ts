// Pure assertion helpers for the R5 live recovery harness. Every function takes contract shapes
// (ObservedSnapshot pieces, ActionDetail[], WorkflowRecord[], Incident links) and returns a Check.
// Nothing here touches the network, the clock or the filesystem, so test/live/asserts.test.ts covers it.

import type { ActionStatus, Checkpoint, Incident, IncidentLink, JobGpuAllocation, JobState } from '@dcos/contracts';
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

// ------------------------------------------------------------------------------------ misc

export const allPassed = (checks: readonly Check[]): boolean => checks.every((c) => c.ok);

/** Sort GPU ids stably so two destination lists compare by content. */
export const sameGpuSet = (a: readonly string[], b: readonly string[]): boolean => [...a].sort().join() === [...b].sort().join();
