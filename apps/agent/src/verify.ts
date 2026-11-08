// P3-5 verifier: after execution, check from fresh snapshots that the recovery actually holds, attach the
// evidence to each succeeded action (verify_action) and write a short, evidence-cited operator handoff.
// Rules: a cordoned GPU is never "repaired"; anything unverified or stale -> "needs operator review".

import type { ActionCommand, ObservedSnapshot } from '@dcos/contracts';
import type { CommandOutcome, ExecutablePlan, ExecutionResult } from './coordinator.js';
import type { EventPublisher } from './events.js';
import type { DbPort, ToolCallSummary, WorkflowStage } from './ports.js';

export const MAX_HANDOFF_CHARS = 600;
export const DEFAULT_PROGRESS_WINDOW_SIM_MS = 10_000;

export interface VerifyDeps {
  db: DbPort;
  events: EventPublisher;
  /** Wait for `simMs` of simulated time between the two progress snapshots (default: poll the snapshot clock). */
  waitSim?: (simMs: number) => Promise<void>;
  /** Persist the final workflow stage; pass `coordinator.updateStage`. Omitted -> not persisted. */
  persist?: (stage: WorkflowStage, patch: Record<string, unknown>) => Promise<unknown>;
  progressWindowSimMs?: number;
}

export interface VerifyInput {
  workflowId: string;
  plan: ExecutablePlan;
  result: ExecutionResult;
}

export interface CommandCheck {
  command_key: string;
  operation: ActionCommand['operation'];
  job_id?: string;
  ok: boolean;
  /** One plain-English fact, used in the handoff. */
  note: string;
  evidence: Record<string, unknown>;
}

export interface VerificationReport {
  workflow_id: string;
  plan_id: string;
  checks: CommandCheck[];
  /** Every succeeded command verified and nothing blocked/failed/skipped/aborted. */
  verified: boolean;
  escalate: boolean;
  stage: 'done' | 'escalated';
  handoff: string;
  /** Snapshot sim times used as evidence. */
  as_of_sim_time_ms: [number, number];
}

const destOf = (cmd: ActionCommand): string[] =>
  Array.isArray(cmd.arguments.destination_gpu_ids) ? (cmd.arguments.destination_gpu_ids as string[]) : [];

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

function defaultWaitSim(db: DbPort): (simMs: number) => Promise<void> {
  return async (simMs) => {
    const start = (await db.getObservedSnapshot()).clock.sim_time_ms;
    const deadline = Date.now() + Math.max(5_000, simMs * 3);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      if ((await db.getObservedSnapshot()).clock.sim_time_ms >= start + simMs) return;
    }
  };
}

// ----------------------------------------------------------------- per-operation checks

function checkCheckpoint(cmd: ActionCommand, snap: ObservedSnapshot, result: ExecutionResult): CommandCheck {
  const jobId = cmd.job_id ?? cmd.target_resource_id;
  const job = snap.job_states.find((j) => j.job_id === jobId);
  const cp = snap.checkpoints.find((c) => c.command_key === cmd.command_key);
  const before = result.baseline?.durable_work_units[jobId];
  const ok =
    !!job &&
    !!cp &&
    cp.status === 'complete' &&
    cp.accessible &&
    job.durable_work_units >= cp.progress_work_units &&
    (before === undefined || job.durable_work_units > before);
  const note = ok
    ? `${jobId} checkpoint ${cp?.checkpoint_id} complete, durable ${before ?? '?'}→${job?.durable_work_units} wu`
    : `${jobId} checkpoint not confirmed durable`;
  return {
    command_key: cmd.command_key,
    operation: cmd.operation,
    job_id: jobId,
    ok,
    note,
    evidence: {
      checkpoint_id: cp?.checkpoint_id ?? null,
      checkpoint_status: cp?.status ?? null,
      accessible: cp?.accessible ?? null,
      durable_before: before ?? null,
      durable_after: job?.durable_work_units ?? null,
      sim_time_ms: snap.clock.sim_time_ms,
    },
  };
}

function checkMigrate(cmd: ActionCommand, s1: ObservedSnapshot, s2: ObservedSnapshot): CommandCheck {
  const jobId = cmd.job_id ?? cmd.target_resource_id;
  const dest = destOf(cmd);
  const j1 = s1.job_states.find((j) => j.job_id === jobId);
  const j2 = s2.job_states.find((j) => j.job_id === jobId);
  const onDest = !!j2 && sameSet(j2.allocated_gpu_ids, dest);
  const running = j2?.status === 'running';
  const progressing = !!j1 && !!j2 && j2.progress_work_units > j1.progress_work_units && s2.clock.sim_time_ms > s1.clock.sim_time_ms;
  const nodeIds = [...new Set(dest.map((g) => s2.gpus.find((x) => x.resource_id === g)?.node_id).filter((x): x is string => !!x))];
  const headroom: Record<string, { thermal_c: number; power_w: number }> = {};
  let headroomOk = nodeIds.length > 0;
  for (const id of nodeIds) {
    const n = s2.nodes.find((x) => x.resource_id === id);
    if (!n) {
      headroomOk = false;
      continue;
    }
    headroom[n.rack_id] = { thermal_c: n.thermal_headroom_c, power_w: n.power_headroom_w };
    if (n.thermal_headroom_c < 0 || n.power_headroom_w < 0) headroomOk = false;
  }
  const ok = onDest && running && progressing && headroomOk;
  const racks = Object.keys(headroom);
  const minHead = racks.length ? Math.min(...racks.map((r) => headroom[r]?.thermal_c ?? 0)) : NaN;
  const problems = [
    !onDest && 'not on planned GPUs',
    !running && `status ${j2?.status ?? 'unknown'}`,
    !progressing && 'progress not increasing',
    !headroomOk && 'destination headroom < 0',
  ].filter(Boolean);
  const note = ok
    ? `${jobId} running on ${dest.length} GPUs in ${racks.join(',')}; progress ${j1?.progress_work_units}→${j2?.progress_work_units} wu; headroom ≥${minHead} C`
    : `${jobId} move unverified (${problems.join('; ')})`;
  return {
    command_key: cmd.command_key,
    operation: cmd.operation,
    job_id: jobId,
    ok,
    note,
    evidence: {
      destination_gpu_ids: dest,
      allocated_gpu_ids: j2?.allocated_gpu_ids ?? [],
      job_status: j2?.status ?? null,
      progress_work_units: [j1?.progress_work_units ?? null, j2?.progress_work_units ?? null],
      sim_time_ms: [s1.clock.sim_time_ms, s2.clock.sim_time_ms],
      dest_headroom: headroom,
    },
  };
}

function checkCordon(cmd: ActionCommand, snap: ObservedSnapshot): CommandCheck {
  const gpuId = cmd.target_resource_id;
  const g = snap.gpus.find((x) => x.resource_id === gpuId);
  const allocated = snap.allocations.some((a) => a.gpu_id === gpuId);
  const ok = !!g && g.availability !== 'ready' && !allocated;
  const note = ok
    ? `${gpuId} still ${g?.availability} (not repaired), no jobs on it`
    : `${gpuId} cordon not holding (${g ? g.availability : 'missing'}${allocated ? ', allocated' : ''})`;
  return {
    command_key: cmd.command_key,
    operation: cmd.operation,
    ok,
    note,
    evidence: { gpu_id: gpuId, availability: g?.availability ?? null, allocated, last_xid_code: g?.last_xid_code ?? null, repaired: false },
  };
}

function checkOther(cmd: ActionCommand, snap: ObservedSnapshot): CommandCheck {
  const out: CommandCheck = {
    command_key: cmd.command_key,
    operation: cmd.operation,
    ok: true,
    note: `${cmd.operation} ${cmd.job_id ?? cmd.target_resource_id} succeeded`,
    evidence: { sim_time_ms: snap.clock.sim_time_ms },
  };
  if (cmd.job_id) out.job_id = cmd.job_id;
  return out;
}

/** GPUs the plan touched that are cordoned: report them as still cordoned, never as repaired. */
function cordonedNotes(plan: ExecutablePlan, snap: ObservedSnapshot, already: Set<string>): string[] {
  const ids = new Set<string>();
  for (const c of plan.commands) {
    ids.add(c.target_resource_id);
    for (const d of destOf(c)) ids.add(d);
  }
  return snap.gpus
    .filter((g) => ids.has(g.resource_id) && g.availability === 'cordoned' && !already.has(g.resource_id))
    .map((g) => `${g.resource_id} remains cordoned (not repaired)`);
}

// ----------------------------------------------------------------- handoff

function buildHandoff(checks: CommandCheck[], notOk: CommandOutcome[], extra: string[], escalate: boolean): string {
  const parts: string[] = [];
  for (const c of checks) parts.push(`${c.note} [${c.command_key}]`);
  for (const o of notOk) {
    const why = o.violations?.length ? o.violations.join(',') : (o.reason_code ?? o.status);
    parts.push(`${o.operation} ${o.job_id ?? ''} ${o.status} (${why}) [${o.command_key}]`.replace(/\s+/g, ' '));
  }
  parts.push(...extra);
  const head = escalate ? 'Needs operator review. ' : 'Recovery verified. ';
  const hasCordon = checks.some((c) => c.operation === 'cordon_gpu') || extra.length > 0;
  const tail = hasCordon ? ' Cordoned GPUs still need hardware service.' : '';
  let text = `${head}${parts.join('. ')}.${tail}`.replace(/\.\./g, '.');
  if (text.length > MAX_HANDOFF_CHARS) text = `${text.slice(0, MAX_HANDOFF_CHARS - 1)}…`;
  return text;
}

// ----------------------------------------------------------------- entry point

export async function verifyRecovery(deps: VerifyDeps, input: VerifyInput): Promise<VerificationReport> {
  const { db, events } = deps;
  const { workflowId, plan, result } = input;
  const waitSim = deps.waitSim ?? defaultWaitSim(db);
  const byKey = new Map(plan.commands.map((c) => [c.command_key, c]));
  const succeeded = result.outcomes.filter((o) => o.status === 'succeeded');
  const notOk = result.outcomes.filter((o) => o.status !== 'succeeded');

  const s1 = await db.getObservedSnapshot();
  const needsProgress = succeeded.some((o) => o.operation === 'migrate_restart');
  if (needsProgress) await waitSim(deps.progressWindowSimMs ?? DEFAULT_PROGRESS_WINDOW_SIM_MS);
  const s2 = needsProgress ? await db.getObservedSnapshot() : s1;

  const checks: CommandCheck[] = [];
  for (const o of succeeded) {
    const cmd = byKey.get(o.command_key);
    if (!cmd) continue;
    if (cmd.operation === 'checkpoint') checks.push(checkCheckpoint(cmd, s2, result));
    else if (cmd.operation === 'migrate_restart') checks.push(checkMigrate(cmd, s1, s2));
    else if (cmd.operation === 'cordon_gpu') checks.push(checkCordon(cmd, s2));
    else checks.push(checkOther(cmd, s2));
  }

  const toolCalls: ToolCallSummary[] = [];
  let ledgerOk = true;
  for (const c of checks) {
    try {
      await db.verifyAction(c.command_key, { verified: c.ok, note: c.note, ...c.evidence });
      toolCalls.push({ tool: 'verify_action', args_summary: c.command_key, result_summary: c.ok ? 'verified' : 'unverified' });
    } catch (e) {
      ledgerOk = false;
      toolCalls.push({ tool: 'verify_action', args_summary: c.command_key, result_summary: `error: ${(e as Error).message}` });
    }
  }

  const cordonedChecked = new Set(checks.filter((c) => c.operation === 'cordon_gpu').map((c) => String(c.evidence.gpu_id)));
  const extra = cordonedNotes(plan, s2, cordonedChecked);
  const verified = ledgerOk && notOk.length === 0 && !result.aborted && checks.length > 0 && checks.every((c) => c.ok);
  const escalate = !verified;
  const stage: VerificationReport['stage'] = escalate ? 'escalated' : 'done';
  const handoff = buildHandoff(checks, notOk, extra, escalate);

  await events.emit('verify', {
    workflowId,
    incidentId: plan.plan.incident_ids[0],
    summary: `${escalate ? 'needs operator review' : 'verified'}: ${checks.filter((c) => c.ok).length}/${checks.length} checks passed`,
    toolCalls,
  });
  await deps.persist?.(stage, { verification: { verified, escalate, handoff, as_of_sim_time_ms: s2.clock.sim_time_ms } });

  return {
    workflow_id: workflowId,
    plan_id: plan.plan.plan_id,
    checks,
    verified,
    escalate,
    stage,
    handoff,
    as_of_sim_time_ms: [s1.clock.sim_time_ms, s2.clock.sim_time_ms],
  };
}
