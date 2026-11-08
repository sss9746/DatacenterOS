// ===========================================================================
//  TEST-ONLY. In-memory stand-in for @dcos/db-client (P2 / SpacetimeDB).
//  NOT a second state store: never import this from apps/agent/src/**.
//  It models just enough reducer semantics (idempotency, collisions, CAS,
//  fencing, lifecycle) for agent unit tests.
// ===========================================================================

import { createHash } from 'node:crypto';
import {
  validatePayload,
  type ActionCommand,
  type ActionStatus,
  type Checkpoint,
  type Incident,
  type IncidentLink,
  type ObservedSnapshot,
  type PlanCandidate,
  type SignalEvent,
  type TelemetryEvent,
} from '@dcos/contracts';
import {
  DbError,
  type AgentEventInput,
  type DbChange,
  type DbPort,
  type Evidence,
  type PhysicsPort,
  type SymptomRecord,
  type WorkflowLease,
  type WorkflowRecord,
  type WorkflowStage,
} from '../../src/ports.js';

export interface FakeDbCall {
  method: keyof DbPort | string;
  args: unknown[];
}

export interface FakeDbOptions {
  snapshot: ObservedSnapshot;
  /** Wall clock for leases (default: a manual clock starting at 1_794_091_200_000; see advanceWallMs). */
  now?: () => number;
  /** If given, requestAction re-runs evaluateSafety like the real reducer does. */
  physics?: PhysicsPort;
  /** Duration of non-checkpoint/non-migrate operations once running (default 0 = next tick). */
  defaultOpDurationMs?: number;
}

export interface FakeActionEvent {
  command_key: string;
  status: ActionStatus['status'];
  reason_code: string | null;
  version: number;
  sim_time_ms: number;
}

interface ActionRecord {
  cmd: ActionCommand;
  payloadHash: string;
  status: ActionStatus;
  fencingToken: bigint | null;
  dueSimMs: number | null;
}

const V = '1.1.0' as const;
const TERMINAL: ReadonlySet<ActionStatus['status']> = new Set(['succeeded', 'failed', 'cancelled']);

/** Key-sorted JSON, so hashes don't depend on property order. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableStringify(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Payload hash used for collision detection: every field except requested_sim_time_ms. */
export function commandPayloadHash(cmd: ActionCommand): string {
  const { requested_sim_time_ms: _ignored, ...semantic } = cmd;
  return createHash('sha256').update(stableStringify(semantic)).digest('hex');
}

const clone = <T>(v: T): T => structuredClone(v);

export class FakeDb implements DbPort {
  readonly calls: FakeDbCall[] = [];
  readonly agentEvents: AgentEventInput[] = [];
  /** Append-only `action_event` log: one row per ActionStatus creation/transition (incl. safety rejections). */
  readonly actionEvents: FakeActionEvent[] = [];
  readonly plans = new Map<string, PlanCandidate>();
  readonly incidents = new Map<string, Incident>();
  readonly links: IncidentLink[] = [];
  readonly signals: SignalEvent[] = [];
  readonly telemetry: TelemetryEvent[] = [];
  /** `symptom` rows by symptom_id (see upsertSymptoms). */
  readonly symptoms = new Map<string, SymptomRecord>();

  private snap: ObservedSnapshot;
  private readonly actions = new Map<string, ActionRecord>();
  private readonly workflows = new Map<string, WorkflowRecord>();
  private readonly listeners = new Set<(c: DbChange) => void>();
  private readonly physics: PhysicsPort | undefined;
  private readonly defaultOpDurationMs: number;
  private readonly nowFn: () => number;
  private wallMs = 1_794_091_200_000;
  private fencingCounter = 0n;

  constructor(opts: FakeDbOptions) {
    this.snap = clone(opts.snapshot);
    this.physics = opts.physics;
    this.defaultOpDurationMs = opts.defaultOpDurationMs ?? 0;
    this.nowFn = opts.now ?? (() => this.wallMs);
  }

  // ---------------------------------------------------------------- helpers

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args: clone(args) });
  }

  private emit(change: DbChange): void {
    for (const cb of this.listeners) cb(clone(change));
  }

  private get simMs(): number {
    return this.snap.clock.sim_time_ms;
  }

  private mustAction(commandKey: string): ActionRecord {
    const rec = this.actions.get(commandKey);
    if (!rec) throw new DbError('NOT_FOUND', `no action ${commandKey}`);
    return rec;
  }

  private transition(rec: ActionRecord, status: ActionStatus['status'], patch: Partial<ActionStatus> = {}): ActionStatus {
    rec.status = { ...rec.status, ...patch, status, updated_sim_time_ms: this.simMs, version: rec.status.version + 1 };
    this.logActionEvent(rec.status);
    this.emit({ kind: 'action_status', status: clone(rec.status) });
    return clone(rec.status);
  }

  private logActionEvent(s: ActionStatus): void {
    this.actionEvents.push({
      command_key: s.command_key,
      status: s.status,
      reason_code: s.reason_code,
      version: s.version,
      sim_time_ms: this.simMs,
    });
  }

  private nextFencingToken(): bigint {
    this.fencingCounter += 1n;
    return this.fencingCounter;
  }

  /** Advance the manual wall clock (only when no custom `now` was given). */
  advanceWallMs(ms: number): void {
    this.wallMs += ms;
  }

  /** Bump run.decision_epoch (a safety-relevant change). */
  bumpDecisionEpoch(): number {
    this.snap.clock.decision_epoch += 1;
    this.emit({ kind: 'decision_epoch', decision_epoch: this.snap.clock.decision_epoch, sim_time_ms: this.simMs });
    return this.snap.clock.decision_epoch;
  }

  /**
   * Ingest a SignalEvent. XID 79/48/74 marks the GPU unreachable/degraded, bumps its version and the
   * decision epoch, and emits signal + resource_version + decision_epoch changes.
   */
  injectSignal(sig: SignalEvent): void {
    const v = validatePayload('SignalEvent', sig);
    if (!v.ok) throw new DbError('INVALID_PAYLOAD', v.errors.join('; '));
    // Injecting a signal advances the fake clock to at least the signal's time.
    this.advanceClockTo(sig.sim_time_ms);
    this.signals.push(clone(sig));
    this.emit({ kind: 'signal', signal: clone(sig) });
    const gpu = this.snap.gpus.find((g) => g.resource_id === sig.resource_id);
    if (gpu && sig.event_type === 'xid_error') {
      gpu.last_xid_code = sig.xid_code;
      gpu.availability = sig.xid_code === 79 ? 'unreachable' : 'degraded';
      gpu.version += 1;
      gpu.last_seen_sim_ms = sig.sim_time_ms;
      this.emit({ kind: 'resource_version', resource_id: gpu.resource_id, version: gpu.version, sim_time_ms: this.simMs });
      this.snap.observation_event_ids.push(sig.event_id);
      this.bumpDecisionEpoch();
    }
  }

  /** Move sim time forward (never backward) and refresh liveness of reachable GPUs. */
  private advanceClockTo(simMs: number): void {
    if (simMs <= this.simMs) return;
    this.snap.clock.sim_time_ms = simMs;
    this.refreshReachableGpus();
  }

  /** GPUs that are not unreachable keep reporting: bump last_seen_sim_ms to now so they don't go stale. */
  private refreshReachableGpus(): void {
    for (const g of this.snap.gpus) {
      if (g.availability !== 'unreachable') g.last_seen_sim_ms = this.simMs;
    }
  }

  injectTelemetry(ev: TelemetryEvent): void {
    this.telemetry.push(clone(ev));
  }

  /** Force a running/claimed action to fail (e.g. its destination died). */
  failAction(commandKey: string, reasonCode: string): ActionStatus {
    const rec = this.mustAction(commandKey);
    rec.dueSimMs = null;
    return this.transition(rec, 'failed', { reason_code: reasonCode });
  }

  /** Every ActionStatus in insertion order (ledger view). */
  listActions(): ActionStatus[] {
    return [...this.actions.values()].map((r) => clone(r.status));
  }

  /** Mutable access for test setup (e.g. tweak a GPU temp). */
  mutateSnapshot(fn: (s: ObservedSnapshot) => void): void {
    fn(this.snap);
  }

  /**
   * Advance sim time by `simMs` (in step_ms ticks) and complete running actions whose due time passed:
   * checkpoint -> new complete Checkpoint + durable progress; migrate_restart -> reallocate the job to
   * arguments.destination_gpu_ids; others -> succeeded with no state change.
   */
  tick(simMs: number): void {
    const target = this.simMs + simMs;
    const step = this.snap.clock.step_ms;
    while (this.simMs < target) {
      const dt = Math.min(step, target - this.simMs);
      this.snap.clock.sim_time_ms += dt;
      this.snap.clock.tick_index += 1;
      this.refreshReachableGpus();
      for (const rec of this.actions.values()) {
        if (rec.status.status === 'running' && rec.dueSimMs !== null && rec.dueSimMs <= this.simMs) {
          this.complete(rec);
        }
      }
    }
  }

  private complete(rec: ActionRecord): void {
    rec.dueSimMs = null;
    const { cmd } = rec;
    const result: Record<string, unknown> = {};
    const job = cmd.job_id ? this.snap.job_states.find((j) => j.job_id === cmd.job_id) : undefined;
    if (cmd.operation === 'checkpoint' && job) {
      const n = this.snap.checkpoints.filter((c) => c.job_id === job.job_id).length;
      const cp: Checkpoint = {
        schema_version: V,
        run_id: this.snap.run_id,
        checkpoint_id: `ckpt-${job.job_id}-${n}`,
        job_id: job.job_id,
        storage_resource_id: 'ckpt-store-1',
        status: 'complete',
        progress_work_units: job.progress_work_units,
        requested_sim_time_ms: rec.status.updated_sim_time_ms,
        complete_sim_time_ms: this.simMs,
        accessible: true,
        command_key: cmd.command_key,
      };
      this.snap.checkpoints.push(cp);
      job.durable_work_units = job.progress_work_units;
      job.latest_checkpoint_id = cp.checkpoint_id;
      job.version += 1;
      result.checkpoint_id = cp.checkpoint_id;
    }
    if (cmd.operation === 'migrate_restart' && job) {
      const dest = (cmd.arguments.destination_gpu_ids as string[] | undefined) ?? [];
      this.snap.allocations = this.snap.allocations.filter((a) => a.job_id !== job.job_id);
      for (const gpu_id of dest) {
        this.snap.allocations.push({ schema_version: V, run_id: this.snap.run_id, job_id: job.job_id, gpu_id, since_sim_time_ms: this.simMs });
      }
      job.allocated_gpu_ids = [...dest];
      job.progress_work_units = job.durable_work_units;
      job.status = 'running';
      job.version += 1;
      result.destination_gpu_ids = dest;
    }
    if (job) this.emit({ kind: 'resource_version', resource_id: job.job_id, version: job.version, sim_time_ms: this.simMs });
    this.transition(rec, 'succeeded', { result });
  }

  private durationFor(cmd: ActionCommand): number {
    const spec = cmd.job_id ? this.snap.job_specs.find((j) => j.job_id === cmd.job_id) : undefined;
    if (cmd.operation === 'checkpoint') return spec?.checkpoint_duration_ms ?? 30_000;
    if (cmd.operation === 'migrate_restart') return spec?.restart_duration_ms ?? 120_000;
    return this.defaultOpDurationMs;
  }

  // ---------------------------------------------------------------- DbPort

  async getObservedSnapshot(): Promise<ObservedSnapshot> {
    this.record('getObservedSnapshot');
    return clone(this.snap);
  }

  async getEvidence(incidentIds: string[], windowSimMs: number): Promise<Evidence> {
    this.record('getEvidence', incidentIds, windowSimMs);
    // Include injected signals even if timestamped after the snapshot time.
    const asOf = Math.max(this.simMs, ...this.signals.map((x) => x.sim_time_ms));
    const from = asOf - windowSimMs;
    const inWindow = <T extends { sim_time_ms: number }>(x: T) => x.sim_time_ms >= from && x.sim_time_ms <= asOf;
    const wanted = new Set(incidentIds);
    const links = this.links.filter((l) => wanted.size === 0 || wanted.has(l.incident_id));
    const linkedResources = new Set(links.map((l) => l.linked_id));
    const relevant = <T extends { resource_id: string; sim_time_ms: number }>(x: T) =>
      inWindow(x) && (wanted.size === 0 || linkedResources.has(x.resource_id));
    const symptoms = [...this.symptoms.values()].filter(
      (sy) =>
        sy.last_seen_sim_ms >= from &&
        sy.first_seen_sim_ms <= asOf &&
        (wanted.size === 0 || linkedResources.has(sy.symptom_id) || linkedResources.has(sy.resource_id)),
    );
    return {
      run_id: this.snap.run_id,
      incident_ids: [...incidentIds],
      window_sim_ms: windowSimMs,
      as_of_sim_time_ms: asOf,
      incidents: [...this.incidents.values()].filter((i) => wanted.size === 0 || wanted.has(i.incident_id)).map(clone),
      links: clone(links),
      symptoms: clone(symptoms),
      signals: clone(this.signals.filter(relevant)),
      telemetry: clone(this.telemetry.filter(relevant)),
    };
  }

  async getActionStatus(commandKey: string): Promise<ActionStatus | null> {
    this.record('getActionStatus', commandKey);
    const rec = this.actions.get(commandKey);
    return rec ? clone(rec.status) : null;
  }

  async requestAction(cmd: ActionCommand): Promise<ActionStatus> {
    this.record('requestAction', cmd);
    const v = validatePayload('ActionCommand', cmd);
    if (!v.ok) throw new DbError('INVALID_PAYLOAD', v.errors.join('; '));
    const hash = commandPayloadHash(cmd);
    const existing = this.actions.get(cmd.command_key);
    if (existing) {
      if (existing.payloadHash !== hash) {
        throw new DbError('COMMAND_KEY_COLLISION', `command_key ${cmd.command_key} reused with a different payload`);
      }
      return clone(existing.status); // idempotent retry: persisted record, no side effects
    }
    // Fresh re-check, as the request_action reducer does.
    const violations: string[] = [];
    if (cmd.expected_decision_epoch !== this.snap.clock.decision_epoch) violations.push('STALE_DECISION_EPOCH');
    if (this.physics) {
      const leased = [...this.actions.values()]
        .filter((r) => r.status.status === 'claimed' || r.status.status === 'running')
        .flatMap((r) => (r.cmd.arguments.destination_gpu_ids as string[] | undefined) ?? []);
      const d = this.physics.evaluateSafety(this.snap, cmd, {
        decision_epoch: this.snap.clock.decision_epoch,
        leased_resource_ids: leased,
      });
      if (d.decision === 'deny') violations.push(...d.violations);
    }
    // CONTRACTS §0.11 #3: a safety deny is persisted as a failed action and returned (never thrown).
    const rejected = violations.length > 0;
    const status: ActionStatus = {
      schema_version: V,
      run_id: cmd.run_id,
      action_id: cmd.action_id,
      command_key: cmd.command_key,
      status: rejected ? 'failed' : 'requested',
      attempt: 1,
      updated_sim_time_ms: this.simMs,
      result: rejected ? { violations: [...new Set(violations)] } : {},
      reason_code: rejected ? 'SAFETY_REJECTED' : null,
      version: 1,
    };
    this.actions.set(cmd.command_key, { cmd: clone(cmd), payloadHash: hash, status, fencingToken: null, dueSimMs: null });
    this.logActionEvent(status);
    this.emit({ kind: 'action_status', status: clone(status) });
    return clone(status);
  }

  async claimAction(
    commandKey: string,
    expectedVersion: number,
    workerId: string,
  ): Promise<{ status: ActionStatus; fencing_token: bigint }> {
    this.record('claimAction', commandKey, expectedVersion, workerId);
    const rec = this.mustAction(commandKey);
    if (rec.status.version !== expectedVersion) {
      throw new DbError('VERSION_CONFLICT', `action ${commandKey} is v${rec.status.version}, expected v${expectedVersion}`);
    }
    if (rec.status.status !== 'requested') {
      throw new DbError('INVALID_TRANSITION', `cannot claim ${commandKey} from ${rec.status.status}`);
    }
    rec.fencingToken = this.nextFencingToken();
    const status = this.transition(rec, 'claimed', { result: { ...rec.status.result, claimed_by: workerId } });
    return { status, fencing_token: rec.fencingToken };
  }

  async startAction(commandKey: string, fencingToken: bigint): Promise<ActionStatus> {
    this.record('startAction', commandKey, fencingToken);
    const rec = this.mustAction(commandKey);
    if (rec.status.status !== 'claimed') {
      throw new DbError('INVALID_TRANSITION', `cannot start ${commandKey} from ${rec.status.status}`);
    }
    if (rec.fencingToken !== fencingToken) throw new DbError('STALE_FENCING_TOKEN', `token ${fencingToken} for ${commandKey}`);
    for (const dep of rec.cmd.depends_on_command_keys) {
      if (this.actions.get(dep)?.status.status !== 'succeeded') {
        throw new DbError('INVALID_TRANSITION', `${commandKey} depends on ${dep}, which has not succeeded`);
      }
    }
    rec.dueSimMs = this.simMs + this.durationFor(rec.cmd);
    return this.transition(rec, 'running');
  }

  async cancelAction(commandKey: string, reasonCode: string, fencingToken: bigint): Promise<ActionStatus> {
    this.record('cancelAction', commandKey, reasonCode, fencingToken);
    const rec = this.mustAction(commandKey);
    if (rec.status.status === 'cancelled') return clone(rec.status);
    if (rec.status.status === 'claimed' && rec.fencingToken !== fencingToken) {
      throw new DbError('STALE_FENCING_TOKEN', `token ${fencingToken} for ${commandKey}`);
    }
    if (rec.status.status !== 'requested' && rec.status.status !== 'claimed') {
      throw new DbError('INVALID_TRANSITION', `cannot cancel ${commandKey} from ${rec.status.status}`);
    }
    return this.transition(rec, 'cancelled', { reason_code: reasonCode });
  }

  async verifyAction(commandKey: string, evidence: Record<string, unknown>): Promise<ActionStatus> {
    this.record('verifyAction', commandKey, evidence);
    const rec = this.mustAction(commandKey);
    if (rec.status.status !== 'succeeded') {
      throw new DbError('INVALID_TRANSITION', `cannot verify ${commandKey} in ${rec.status.status}`);
    }
    return this.transition(rec, 'succeeded', { result: { ...rec.status.result, verified: true, verification: clone(evidence) } });
  }

  async claimWorkflow(workflowId: string, workerId: string, expectedVersion: number, leaseMs: number): Promise<WorkflowLease> {
    this.record('claimWorkflow', workflowId, workerId, expectedVersion, leaseMs);
    const now = this.nowFn();
    let wf = this.workflows.get(workflowId);
    if (!wf) {
      if (expectedVersion !== 0) throw new DbError('NOT_FOUND', `workflow ${workflowId} (expected v${expectedVersion})`);
      wf = {
        workflow_id: workflowId,
        run_id: this.snap.run_id,
        stage: 'idle',
        state: {},
        incident_ids: [],
        plan_id: null,
        current_command_key: null,
        last_processed_event_seq: 0,
        attempt: 0,
        lease_owner: null,
        lease_expires_unix_ms: 0,
        fencing_token: 0n,
        updated_at_unix_ms: now,
        version: 0,
      };
      this.workflows.set(workflowId, wf);
    }
    if (wf.version !== expectedVersion) {
      throw new DbError('VERSION_CONFLICT', `workflow ${workflowId} is v${wf.version}, expected v${expectedVersion}`);
    }
    if (wf.lease_owner !== null && wf.lease_owner !== workerId && wf.lease_expires_unix_ms > now) {
      throw new DbError('LEASE_HELD', `workflow ${workflowId} leased by ${wf.lease_owner}`);
    }
    wf.lease_owner = workerId;
    wf.lease_expires_unix_ms = now + leaseMs;
    wf.fencing_token = this.nextFencingToken();
    wf.attempt += 1;
    wf.version += 1;
    wf.updated_at_unix_ms = now;
    return { workflow: clone(wf), fencing_token: wf.fencing_token, lease_expires_unix_ms: wf.lease_expires_unix_ms };
  }

  private mustLeaseHolder(workflowId: string, fencingToken: bigint, workerId?: string): WorkflowRecord {
    const wf = this.workflows.get(workflowId);
    if (!wf) throw new DbError('NOT_FOUND', `workflow ${workflowId}`);
    if (wf.fencing_token !== fencingToken) throw new DbError('STALE_FENCING_TOKEN', `workflow ${workflowId} token ${fencingToken}`);
    if (workerId !== undefined && wf.lease_owner !== workerId) throw new DbError('LEASE_HELD', `workflow ${workflowId} owned by ${wf.lease_owner}`);
    if (wf.lease_expires_unix_ms <= this.nowFn()) throw new DbError('LEASE_EXPIRED', `workflow ${workflowId}`);
    return wf;
  }

  async heartbeatWorkflow(workflowId: string, workerId: string, fencingToken: bigint, leaseMs: number): Promise<WorkflowLease> {
    this.record('heartbeatWorkflow', workflowId, workerId, fencingToken, leaseMs);
    const wf = this.mustLeaseHolder(workflowId, fencingToken, workerId);
    const now = this.nowFn();
    wf.lease_expires_unix_ms = now + leaseMs;
    wf.updated_at_unix_ms = now;
    return { workflow: clone(wf), fencing_token: wf.fencing_token, lease_expires_unix_ms: wf.lease_expires_unix_ms };
  }

  async updateWorkflow(
    workflowId: string,
    expectedVersion: number,
    fencingToken: bigint,
    stage: WorkflowStage,
    state: Record<string, unknown>,
  ): Promise<WorkflowRecord> {
    this.record('updateWorkflow', workflowId, expectedVersion, fencingToken, stage, state);
    const wf = this.mustLeaseHolder(workflowId, fencingToken);
    if (wf.version !== expectedVersion) {
      throw new DbError('VERSION_CONFLICT', `workflow ${workflowId} is v${wf.version}, expected v${expectedVersion}`);
    }
    wf.stage = stage;
    wf.state = clone(state);
    if (typeof state.plan_id === 'string') wf.plan_id = state.plan_id;
    if (typeof state.current_command_key === 'string') wf.current_command_key = state.current_command_key;
    if (Array.isArray(state.incident_ids)) wf.incident_ids = state.incident_ids.filter((x): x is string => typeof x === 'string');
    wf.version += 1;
    wf.updated_at_unix_ms = this.nowFn();
    return clone(wf);
  }

  async getWorkflow(workflowId: string): Promise<WorkflowRecord | null> {
    this.record('getWorkflow', workflowId);
    const wf = this.workflows.get(workflowId);
    return wf ? clone(wf) : null;
  }

  async listOpenWorkflows(): Promise<WorkflowRecord[]> {
    this.record('listOpenWorkflows');
    return [...this.workflows.values()].filter((w) => w.stage !== 'done').map(clone);
  }

  async upsertIncident(incident: Incident, links: IncidentLink[]): Promise<Incident> {
    this.record('upsertIncident', incident, links);
    const vi = validatePayload('Incident', incident);
    if (!vi.ok) throw new DbError('INVALID_PAYLOAD', vi.errors.join('; '));
    for (const l of links) {
      const vl = validatePayload('IncidentLink', l);
      if (!vl.ok) throw new DbError('INVALID_PAYLOAD', vl.errors.join('; '));
    }
    this.incidents.set(incident.incident_id, clone(incident));
    for (const l of links) {
      const dup = this.links.some((x) => x.incident_id === l.incident_id && x.linked_id === l.linked_id && x.link_kind === l.link_kind);
      if (!dup) this.links.push(clone(l));
    }
    return clone(incident);
  }

  async listIncidents(): Promise<Incident[]> {
    this.record('listIncidents');
    return [...this.incidents.values()].map(clone);
  }

  async upsertSymptoms(symptoms: SymptomRecord[]): Promise<void> {
    this.record('upsertSymptoms', symptoms);
    for (const sy of symptoms) {
      const prev = this.symptoms.get(sy.symptom_id);
      this.symptoms.set(sy.symptom_id, {
        ...clone(sy),
        first_seen_sim_ms: prev ? Math.min(prev.first_seen_sim_ms, sy.first_seen_sim_ms) : sy.first_seen_sim_ms,
        last_seen_sim_ms: prev ? Math.max(prev.last_seen_sim_ms, sy.last_seen_sim_ms) : sy.last_seen_sim_ms,
      });
    }
  }

  async submitPlan(plan: PlanCandidate): Promise<void> {
    this.record('submitPlan', plan);
    const v = validatePayload('PlanCandidate', plan);
    if (!v.ok) throw new DbError('INVALID_PAYLOAD', v.errors.join('; '));
    this.plans.set(plan.plan_id, clone(plan));
  }

  async publishAgentEvent(ev: AgentEventInput): Promise<void> {
    this.record('publishAgentEvent', ev);
    this.agentEvents.push(clone(ev));
  }

  onChange(cb: (change: DbChange) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
}
