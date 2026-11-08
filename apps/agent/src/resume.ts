// P3-8 crash + resume (ARCHITECTURE §6 "On any agent restart"). On boot, for every open workflow:
// reacquire the workflow lease (never steal a live one), read the persisted ExecuteState, query every
// command_key in the ledger and reconcile:
//   succeeded -> skip | running -> wait (DB supervises it) | requested -> claim + start
//   safety-rejected -> blocked | absent -> resubmit with the SAME key + payload
//   claimed by a dead owner -> wait for the claim lease to expire, then reclaim (new fencing token)
// then hand the persisted plan back to coordinator.execute (which re-checks each key itself) and verify.

import type { ActionCommand, ActionStatus, PlanCandidate } from '@dcos/contracts';
import {
  createCoordinator,
  DEFAULT_LEASE_MS,
  type CommandOutcome,
  type Coordinator,
  type ExecutablePlan,
  type ExecuteState,
  type ExecutionResult,
} from './coordinator.js';
import type { EventPublisher } from './events.js';
import { isDbError, isSafetyRejected, type DbPort, type PhysicsPort, type ToolCallSummary, type WorkflowRecord } from './ports.js';
import { verifyRecovery, DEFAULT_PROGRESS_WINDOW_SIM_MS } from './verify.js';

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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const POLL_MS = 500;
/** DB claim lease on a claimed-but-never-started action (ARCHITECTURE §6 lease crash rule). */
export const CLAIM_LEASE_MS = 15_000;

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

function resumeSummary(rec: Reconciled[], byKey: Map<string, ActionCommand>): string {
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
        return { status: await ctx.db.startAction(key, fencing_token), decision: 'reclaim_after_timeout' };
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

/** Outcomes rebuilt from the ledger (for a crash during verify). */
async function outcomesFromLedger(db: DbPort, st: ExecuteState): Promise<CommandOutcome[]> {
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

async function verifyAndClose(ctx: Ctx, coord: Coordinator, wfId: string, plan: ExecutablePlan, result: ExecutionResult) {
  return verifyRecovery(
    {
      db: ctx.db,
      events: ctx.events,
      waitSim: waitSimVia(ctx),
      persist: (stage, patch) => coord.updateStage(stage, patch),
      progressWindowSimMs: DEFAULT_PROGRESS_WINDOW_SIM_MS,
    },
    { workflowId: wfId, plan, result },
  );
}

async function resumeOne(ctx: Ctx, wf: WorkflowRecord): Promise<ResumeItem> {
  const base = { workflow_id: wf.workflow_id, stage: wf.stage, reconciled: [] as Reconciled[] };
  if (wf.stage === 'escalated' || wf.stage === 'done') return { ...base, action: 'nothing_to_do', note: 'WAITING_FOR_OPERATOR' };

  const coord = createCoordinator({ db: ctx.db, physics: ctx.physics, events: ctx.events, workerId: ctx.workerId, clock: ctx.clock, sleep: ctx.sleep, leaseMs: ctx.leaseMs });
  if (!(await acquire(ctx, coord, wf))) return { ...base, action: 'nothing_to_do', note: 'LEASE_HELD_BY_LIVE_WORKER' };

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
    await ctx.events.emit('execute', {
      workflowId: wf.workflow_id,
      incidentId: plan.plan.incident_ids[0],
      summary: resumeSummary(rec, byKey),
      toolCalls,
    });
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
