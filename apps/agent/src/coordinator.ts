// P3-5 coordinator: owns the workflow lease and drives a plan's commands through the durable action
// protocol (ARCHITECTURE §6): local safety pre-check -> request_action -> claim_action -> start_action ->
// wait for a terminal status. The workflow state is persisted after EVERY transition so that
// replan (P3-7, via `shouldAbort`) and crash-resume (P3-8, via the persisted `ExecuteState`) can pick up
// exactly where this left off. A command whose key already succeeded is skipped as succeeded, which is
// what makes re-running `execute` with the same plan (same keys) safe.

import type { ActionCommand, ActionStatus, ObservedSnapshot, PlanCandidate, SafetyDecision } from '@dcos/contracts';
import type { EventPublisher } from './events.js';
import {
  dbErrorCode,
  isDbError,
  isSafetyRejected,
  type ActionLifecycle,
  type DbPort,
  type PhysicsPort,
  type ToolCallSummary,
  type WorkflowLease,
  type WorkflowRecord,
  type WorkflowStage,
} from './ports.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Structural input from the planner (src/planner.ts exports the same shape). Commands are ordered. */
export interface ExecutablePlan {
  plan: PlanCandidate;
  commands: ActionCommand[];
}

export type OutcomeStatus = 'succeeded' | 'failed' | 'blocked' | 'skipped' | 'cancelled' | 'aborted';

export interface CommandOutcome {
  command_key: string;
  operation: ActionCommand['operation'];
  job_id?: string;
  status: OutcomeStatus;
  violations?: string[];
  reason_code?: string;
}

/** Durable work per job when the plan first started executing (used by verify). */
export interface ExecutionBaseline {
  sim_time_ms: number;
  durable_work_units: Record<string, number>;
}

export interface ExecutionResult {
  workflow_id: string;
  plan_id: string;
  outcomes: CommandOutcome[];
  aborted: boolean;
  /** Snapshot facts from before the first command ran (carried over on resume). */
  baseline?: ExecutionBaseline;
}

/**
 * Exact `workflow.state` persisted (stage 'execute') after every transition. P3-8 resumes from this:
 * rebuild `{ plan, commands }` from `commands` (the payloads as submitted, so a resubmit reuses the SAME
 * key AND payload) and call `execute` again; succeeded keys are skipped, running ones are waited on.
 */
export interface ExecuteState {
  [k: string]: unknown;
  plan_id: string;
  incident_ids: string[];
  command_keys: string[];
  commands: ActionCommand[];
  completed_keys: string[];
  blocked: Array<{ command_key: string; violations: string[] }>;
  failed: Array<{ command_key: string; reason_code: string }>;
  skipped: string[];
  current_command_key: string | null;
  current_status: ActionLifecycle | null;
  baseline: ExecutionBaseline;
  aborted: boolean;
}

export interface WaitForOptions {
  timeoutSimMs: number;
  /** Return early (non-terminal) when this becomes true, e.g. lost ownership. */
  cancelled: () => boolean;
}

/** Wait until `commandKey` reaches a terminal status; returns the last status seen (may be non-terminal on timeout). */
export type WaitFor = (commandKey: string, opts: WaitForOptions) => Promise<ActionStatus | null>;

export interface CoordinatorDeps {
  db: DbPort;
  physics: PhysicsPort;
  events: EventPublisher;
  workerId: string;
  /** Workflow lease length (default 15 000 wall ms); heartbeat every leaseMs/3. */
  leaseMs?: number;
  clock: { unixMs(): number; simTimeMs(): number };
  /** Called once when the workflow lease is lost (heartbeat or CAS failure). */
  onLostOwnership?: (reason: string) => void;
  /** Override how terminal status is awaited (default: onChange + polling getActionStatus). */
  waitFor?: WaitFor;
  /** Sleep used by the default waitFor between polls (default: real setTimeout). Tests tick FakeDb here. */
  sleep?: (wallMs: number) => Promise<void>;
  /** Poll interval of the default waitFor (default 500 wall ms). */
  pollMs?: number;
  /** Max sim time to wait for one action (default 15 sim-min). */
  actionTimeoutSimMs?: number;
}

export interface ExecuteOptions {
  /** P3-7 replan hook: checked before each new command; true -> stop cleanly. */
  shouldAbort?: () => boolean;
}

export interface Coordinator {
  ensureWorkflow(workflowId: string, incidentIds: string[]): Promise<WorkflowLease>;
  startHeartbeat(): void;
  stopHeartbeat(): void;
  /** One heartbeat; false (and onLostOwnership) if the lease is gone. */
  heartbeatOnce(): Promise<boolean>;
  /** Beat now if leaseMs/3 passed on the injected clock (or real time) since the last beat; no-op unless started. */
  heartbeatIfDue(): Promise<void>;
  execute(workflowId: string, plan: ExecutablePlan, opts?: ExecuteOptions): Promise<ExecutionResult>;
  /** CAS-persist a stage with `patch` merged over the last persisted state (used by verify). */
  updateStage(stage: WorkflowStage, patch: Record<string, unknown>): Promise<WorkflowRecord | null>;
  isOwner(): boolean;
  lease(): WorkflowLease | null;
  /** Last persisted workflow state. */
  state(): Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const DEFAULT_LEASE_MS = 15_000;
/** Real-time granularity at which the heartbeat ticker checks whether a beat is due. */
const HEARTBEAT_CHECK_MS = 1_000;
const DEFAULT_POLL_MS = 500;
const DEFAULT_ACTION_TIMEOUT_SIM_MS = 15 * 60_000;
const MAX_CLAIM_ATTEMPTS = 3;
const LOST_CODES = ['STALE_FENCING_TOKEN', 'LEASE_EXPIRED', 'LEASE_HELD', 'VERSION_CONFLICT', 'NOT_FOUND'] as const;

const TERMINAL = new Set<ActionLifecycle>(['succeeded', 'failed', 'cancelled', 'needs_reconciliation']);
export const isTerminal = (s: ActionStatus | null): boolean => s !== null && TERMINAL.has(s.status);

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });

const errCode = (e: unknown): string => dbErrorCode(e) ?? (e instanceof Error ? e.name || 'ERROR' : 'ERROR');
const isLostError = (e: unknown): boolean => LOST_CODES.some((c) => isDbError(e, c));

const subjectOf = (cmd: ActionCommand): string => cmd.job_id ?? cmd.target_resource_id;
const describe = (cmd: ActionCommand): string => {
  const dest = Array.isArray(cmd.arguments.destination_gpu_ids) ? (cmd.arguments.destination_gpu_ids as string[]) : [];
  return `${cmd.operation} ${subjectOf(cmd)}${dest.length ? ` → ${dest[0]}${dest.length > 1 ? ` +${dest.length - 1}` : ''}` : ''}`;
};

const violationsOf = (s: ActionStatus): string[] => {
  const v = s.result.violations;
  return Array.isArray(v) ? v.map(String) : [];
};

function baselineOf(snap: ObservedSnapshot): ExecutionBaseline {
  const durable: Record<string, number> = {};
  for (const j of snap.job_states) durable[j.job_id] = j.durable_work_units;
  return { sim_time_ms: snap.clock.sim_time_ms, durable_work_units: durable };
}

function versionIndex(snap: ObservedSnapshot): Map<string, number> {
  const m = new Map<string, number>();
  for (const g of snap.gpus) m.set(g.resource_id, g.version);
  for (const n of snap.nodes) m.set(n.resource_id, n.version);
  for (const c of snap.cooling) m.set(c.resource_id, c.version);
  for (const j of snap.job_states) m.set(j.job_id, j.version);
  return m;
}

/**
 * A dependency's own effect (e.g. a checkpoint bumping job-a's version) is anticipated by the plan, so
 * re-stamp only the resources (target, job) touched by this workflow's own succeeded commands (the coordinator
 * passes every in-plan command that succeeded; resume passes the ones the ledger shows succeeded, which include
 * the dependencies). Everything else (destination GPUs, nodes)
 * keeps its plan-time version, so an unexpected change there still fails safety. Only called for commands
 * that were never submitted (an existing ledger row is never re-requested).
 */
export function restampForDependencies(
  cmd: ActionCommand,
  depCommands: ActionCommand[],
  snap: ObservedSnapshot,
): ActionCommand {
  if (depCommands.length === 0) return cmd;
  const touched = new Set<string>();
  for (const d of depCommands) {
    touched.add(d.target_resource_id);
    if (d.job_id) touched.add(d.job_id);
  }
  const current = versionIndex(snap);
  const versions = { ...cmd.expected_resource_versions };
  let changed = false;
  for (const id of Object.keys(versions)) {
    const v = current.get(id);
    if (touched.has(id) && v !== undefined && v !== versions[id]) {
      versions[id] = v;
      changed = true;
    }
  }
  return changed ? { ...cmd, expected_resource_versions: versions } : cmd;
}

const destinationsOf = (cmd: ActionCommand): string[] =>
  Array.isArray(cmd.arguments.destination_gpu_ids) ? (cmd.arguments.destination_gpu_ids as string[]) : [];

/**
 * Why the decision_epoch move since plan time must NOT be re-stamped away, or null when it may be.
 * Run after restampForDependencies: every versioned resource the command names (target, job, destinations)
 * must still be at its expected version, so a version that moved WITHOUT this workflow's own commands touching
 * it is a material change to THIS command (a new XID or unavailability on the target/destinations, a job that
 * failed, ...). Destination GPUs must also still look placeable (ready, no latched XID). Epoch bumps from
 * anything else (unrelated GPUs throttling, other jobs) are non-material to this command.
 */
export function epochRestampBlocker(cmd: ActionCommand, snap: ObservedSnapshot): string | null {
  const current = versionIndex(snap);
  for (const [id, expected] of Object.entries(cmd.expected_resource_versions)) {
    const v = current.get(id);
    if (v !== undefined && v !== expected) return `${id} changed (v${expected} -> v${v})`;
  }
  for (const g of destinationsOf(cmd)) {
    const row = snap.gpus.find((x) => x.resource_id === g);
    if (!row) return `${g} missing`;
    if (row.availability !== 'ready') return `${g} ${row.availability}`;
    if (row.last_xid_code !== null && row.last_xid_code !== undefined) return `${g} xid ${row.last_xid_code}`;
  }
  return null;
}

/**
 * The payload to submit for a NOT-yet-submitted command (CONTRACTS §0.7 freshness). Real physics bumps
 * decision_epoch when a checkpoint starts and when it completes (and around a migrate), so a later plan step
 * carrying the plan-time epoch is always STALE_DECISION_EPOCH. So:
 *   1. re-stamp the resource versions this workflow's own succeeded commands changed (restampForDependencies);
 *   2. re-stamp `expected_decision_epoch` to the snapshot's CURRENT epoch, but only when nothing material
 *      touched this command's resources (epochRestampBlocker). Otherwise the plan-time epoch is kept, the
 *      command fails safety (local precheck / DB) and the replan path takes over.
 * Never call this for a key the ledger already has: an existing row is adopted, never re-requested.
 */
export function restampForSubmission(
  cmd: ActionCommand,
  ownCommands: ActionCommand[],
  snap: ObservedSnapshot,
): ActionCommand {
  const versioned = restampForDependencies(cmd, ownCommands, snap);
  const epoch = snap.clock.decision_epoch;
  if (versioned.expected_decision_epoch === epoch) return versioned;
  if (epochRestampBlocker(versioned, snap) !== null) return versioned;
  return { ...versioned, expected_decision_epoch: epoch };
}

/** Comparable view of the freshness fields re-stamping may change. */
const freshnessKey = (c: ActionCommand): string =>
  JSON.stringify([
    c.expected_decision_epoch,
    Object.entries(c.expected_resource_versions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export function createCoordinator(deps: CoordinatorDeps): Coordinator {
  const { db, physics, events, workerId, clock } = deps;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const baseSleep = deps.sleep ?? realSleep;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const actionTimeoutSimMs = deps.actionTimeoutSimMs ?? DEFAULT_ACTION_TIMEOUT_SIM_MS;
  const beatEveryMs = Math.max(1, Math.floor(leaseMs / 3));

  let current: WorkflowLease | null = null;
  let version = 0;
  let persisted: Record<string, unknown> = {};
  let lost = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatOn = false;
  let beating: Promise<boolean> | null = null;
  let lastBeatClockMs = 0;
  let lastBeatRealMs = 0;
  const markBeat = (): void => {
    lastBeatClockMs = clock.unixMs();
    lastBeatRealMs = Date.now();
  };

  const loseOwnership = (reason: string): void => {
    if (lost) return;
    lost = true;
    stopHeartbeat();
    deps.onLostOwnership?.(reason);
  };

  /** The injected sleep, followed by a heartbeat if one is due on the injected clock (see heartbeatIfDue). */
  const sleep = async (ms: number): Promise<void> => {
    await baseSleep(ms);
    await heartbeatIfDue();
  };

  const defaultWaitFor: WaitFor = async (commandKey, opts) => {
    const start = clock.simTimeMs();
    let wake: (() => void) | null = null;
    const unsub = db.onChange((c) => {
      if (c.kind === 'action_status' && c.status.command_key === commandKey) wake?.();
    });
    try {
      for (;;) {
        const s = await db.getActionStatus(commandKey);
        if (s === null || isTerminal(s) || opts.cancelled()) return s;
        if (clock.simTimeMs() - start > opts.timeoutSimMs) return s;
        await Promise.race([sleep(pollMs), new Promise<void>((r) => (wake = r))]);
        wake = null;
      }
    } finally {
      unsub();
    }
  };
  const waitFor = deps.waitFor ?? defaultWaitFor;

  async function ensureWorkflow(workflowId: string, incidentIds: string[]): Promise<WorkflowLease> {
    const existing = await db.getWorkflow(workflowId);
    const lease = await db.claimWorkflow(workflowId, workerId, existing?.version ?? 0, leaseMs);
    current = lease;
    version = lease.workflow.version;
    persisted = { ...lease.workflow.state };
    lost = false;
    markBeat(); // a claim is as good as a beat
    const known = new Set(lease.workflow.incident_ids);
    if (incidentIds.some((id) => !known.has(id))) {
      const merged = [...new Set([...lease.workflow.incident_ids, ...incidentIds])];
      await updateStage(lease.workflow.stage, { incident_ids: merged });
    }
    return current;
  }

  async function heartbeatOnce(): Promise<boolean> {
    if (!current || lost) return false;
    const sent = current;
    try {
      const lease = await db.heartbeatWorkflow(sent.workflow.workflow_id, workerId, sent.fencing_token, leaseMs);
      // A late reply from before a re-claim (older token) must never overwrite the current lease. On success only
      // the cached expiry is refreshed: heartbeat_workflow does not bump workflow.version (§0.11 #16), and the
      // workflow record / version are owned by claim + updateStage.
      if (!current || current.fencing_token !== sent.fencing_token || lease.fencing_token < current.fencing_token) return !lost;
      const expires = Math.max(current.lease_expires_unix_ms, lease.lease_expires_unix_ms);
      current = { ...current, lease_expires_unix_ms: expires, workflow: { ...current.workflow, lease_expires_unix_ms: expires } };
      return true;
    } catch (e) {
      if (!current || current.fencing_token !== sent.fencing_token) return !lost; // rejection of a superseded token
      if (isDbError(e, 'STALE_FENCING_TOKEN') || isDbError(e, 'LEASE_EXPIRED') || isDbError(e, 'LEASE_HELD') || isDbError(e, 'NOT_FOUND')) {
        loseOwnership(errCode(e));
        return false;
      }
      return true; // transient (network) error: try again next beat
    }
  }

  /**
   * Heartbeat scheduling. A beat is due once leaseMs/3 has passed on the INJECTED clock (the clock the lease is
   * judged by), or on real wall time (a floor that keeps the previous production behaviour when the injected clock
   * is frozen). Due-ness is checked (a) by a light real-time ticker and (b) after every injected sleep and before
   * every workflow write, so a harness that accelerates time through clock/sleep (no real time passes, the ticker
   * never fires) still beats before its lease expires. In production clock.unixMs() is Date.now(): same cadence.
   */
  async function heartbeatIfDue(): Promise<void> {
    if (!heartbeatOn || !current || lost || beating) return;
    const due = clock.unixMs() - lastBeatClockMs >= beatEveryMs || Date.now() - lastBeatRealMs >= beatEveryMs;
    if (!due) return;
    markBeat();
    beating = heartbeatOnce().finally(() => {
      beating = null;
    });
    await beating;
  }

  function scheduleTick(): void {
    timer = setTimeout(() => {
      if (!heartbeatOn) return;
      void heartbeatIfDue();
      scheduleTick();
    }, Math.min(beatEveryMs, HEARTBEAT_CHECK_MS));
    (timer as { unref?: () => void }).unref?.();
  }

  function startHeartbeat(): void {
    if (heartbeatOn || !current) return;
    heartbeatOn = true;
    markBeat();
    scheduleTick();
  }

  function stopHeartbeat(): void {
    heartbeatOn = false;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  async function updateStage(stage: WorkflowStage, patch: Record<string, unknown>): Promise<WorkflowRecord | null> {
    if (!current || lost) return null;
    await heartbeatIfDue();
    if (!current || lost) return null;
    const next = { ...persisted, ...patch };
    try {
      const rec = await db.updateWorkflow(current.workflow.workflow_id, version, current.fencing_token, stage, next);
      version = rec.version;
      persisted = next;
      current = { ...current, workflow: rec };
      return rec;
    } catch (e) {
      if (isLostError(e)) {
        loseOwnership(errCode(e));
        return null;
      }
      throw e;
    }
  }

  async function execute(workflowId: string, input: ExecutablePlan, opts: ExecuteOptions = {}): Promise<ExecutionResult> {
    if (lost && current?.workflow.workflow_id === workflowId) {
      // Ownership was lost: never silently re-claim; the caller (resume, P3-8) decides.
      return {
        workflow_id: workflowId,
        plan_id: input.plan.plan_id,
        outcomes: input.commands.map((c) => ({
          command_key: c.command_key,
          operation: c.operation,
          ...(c.job_id ? { job_id: c.job_id } : {}),
          status: 'aborted' as const,
          reason_code: 'LOST_OWNERSHIP',
        })),
        aborted: true,
      };
    }
    if (!current || current.workflow.workflow_id !== workflowId) {
      await ensureWorkflow(workflowId, [...input.plan.incident_ids]);
    }
    const run = new ExecutionRun(workflowId, input, opts);
    return run.go();
  }

  /** One pass over a plan. Kept as a class so per-run state is not shared between calls. */
  class ExecutionRun {
    private readonly outcomes: CommandOutcome[] = [];
    private readonly byKey = new Map<string, ActionCommand>();
    private readonly st: ExecuteState;
    private aborted = false;

    constructor(
      private readonly workflowId: string,
      private readonly input: ExecutablePlan,
      private readonly opts: ExecuteOptions,
    ) {
      for (const c of input.commands) this.byKey.set(c.command_key, c);
      const prev = persisted as Partial<ExecuteState>;
      const samePlan = prev.plan_id === input.plan.plan_id;
      this.st = {
        plan_id: input.plan.plan_id,
        incident_ids: [...new Set([...(current?.workflow.incident_ids ?? []), ...input.plan.incident_ids])],
        command_keys: input.commands.map((c) => c.command_key),
        commands: input.commands.map((c) => structuredClone(c)),
        completed_keys: [],
        blocked: [],
        failed: [],
        skipped: [],
        current_command_key: null,
        current_status: null,
        baseline: samePlan && prev.baseline ? prev.baseline : { sim_time_ms: 0, durable_work_units: {} },
        aborted: false,
      };
    }

    async go(): Promise<ExecutionResult> {
      if (this.st.baseline.sim_time_ms === 0 && Object.keys(this.st.baseline.durable_work_units).length === 0) {
        this.st.baseline = baselineOf(await db.getObservedSnapshot());
      }
      await this.persist();
      for (let i = 0; i < this.input.commands.length; i++) {
        const cmd = this.input.commands[i] as ActionCommand;
        if (lost || this.opts.shouldAbort?.()) {
          this.abortFrom(i, lost ? 'LOST_OWNERSHIP' : 'REPLAN_REQUESTED');
          break;
        }
        await this.runCommand(cmd, i);
        if (this.aborted) {
          this.abortFrom(i + 1, 'LOST_OWNERSHIP');
          break;
        }
      }
      this.st.current_command_key = null;
      this.st.current_status = null;
      this.st.aborted = this.aborted;
      await this.persist();
      return {
        workflow_id: this.workflowId,
        plan_id: this.input.plan.plan_id,
        outcomes: this.outcomes,
        aborted: this.aborted,
        baseline: this.st.baseline,
      };
    }

    private abortFrom(index: number, reason: string): void {
      this.aborted = true;
      for (const c of this.input.commands.slice(index)) this.record(c, { status: 'aborted', reason_code: reason });
    }

    private async persist(): Promise<void> {
      await updateStage('execute', { ...this.st, commands: this.st.commands });
    }

    private record(cmd: ActionCommand, o: Omit<CommandOutcome, 'command_key' | 'operation' | 'job_id'>): void {
      const outcome: CommandOutcome = { command_key: cmd.command_key, operation: cmd.operation, ...o };
      if (cmd.job_id) outcome.job_id = cmd.job_id;
      this.outcomes.push(outcome);
      if (o.status === 'succeeded') this.st.completed_keys.push(cmd.command_key);
      if (o.status === 'blocked') this.st.blocked.push({ command_key: cmd.command_key, violations: o.violations ?? [] });
      if (o.status === 'failed' || o.status === 'cancelled') {
        this.st.failed.push({ command_key: cmd.command_key, reason_code: o.reason_code ?? o.status });
      }
      if (o.status === 'skipped') this.st.skipped.push(cmd.command_key);
    }

    private async isSucceeded(key: string): Promise<boolean> {
      if (this.st.completed_keys.includes(key)) return true;
      if (this.byKey.has(key)) return false; // in-plan prerequisite that did not succeed this pass
      return (await db.getActionStatus(key))?.status === 'succeeded';
    }

    private async emitExec(cmd: ActionCommand, summary: string, toolCalls: ToolCallSummary[]): Promise<void> {
      await events.emit('execute', {
        workflowId: this.workflowId,
        incidentId: cmd.incident_ids[0],
        summary,
        actor: 'code',
        toolCalls: toolCalls.map((t) => ({ ...t, actor: 'code' as const })),
      });
    }

    private async runCommand(cmd: ActionCommand, index: number): Promise<void> {
      this.st.current_command_key = cmd.command_key;
      this.st.current_status = null;

      const existing = await db.getActionStatus(cmd.command_key);
      if (existing) {
        await this.adoptExisting(cmd, existing);
        return;
      }
      for (const dep of cmd.depends_on_command_keys) {
        if (!(await this.isSucceeded(dep))) {
          this.record(cmd, { status: 'skipped', reason_code: 'DEPENDENCY_NOT_SUCCEEDED' });
          await this.persist();
          return;
        }
      }
      // Never submitted (no ledger row): re-stamp freshness to the current snapshot (restampForSubmission).
      const own = this.input.commands.filter((c) => this.st.completed_keys.includes(c.command_key));
      let snap = await db.getObservedSnapshot();
      let toSubmit = restampForSubmission(cmd, own, snap);
      let d = this.evaluate(snap, toSubmit);
      if (d.decision === 'retry_new_snapshot') {
        // The snapshot moved under us: re-read, re-stamp with the same rules, re-check once.
        snap = await db.getObservedSnapshot();
        toSubmit = restampForSubmission(cmd, own, snap);
        d = this.evaluate(snap, toSubmit);
      }
      if (!(d.decision === 'allow' || (d.decision === 'needs_approval' && cmd.operation === 'escalate'))) {
        const violations = d.violations.length > 0 ? d.violations : [d.decision === 'needs_approval' ? 'NEEDS_APPROVAL' : 'RETRY_NEW_SNAPSHOT'];
        await this.block(toSubmit, violations, 'local');
        return;
      }
      const prev = this.st.commands[index];
      if (!prev || freshnessKey(prev) !== freshnessKey(toSubmit)) {
        // Persist the exact payload BEFORE submitting so a resume resubmits the same key + payload (or, if this
        // request landed, finds the key in the ledger and adopts it: a submitted key is never re-stamped).
        this.st.commands[index] = structuredClone(toSubmit);
        await this.persist();
        if (lost) {
          this.aborted = true;
          this.record(cmd, { status: 'aborted', reason_code: 'LOST_OWNERSHIP' });
          return;
        }
      }
      await this.submit(toSubmit);
    }

    /** Ledger already has this key (resume / re-run): never resubmit, just reconcile. */
    private async adoptExisting(cmd: ActionCommand, s: ActionStatus): Promise<void> {
      if (s.status === 'succeeded') {
        this.record(cmd, { status: 'succeeded', reason_code: 'ALREADY_SUCCEEDED' });
        await this.persist();
        return;
      }
      if (isSafetyRejected(s)) {
        await this.block(cmd, violationsOf(s), 'db');
        return;
      }
      await this.drive(cmd, s);
    }

    /** Local evaluateSafety against `snap` (the same check the request_action reducer re-runs). */
    private evaluate(snap: ObservedSnapshot, cmd: ActionCommand): SafetyDecision {
      return physics.evaluateSafety(snap, cmd, { decision_epoch: snap.clock.decision_epoch, leased_resource_ids: [] });
    }

    private async block(cmd: ActionCommand, violations: string[], where: 'local' | 'db' | 'start'): Promise<void> {
      this.record(cmd, { status: 'blocked', violations, reason_code: 'SAFETY_REJECTED' });
      await events.emit('safety', {
        workflowId: this.workflowId,
        incidentId: cmd.incident_ids[0],
        summary: `BLOCKED ${describe(cmd)}: ${violations.join(', ')}`,
        actor: 'code',
        toolCalls: [
          {
            tool: where === 'local' ? 'evaluate_safety' : where === 'start' ? 'start_action' : 'request_action',
            args_summary: describe(cmd),
            result_summary: `denied: ${violations.join(',')}`,
            actor: 'code',
          },
        ],
      });
      await this.persist();
    }

    private async submit(cmd: ActionCommand): Promise<void> {
      let s: ActionStatus;
      try {
        s = await db.requestAction(cmd);
      } catch (e) {
        // COMMAND_KEY_COLLISION is a bug (same key, different payload): fail, never retry under a new key.
        this.record(cmd, { status: 'failed', reason_code: errCode(e) });
        await this.emitExec(cmd, `request_action failed for ${describe(cmd)}: ${errCode(e)}`, [
          { tool: 'request_action', args_summary: describe(cmd), result_summary: errCode(e) },
        ]);
        await this.persist();
        return;
      }
      this.st.current_status = s.status;
      await this.persist();
      if (isSafetyRejected(s)) {
        await this.block(cmd, violationsOf(s), 'db');
        return;
      }
      if (s.status === 'succeeded') {
        this.record(cmd, { status: 'succeeded', reason_code: 'ALREADY_SUCCEEDED' });
        await this.persist();
        return;
      }
      await this.drive(cmd, s);
    }

    /** Move a ledger row forward from wherever it is to a terminal outcome. */
    private async drive(cmd: ActionCommand, initial: ActionStatus): Promise<void> {
      // Also reached after a claim conflict, when another worker's start was the one rejected.
      if (isSafetyRejected(initial)) {
        await this.block(cmd, violationsOf(initial), 'db');
        return;
      }
      let s = initial;
      const calls: ToolCallSummary[] = [{ tool: 'request_action', args_summary: describe(cmd), result_summary: s.status }];
      if (s.status === 'requested') {
        const started = await this.claimAndStart(cmd, s, calls);
        if (!started) return;
        // start_action's safety recheck can reject after the request was accepted; same outcome as on resume.
        if (isSafetyRejected(started)) {
          await this.block(cmd, violationsOf(started), 'start');
          return;
        }
        s = started;
      }
      if (s.status === 'claimed') {
        // Claimed by a previous owner whose fencing token we do not hold; the DB times it out. P3-8 reconciles.
        this.record(cmd, { status: 'failed', reason_code: 'NEEDS_RECONCILIATION' });
        await this.persist();
        return;
      }
      if (s.status === 'running') {
        await this.emitExec(cmd, `${describe(cmd)} running`, calls);
        const done = await waitFor(cmd.command_key, { timeoutSimMs: actionTimeoutSimMs, cancelled: () => lost });
        if (lost) {
          this.aborted = true;
          this.record(cmd, { status: 'aborted', reason_code: 'LOST_OWNERSHIP' });
          return;
        }
        if (!done || !isTerminal(done)) {
          this.record(cmd, { status: 'failed', reason_code: 'WAIT_TIMEOUT' });
          await this.persist();
          return;
        }
        s = done;
      }
      await this.finish(cmd, s);
    }

    private async claimAndStart(cmd: ActionCommand, s0: ActionStatus, calls: ToolCallSummary[]): Promise<ActionStatus | null> {
      let s = s0;
      for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
        let token: bigint;
        try {
          const claimed = await db.claimAction(cmd.command_key, s.version, workerId);
          token = claimed.fencing_token;
          s = claimed.status;
        } catch (e) {
          if (isDbError(e, 'VERSION_CONFLICT')) {
            const re = await db.getActionStatus(cmd.command_key);
            if (re && re.status === 'requested') {
              s = re;
              continue;
            }
            if (re) {
              await this.drive(cmd, re);
              return null;
            }
          }
          return this.failWith(cmd, errCode(e));
        }
        calls.push({ tool: 'claim_action', args_summary: cmd.command_key, result_summary: s.status });
        this.st.current_status = s.status;
        await this.persist();
        try {
          s = await db.startAction(cmd.command_key, token);
        } catch (e) {
          await db.cancelAction(cmd.command_key, `START_FAILED_${errCode(e)}`, token).catch(() => undefined);
          return this.failWith(cmd, errCode(e));
        }
        calls.push({ tool: 'start_action', args_summary: cmd.command_key, result_summary: s.status });
        this.st.current_status = s.status;
        await this.persist();
        return s;
      }
      return this.failWith(cmd, 'VERSION_CONFLICT');
    }

    private async failWith(cmd: ActionCommand, code: string): Promise<null> {
      this.record(cmd, { status: 'failed', reason_code: code });
      await this.persist();
      return null;
    }

    private async finish(cmd: ActionCommand, s: ActionStatus): Promise<void> {
      this.st.current_status = s.status;
      if (s.status === 'succeeded') this.record(cmd, { status: 'succeeded' });
      else if (s.status === 'cancelled') this.record(cmd, { status: 'cancelled', reason_code: s.reason_code ?? 'CANCELLED' });
      else this.record(cmd, { status: 'failed', reason_code: s.reason_code ?? s.status.toUpperCase() });
      await this.emitExec(cmd, `${describe(cmd)} ${s.status}`, [
        { tool: 'get_action_status', args_summary: cmd.command_key, result_summary: s.status },
      ]);
      await this.persist();
    }
  }

  return {
    ensureWorkflow,
    startHeartbeat,
    stopHeartbeat,
    heartbeatOnce,
    heartbeatIfDue,
    execute,
    updateStage,
    isOwner: () => current !== null && !lost,
    lease: () => current,
    state: () => persisted,
  };
}
