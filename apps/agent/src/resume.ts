// P3-8 crash + resume (ARCHITECTURE §6 "On any agent restart"). On boot, for every open workflow:
// reacquire the workflow lease (never steal a live one), read the persisted ExecuteState, query every
// command_key in the ledger and reconcile:
//   succeeded -> skip | running -> wait (DB supervises it) | requested -> claim + start
//   safety-rejected -> blocked | absent -> resubmit with the SAME key + payload
//   claimed by a dead owner -> wait for the claim lease to expire, then reclaim (new fencing token)
// then hand the persisted plan back to coordinator.execute (which re-checks each key itself) and verify.
//
// Agent-loop integration (`continueExecute`): instead of executing the persisted plan blind, resume hands it
// back to the loop's normal path (replan watcher attached, replan instead of escalate). Before that it checks
// whether the persisted plan is still valid against a FRESH snapshot: a key the DB safety-rejected, or a
// not-yet-submitted command that now fails evaluateSafety (e.g. an XID 79 landed on a destination GPU while
// the agent was dead), makes it invalid -> the loop waits for in-flight actions and runs runReplan(attempt+1).
// Exactly-once is unchanged: succeeded keys are never resubmitted, running ones are never re-requested.

import type { ActionCommand, ActionStatus, PlanCandidate } from '@dcos/contracts';
import {
  createCoordinator,
  DEFAULT_LEASE_MS,
  restampForSubmission,
  type CommandOutcome,
  type Coordinator,
  type ExecutablePlan,
  type ExecuteState,
  type ExecutionResult,
} from './coordinator.js';
import type { EventPublisher } from './events.js';
import { isDbError, isSafetyRejected, type DbPort, type PhysicsPort, type ToolCallSummary, type WorkflowRecord } from './ports.js';
import { verifyRecovery, DEFAULT_PROGRESS_WINDOW_SIM_MS, readHandoff, type OperatorHandoff } from './verify.js';

// ---------------------------------------------------------------------------
// Frozen API
// ---------------------------------------------------------------------------

export type ReconcileDecision =
  | 'skip'
  | 'wait'
  | 'claim_start'
  | 'resubmit_same_key'
  | 'blocked'
  | 'reclaim_after_timeout'
  | 'needs_operator';

export interface ResumeItem {
  workflow_id: string;
  stage: string;
  action: 'resumed_execute' | 'resumed_verify' | 'nothing_to_do' | 'took_over' | 'escalated';
  reconciled: Array<{ command_key: string; ledger_status: string | null; decision: ReconcileDecision }>;
  /** Extra context (e.g. LEASE_HELD_BY_LIVE_WORKER). Optional, additive to the frozen shape. */
  note?: string;
  /** The persisted operator handoff of a closed (done / escalated) workflow, as this fresh connection reads it. */
  handoff?: OperatorHandoff | null;
}

export interface ResumeReport {
  worker_id: string;
  items: ResumeItem[];
  duplicates_detected: number;
}

export interface ResumeDeps {
  db: DbPort;
  physics: PhysicsPort;
  events: EventPublisher;
  workerId: string;
  clock: { unixMs(): number; simTimeMs(): number };
  sleep?: (ms: number) => Promise<void>;
  leaseMs?: number;
  /**
   * Optional agent-loop hook for an `execute`-stage workflow: called after every key was reconciled, with the
   * coordinator that holds the workflow lease (heartbeat running). It replaces resume's own blind
   * execute + verify. Without it resume executes the persisted plan itself (standalone crash tests).
   */
  continueExecute?: (h: ResumeHandoff) => Promise<ResumeContinuation>;
}

export interface ResumeHandoff {
  workflow: WorkflowRecord;
  coordinator: Coordinator;
  plan: ExecutablePlan;
  state: ExecuteState;
  reconciled: ResumeItem['reconciled'];
  /** Why the persisted plan can no longer run as-is (fresh-snapshot safety), or null when it is still valid. */
  invalidReason: string | null;
}

export interface ResumeContinuation {
  escalated: boolean;
  /** Ownership lost (or a graceful stop) before the workflow closed. */
  aborted?: boolean;
  note?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const POLL_MS = 500;
/** DB claim lease on a claimed-but-never-started action (ARCHITECTURE §6 lease crash rule). */
export const CLAIM_LEASE_MS = 15_000;
/** Note on a ResumeItem whose workflow lease is held by a live worker (it was left alone). */
export const LEASE_HELD_BY_LIVE_WORKER = 'LEASE_HELD_BY_LIVE_WORKER';

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });

type Reconciled = ResumeItem['reconciled'][number];

export function classify(s: ActionStatus | null): ReconcileDecision {
  if (s === null) return 'resubmit_same_key';
  if (s.status === 'succeeded') return 'skip';
  if (isSafetyRejected(s)) return 'blocked';
  if (s.status === 'running') return 'wait';
  if (s.status === 'requested') return 'claim_start';
  if (s.status === 'claimed') return 'reclaim_after_timeout';
  return 'needs_operator'; // failed / cancelled / needs_reconciliation
}

function isExecuteState(v: Record<string, unknown>): v is ExecuteState {
  return typeof v.plan_id === 'string' && Array.isArray(v.command_keys) && Array.isArray(v.commands) && v.commands.length > 0;
}

const subject = (c: ActionCommand | undefined): string => (c ? `${c.operation} ${c.job_id ?? c.target_resource_id}` : '?');

/** Minimal PlanCandidate rebuilt from persisted state (DbPort has no plan read-back). */
function planFromState(st: ExecuteState, wf: WorkflowRecord): ExecutablePlan {
  const incidents = st.incident_ids.length ? st.incident_ids : wf.incident_ids.length ? wf.incident_ids : ['unknown'];
  const plan: PlanCandidate = {
    schema_version: '1.1.0',
    plan_id: st.plan_id,
    run_id: wf.run_id,
    workflow_id: wf.workflow_id,
    incident_ids: incidents as [string, ...string[]],
    based_on_decision_epoch: st.commands[0]?.expected_decision_epoch ?? 0,
    assumptions: ['resumed from persisted workflow state after agent restart'],
    command_keys: st.command_keys as [string, ...string[]],
    expected_completion_delay_sim_s: 0,
    expected_lost_work_units: 0,
    expected_gpu_busy_waste_s: 0,
    failure_risk_estimate: 0,
    explanation: 'resumed from persisted workflow state after agent restart',
  };
  return { plan, commands: st.commands.map((c) => structuredClone(c)) };
}

function resumeSummary(rec: Reconciled[], byKey: Map<string, ActionCommand>, invalidReason: string | null = null): string {
  const phrase: Record<ReconcileDecision, string> = {
    skip: 'already succeeded (skipped)',
    wait: 'still running under DB supervision (waiting)',
    claim_start: 'requested, ack lost (claiming + starting)',
    resubmit_same_key: 'not in ledger (submitting with the same key)',
    blocked: 'safety-rejected (stays blocked)',
    reclaim_after_timeout: 'claim lease expired (reclaimed)',
    needs_operator: 'needs operator reconciliation',
  };
  const parts = rec.map((r) => `${subject(byKey.get(r.command_key))} ${phrase[r.decision]}`);
  // Event summaries are clipped: lead with the invalidation so it is always visible.
  if (invalidReason) return `resumed after agent restart: persisted plan is invalid on a fresh snapshot (${invalidReason}), replanning; ${parts.join('; ')}`;
  const next = rec.find((r) => r.decision !== 'skip' && r.decision !== 'blocked');
  const tail = next ? `, continuing to ${subject(byKey.get(next.command_key))}` : ', nothing left to run';
  return `resumed after agent restart: ${parts.join('; ')}${tail}`;
}

// ---------------------------------------------------------------------------
// Per-workflow resume
// ---------------------------------------------------------------------------

interface Ctx extends ResumeDeps {
  sleep: (ms: number) => Promise<void>;
  leaseMs: number;
}

/** Claim the workflow lease; wait up to one lease length for a dead owner's lease to expire. */
async function acquire(ctx: Ctx, coord: Coordinator, wf: WorkflowRecord): Promise<boolean> {
  let waited = 0;
  let seenExpiry: number | null = null;
  for (;;) {
    try {
      await coord.ensureWorkflow(wf.workflow_id, wf.incident_ids);
      return true;
    } catch (e) {
      if (!isDbError(e, 'LEASE_HELD') && !isDbError(e, 'VERSION_CONFLICT')) throw e;
    }
    const cur = await ctx.db.getWorkflow(wf.workflow_id);
    if (!cur || cur.stage === 'done') return false;
    // The owner heartbeated while we waited: it is alive, leave it alone.
    if (seenExpiry !== null && cur.lease_expires_unix_ms > seenExpiry) return false;
    seenExpiry = cur.lease_expires_unix_ms;
    if (waited >= ctx.leaseMs + POLL_MS) return false;
    await ctx.sleep(POLL_MS);
    waited += POLL_MS;
  }
}

/**
 * A claimed-but-never-started action from a dead owner: we don't hold its fencing token. Wait for the
 * DB claim lease to lapse, reclaim it (new token) and start it ourselves so execute() sees `running`.
 */
async function reclaim(ctx: Ctx, coord: Coordinator, key: string, s0: ActionStatus): Promise<{ status: ActionStatus | null; decision: ReconcileDecision }> {
  let s: ActionStatus | null = s0;
  let waited = 0;
  while (s && s.status === 'claimed') {
    try {
      const { fencing_token } = await ctx.db.claimAction(key, s.version, ctx.workerId);
      try {
        const started = await ctx.db.startAction(key, fencing_token);
        // start_action can return a safety rejection: report it as blocked so the persisted plan gets replanned.
        return { status: started, decision: isSafetyRejected(started) ? 'blocked' : 'reclaim_after_timeout' };
      } catch {
        await ctx.db.cancelAction(key, 'RESUME_START_FAILED', fencing_token).catch(() => undefined);
        return { status: await ctx.db.getActionStatus(key), decision: 'needs_operator' };
      }
    } catch {
      // claim lease not expired yet (or DB doesn't release claims): wait and re-read
    }
    if (waited >= CLAIM_LEASE_MS + POLL_MS) return { status: s, decision: 'needs_operator' };
    await ctx.sleep(POLL_MS);
    waited += POLL_MS;
    await coord.heartbeatOnce();
    s = await ctx.db.getActionStatus(key);
  }
  // The DB moved it on while we waited (released to requested, or someone finished it).
  const d = classify(s);
  return { status: s, decision: d === 'claim_start' ? 'reclaim_after_timeout' : d };
}

async function reconcileKeys(ctx: Ctx, coord: Coordinator, st: ExecuteState): Promise<Reconciled[]> {
  const out: Reconciled[] = [];
  for (const key of st.command_keys) {
    let s = await ctx.db.getActionStatus(key);
    let decision = classify(s);
    if (decision === 'reclaim_after_timeout' && s) {
      const r = await reclaim(ctx, coord, key, s);
      s = r.status;
      decision = r.decision;
    }
    out.push({ command_key: key, ledger_status: s?.status ?? null, decision });
  }
  return out;
}

function waitSimVia(ctx: Ctx): (simMs: number) => Promise<void> {
  return async (simMs) => {
    const start = (await ctx.db.getObservedSnapshot()).clock.sim_time_ms;
    const maxPolls = Math.ceil((simMs * 4) / POLL_MS) + 20;
    for (let i = 0; i < maxPolls; i++) {
      await ctx.sleep(POLL_MS);
      if ((await ctx.db.getObservedSnapshot()).clock.sim_time_ms >= start + simMs) return;
    }
  };
}

/** Outcomes rebuilt from the ledger (for a crash during verify, or before a replan after resume). */
export async function outcomesFromLedger(db: DbPort, st: ExecuteState): Promise<CommandOutcome[]> {
  const out: CommandOutcome[] = [];
  for (const c of st.commands) {
    const s = await db.getActionStatus(c.command_key);
    const status: CommandOutcome['status'] =
      s?.status === 'succeeded' ? 'succeeded' : s && isSafetyRejected(s) ? 'blocked' : s ? 'failed' : 'skipped';
    const o: CommandOutcome = { command_key: c.command_key, operation: c.operation, status };
    if (c.job_id) o.job_id = c.job_id;
    if (status !== 'succeeded') o.reason_code = s?.reason_code ?? 'NOT_SUBMITTED';
    out.push(o);
  }
  return out;
}

const violationsOf = (s: ActionStatus): string[] => (Array.isArray(s.result.violations) ? s.result.violations.map(String) : []);

/**
 * First reason the persisted plan cannot run as-is on a fresh snapshot, or null. Checks keys the DB already
 * safety-rejected, then every not-yet-submitted command with the same local evaluateSafety the coordinator
 * would run right before submitting it (versions and decision_epoch re-stamped the same way: restampForSubmission).
 */
export async function persistedPlanInvalidReason(
  db: DbPort,
  physics: PhysicsPort,
  plan: ExecutablePlan,
  reconciled: ResumeItem['reconciled'],
): Promise<string | null> {
  const byKey = new Map(plan.commands.map((c) => [c.command_key, c]));
  const decision = new Map(reconciled.map((r) => [r.command_key, r.decision]));
  for (const r of reconciled) {
    if (r.decision !== 'blocked') continue;
    const s = await db.getActionStatus(r.command_key);
    const v = s ? violationsOf(s) : [];
    return `${subject(byKey.get(r.command_key))} was safety-rejected${v.length ? ` (${v.join(', ')})` : ''}`;
  }
  // This workflow's own succeeded commands (per the ledger): their effects are re-stamped, as the coordinator does.
  const own: ActionCommand[] = [];
  for (const c of plan.commands) {
    if (decision.get(c.command_key) === 'resubmit_same_key') continue;
    if (decision.get(c.command_key) === 'skip' || (await db.getActionStatus(c.command_key))?.status === 'succeeded') own.push(c);
  }
  let snap = await db.getObservedSnapshot();
  for (const c of plan.commands) {
    if (decision.get(c.command_key) !== 'resubmit_same_key') continue;
    let cmd = restampForSubmission(c, own, snap);
    let d = physics.evaluateSafety(snap, cmd, { decision_epoch: snap.clock.decision_epoch, leased_resource_ids: [] });
    if (d.decision === 'retry_new_snapshot') {
      snap = await db.getObservedSnapshot();
      cmd = restampForSubmission(c, own, snap);
      d = physics.evaluateSafety(snap, cmd, { decision_epoch: snap.clock.decision_epoch, leased_resource_ids: [] });
    }
    if (d.decision === 'allow' || (d.decision === 'needs_approval' && c.operation === 'escalate')) continue;
    const v = d.violations.length > 0 ? d.violations : [d.decision.toUpperCase()];
    return `${subject(c)} now fails safety (${v.join(', ')})`;
  }
  return null;
}

async function verifyAndClose(ctx: Ctx, coord: Coordinator, wfId: string, plan: ExecutablePlan, result: ExecutionResult) {
  return verifyRecovery(
    {
      db: ctx.db,
      events: ctx.events,
      physics: ctx.physics,
      waitSim: waitSimVia(ctx),
      persist: (stage, patch) => coord.updateStage(stage, patch),
      progressWindowSimMs: DEFAULT_PROGRESS_WINDOW_SIM_MS,
    },
    { workflowId: wfId, plan, result },
  );
}

async function resumeOne(ctx: Ctx, wf: WorkflowRecord): Promise<ResumeItem> {
  const base = { workflow_id: wf.workflow_id, stage: wf.stage, reconciled: [] as Reconciled[] };
  if (wf.stage === 'escalated' || wf.stage === 'done') {
    // Closed by a previous process: the durable handoff is what a fresh connection has to go on (R3 resume path).
    const handoff = await readHandoff(ctx.db, wf.workflow_id).catch(() => null);
    return { ...base, action: 'nothing_to_do', note: 'WAITING_FOR_OPERATOR', handoff };
  }

  const coord = createCoordinator({ db: ctx.db, physics: ctx.physics, events: ctx.events, workerId: ctx.workerId, clock: ctx.clock, sleep: ctx.sleep, leaseMs: ctx.leaseMs });
  if (!(await acquire(ctx, coord, wf))) return { ...base, action: 'nothing_to_do', note: LEASE_HELD_BY_LIVE_WORKER };

  const stage = coord.lease()?.workflow.stage ?? wf.stage;
  const state = coord.state();
  if ((stage !== 'execute' && stage !== 'verify') || !isExecuteState(state)) {
    // Lease taken; the main loop continues triage/plan from the persisted stage.
    return { ...base, stage, action: 'took_over' };
  }
  const plan = planFromState(state, coord.lease()?.workflow ?? wf);
  const byKey = new Map(plan.commands.map((c) => [c.command_key, c]));
  coord.startHeartbeat();
  try {
    if (stage === 'verify') {
      const outcomes = await outcomesFromLedger(ctx.db, state);
      const rec: Reconciled[] = [];
      for (const o of outcomes) {
        const s = await ctx.db.getActionStatus(o.command_key);
        rec.push({ command_key: o.command_key, ledger_status: s?.status ?? null, decision: classify(s) });
      }
      const result: ExecutionResult = { workflow_id: wf.workflow_id, plan_id: state.plan_id, outcomes, aborted: state.aborted, baseline: state.baseline };
      const report = await verifyAndClose(ctx, coord, wf.workflow_id, plan, result);
      return { ...base, stage, action: report.escalate ? 'escalated' : 'resumed_verify', reconciled: rec };
    }

    const rec = await reconcileKeys(ctx, coord, state);
    const toolCalls: ToolCallSummary[] = rec.map((r) => ({
      tool: 'get_action_status',
      args_summary: r.command_key,
      result_summary: `${r.ledger_status ?? 'absent'} → ${r.decision}`,
    }));
    const invalidReason = ctx.continueExecute ? await persistedPlanInvalidReason(ctx.db, ctx.physics, plan, rec) : null;
    await ctx.events.emit('execute', {
      workflowId: wf.workflow_id,
      incidentId: plan.plan.incident_ids[0],
      summary: resumeSummary(rec, byKey, invalidReason),
      toolCalls,
    });
    if (ctx.continueExecute) {
      const workflow = coord.lease()?.workflow ?? wf;
      const c = await ctx.continueExecute({ workflow, coordinator: coord, plan, state, reconciled: rec, invalidReason });
      const note = c.note ?? (invalidReason ? 'REPLANNED' : undefined);
      if (c.aborted) return { ...base, stage, action: 'nothing_to_do', reconciled: rec, note: note ? `${note};STOPPED` : 'STOPPED' };
      return { ...base, stage, action: c.escalated ? 'escalated' : 'resumed_execute', reconciled: rec, ...(note ? { note } : {}) };
    }
    const result = await coord.execute(wf.workflow_id, plan);
    if (result.aborted) return { ...base, stage, action: 'nothing_to_do', reconciled: rec, note: 'LOST_OWNERSHIP' };
    await coord.updateStage('verify', {});
    const report = await verifyAndClose(ctx, coord, wf.workflow_id, plan, result);
    return { ...base, stage, action: report.escalate ? 'escalated' : 'resumed_execute', reconciled: rec };
  } finally {
    coord.stopHeartbeat();
  }
}

/** Command keys with more than one completed checkpoint (the ledger is keyed by command_key). */
async function countDuplicates(db: DbPort, keys: string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const snap = await db.getObservedSnapshot();
  const wanted = new Set(keys);
  const perKey = new Map<string, number>();
  for (const cp of snap.checkpoints) {
    if (cp.status !== 'complete' || !cp.command_key || !wanted.has(cp.command_key)) continue;
    perKey.set(cp.command_key, (perKey.get(cp.command_key) ?? 0) + 1);
  }
  let dups = [...perKey.values()].filter((n) => n > 1).length;
  // A key listed twice in one plan would mean two ledger rows were intended for one logical step.
  dups += keys.length - wanted.size;
  return dups;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Resume ONE open workflow (same rules as resumeOpenWorkflows). The agent loop uses it to retry a workflow that
 * was skipped as LEASE_HELD_BY_LIVE_WORKER once that lease has expired.
 */
export async function resumeWorkflow(deps: ResumeDeps, wf: WorkflowRecord): Promise<ResumeItem> {
  return resumeOne({ ...deps, sleep: deps.sleep ?? realSleep, leaseMs: deps.leaseMs ?? DEFAULT_LEASE_MS }, wf);
}

export async function resumeOpenWorkflows(deps: ResumeDeps): Promise<ResumeReport> {
  const ctx: Ctx = { ...deps, sleep: deps.sleep ?? realSleep, leaseMs: deps.leaseMs ?? DEFAULT_LEASE_MS };
  const items: ResumeItem[] = [];
  const keys: string[] = [];
  for (const wf of await deps.db.listOpenWorkflows()) {
    const item = await resumeOne(ctx, wf);
    items.push(item);
    keys.push(...item.reconciled.map((r) => r.command_key));
  }
  return { worker_id: deps.workerId, items, duplicates_detected: await countDuplicates(deps.db, keys) };
}
