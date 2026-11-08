// createMockClient(): an in-memory DbClient for P3/P4 before (or without) the live DB.
// Browser-safe (no Node APIs). Serves P1's gpu_demo_8 fixtures and models the reducer rules
// P3 relies on: idempotent request_action, key collisions, CAS, fencing, lifecycle, leases.
// It is NOT a physics engine: `tick()` advances the clock, job progress, GPU `last_seen_sim_ms`
// and due actions only. Temperatures change only through fixture overlays (`loadSnapshot('pump_degraded')`,
// the pump-a `injectFault`), which keep the current clock, jobs, allocations and actions.

import {
  validatePayload,
  type ActionCommand,
  type ActionStatus,
  type EvaluationResult,
  type FaultInjection,
  type GpuCurrent,
  type Incident,
  type IncidentLink,
  type JobState,
  type ObservedSnapshot,
  type PlanCandidate,
  type SafetyDecision,
  type SignalEvent,
  type TelemetryEvent,
} from '@dcos/contracts';
import type { DbClient, Unsubscribe } from './client.js';
import {
  DbError,
  type ActionDetail,
  type ActionHistoryEntry,
  type ActionSafety,
  type AgentEventInput,
  type DbChange,
  type Evidence,
  type RunConfig,
  type SymptomRecord,
  type WorkflowLease,
  type WorkflowRecord,
  type WorkflowStage,
} from './types.js';
import demoSnapshot from './mock/fixtures/observed_snapshot_demo.json' with { type: 'json' };
import pumpDegradedSnapshot from './mock/fixtures/observed_snapshot_pump_degraded.json' with { type: 'json' };
import xid79Signal from './mock/fixtures/signal_xid79.json' with { type: 'json' };

export const MOCK_FIXTURES = {
  demo: demoSnapshot as unknown as ObservedSnapshot,
  pump_degraded: pumpDegradedSnapshot as unknown as ObservedSnapshot,
  signal_xid79: xid79Signal as unknown as SignalEvent,
} as const;

export type MockSnapshotName = 'demo' | 'pump_degraded';

export interface MockClientOptions {
  /** Starting snapshot (default `demo`). */
  snapshot?: MockSnapshotName | ObservedSnapshot;
  /** Wall clock for leases (default `Date.now`). Tests pass a manual clock. */
  now?: () => number;
  /** Plug in `evaluateSafety` from @dcos/physics to get real safety denies in requestAction. */
  evaluateSafety?: (
    obs: ObservedSnapshot,
    cmd: ActionCommand,
    ctx: { decision_epoch: number; leased_resource_ids: string[] },
  ) => SafetyDecision;
  /** A claimed-but-never-started action may be re-claimed after this much wall time (default 15000). */
  claimLeaseMs?: number;
  /** Auto-advance one tick every `autoTickMs` wall ms (dashboard demos). Off by default. */
  autoTickMs?: number;
}

export interface MockCall {
  method: string;
  args: unknown[];
}

/** Mock-only controls on top of DbClient, for tests and local demos. */
export interface MockDbClient extends DbClient {
  readonly mode: 'mock';
  /** Every DbClient call in order (P3 asserts on what it sent). */
  readonly calls: MockCall[];
  /** Advance logical time by one step (or `simMs`): job progress, GPU freshness, due action completions. */
  tick(simMs?: number): void;
  /**
   * A fixture name (`pump_degraded`, `demo`) overlays that fixture's thermal and cooling state on the current run:
   * GPU temps + thermal bit, node thermal headroom, cooling rows. Clock, jobs, allocations, checkpoints, actions,
   * cordons, XID failures and power caps stay. `demo` restores healthy cooling.
   * A full `ObservedSnapshot` replaces the whole observed state (e.g. a real-physics world). Both bump the epoch.
   */
  loadSnapshot(snapshot: MockSnapshotName | ObservedSnapshot): void;
  /** Append a signal (e.g. MOCK_FIXTURES.signal_xid79) as if the DB tick emitted it. */
  injectSignal(signal: SignalEvent): void;
  /** Faults received via injectFault (private truth; never returned by agent-facing reads). */
  readonly injectedFaults: readonly FaultInjection[];
}

interface ActionRecord {
  cmd: ActionCommand;
  canonical: string;
  status: ActionStatus;
  fencingToken: bigint | null;
  dueSimMs: number | null;
  claimedAtMs: number | null;
  claimedBy: string | null;
  safety: ActionSafety | null;
  history: ActionHistoryEntry[];
}

const V = '1.1.0' as const;
/** CONTRACTS §0.11 #5: DCGM SW thermal slowdown. */
const THERMAL_BIT = 0x20;
/** XID -> observed effect, as in @dcos/physics: 79 drops the GPU, 48 and 79 kill its job, 74 only degrades. */
const XID: Record<number, { availability: GpuCurrent['availability']; jobFatal: boolean; severity: SignalEvent['severity']; text: string }> = {
  79: { availability: 'unreachable', jobFatal: true, severity: 'critical', text: 'GPU has fallen off the bus' },
  48: { availability: 'degraded', jobFatal: true, severity: 'critical', text: 'double-bit ECC error' },
  74: { availability: 'degraded', jobFatal: false, severity: 'warning', text: 'NVLink error' },
};
const XID_OF_FAULT: Partial<Record<FaultInjection['kind'], number>> = { gpu_xid_79: 79, gpu_xid_48: 48, gpu_xid_74: 74 };
/** source_id of signals the mock generates (same as P1's fixtures). */
const SIM_SOURCE = 'sim-engine-1';

/** Set `run_id` on the snapshot and every row in it. */
function restampRunId(s: ObservedSnapshot, runId: string): void {
  s.run_id = runId;
  for (const v of Object.values(s)) {
    if (!Array.isArray(v)) continue;
    for (const row of v) if (row && typeof row === 'object' && 'run_id' in row) (row as { run_id: string }).run_id = runId;
  }
}
const DURATION_MS: Partial<Record<ActionCommand['operation'], number>> = {
  checkpoint: 30_000,
  migrate_restart: 120_000,
};

/** Key-sorted JSON so the comparison does not depend on property order. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Canonical command for payload-hash comparison (§0.11 #2: excludes requested_sim_time_ms). */
function canonicalCommand(cmd: ActionCommand): string {
  const { requested_sim_time_ms: _ignored, ...rest } = cmd;
  return stableStringify(rest);
}

const clone = <T>(v: T): T => structuredClone(v);

function mustValidate(type: string, payload: unknown): void {
  const v = validatePayload(type, payload);
  if (!v.ok) throw new DbError('INVALID_PAYLOAD', `${type}: ${v.errors.join('; ')}`);
}

export function createMockClient(opts: MockClientOptions = {}): MockDbClient {
  const now = opts.now ?? (() => Date.now());
  const claimLeaseMs = opts.claimLeaseMs ?? 15_000;
  const pick = (s: MockSnapshotName | ObservedSnapshot): ObservedSnapshot =>
    clone(typeof s === 'string' ? MOCK_FIXTURES[s] : s);

  let snap = pick(opts.snapshot ?? 'demo');
  let runConfig: RunConfig = { speed: 1 };
  let nextToken = 1n;
  const actions = new Map<string, ActionRecord>();
  const workflows = new Map<string, WorkflowRecord>();
  const incidents = new Map<string, Incident>();
  const links: IncidentLink[] = [];
  const symptoms = new Map<string, SymptomRecord>();
  const plans = new Map<string, PlanCandidate>();
  const agentEvents: AgentEventInput[] = [];
  const evaluations = new Map<string, EvaluationResult>();
  const signals: SignalEvent[] = [];
  const telemetry: TelemetryEvent[] = [];
  const seenEventIds = new Set<string>();
  const lastSourceSeq = new Map<string, number>();
  const injectedFaults: FaultInjection[] = [];
  const calls: MockCall[] = [];

  // --- subscriptions -------------------------------------------------------
  type Topic = 'gpu' | 'jobs' | 'incidents' | 'actions' | 'agentEvents' | 'evaluation';
  const subs: Record<Topic, Set<() => void>> = {
    gpu: new Set(),
    jobs: new Set(),
    incidents: new Set(),
    actions: new Set(),
    agentEvents: new Set(),
    evaluation: new Set(),
  };
  const changeSubs = new Set<(c: DbChange) => void>();
  const emit = (...topics: Topic[]) => topics.forEach((t) => subs[t].forEach((fn) => fn()));
  const emitChange = (c: DbChange) => changeSubs.forEach((fn) => fn(clone(c)));
  const subscribe = <T>(topic: Topic, read: () => T, cb: (v: T) => void): Unsubscribe => {
    const fn = () => cb(read());
    subs[topic].add(fn);
    fn();
    return () => subs[topic].delete(fn);
  };

  const record = (method: string, args: unknown[]) => calls.push({ method, args: clone(args) });
  const simNow = () => snap.clock.sim_time_ms;

  const bumpEpoch = () => {
    snap.clock.decision_epoch += 1;
    emitChange({ kind: 'decision_epoch', decision_epoch: snap.clock.decision_epoch, sim_time_ms: simNow() });
  };

  // --- actions -------------------------------------------------------------
  const getRec = (commandKey: string): ActionRecord => {
    const rec = actions.get(commandKey);
    if (!rec) throw new DbError('NOT_FOUND', `no action ${commandKey}`);
    return rec;
  };

  /** Like live `action_event`: one history entry per status write. */
  const logEvent = (rec: ActionRecord, detail: Record<string, unknown>) =>
    rec.history.push({
      status: rec.status.status,
      version: rec.status.version,
      sim_time_ms: rec.status.updated_sim_time_ms,
      observed_unix_ms: now(),
      reason_code: rec.status.reason_code,
      detail: clone(detail),
    });

  const transition = (
    rec: ActionRecord,
    status: ActionStatus['status'],
    patch: Partial<ActionStatus> = {},
    detail: Record<string, unknown> = {},
  ) => {
    rec.status = {
      ...rec.status,
      ...patch,
      status,
      updated_sim_time_ms: simNow(),
      version: rec.status.version + 1,
    };
    logEvent(rec, detail);
    emitChange({ kind: 'action_status', status: rec.status });
    emit('actions');
  };

  const toDetail = (rec: ActionRecord): ActionDetail =>
    clone({
      status: rec.status,
      command: rec.cmd,
      claimed_by: rec.claimedBy,
      due_sim_time_ms: rec.dueSimMs,
      safety: rec.safety,
      start_safety: null,
      history: rec.history,
    });

  /** Resources an action reserves while claimed/running: target, job, destination GPUs. */
  const closureOf = (cmd: ActionCommand): string[] => {
    const ids = new Set<string>([cmd.target_resource_id]);
    if (cmd.job_id) ids.add(cmd.job_id);
    const dest = (cmd.arguments as { destination_gpu_ids?: unknown }).destination_gpu_ids;
    if (Array.isArray(dest)) dest.forEach((g) => typeof g === 'string' && ids.add(g));
    return [...ids].sort();
  };

  const leasedResourceIds = (exceptKey?: string): string[] => {
    const ids = new Set<string>();
    for (const r of actions.values()) {
      if (r.cmd.command_key === exceptKey) continue;
      if (r.status.status !== 'claimed' && r.status.status !== 'running') continue;
      closureOf(r.cmd).forEach((id) => ids.add(id));
    }
    return [...ids];
  };

  /** Current version of a resource/job in the observed snapshot (undefined if unknown). */
  const versionOf = (id: string): number | undefined =>
    snap.gpus.find((g) => g.resource_id === id)?.version ??
    snap.nodes.find((n) => n.resource_id === id)?.version ??
    snap.cooling.find((c) => c.resource_id === id)?.version ??
    snap.job_states.find((j) => j.job_id === id)?.version;

  const emitGpuVersion = (gpu: GpuCurrent) =>
    emitChange({ kind: 'resource_version', resource_id: gpu.resource_id, version: gpu.version, sim_time_ms: simNow() });

  /** Mock effect of a completed action on the observed snapshot. */
  const applyCompletion = (cmd: ActionCommand) => {
    const job = cmd.job_id ? snap.job_states.find((j) => j.job_id === cmd.job_id) : undefined;
    if (cmd.operation === 'checkpoint' && job) {
      const checkpointId = `ckpt-${cmd.command_key}`;
      snap.checkpoints.push({
        schema_version: V,
        run_id: snap.run_id,
        checkpoint_id: checkpointId,
        job_id: job.job_id,
        storage_resource_id: 'ckpt-store-1',
        status: 'complete',
        progress_work_units: job.progress_work_units,
        requested_sim_time_ms: simNow() - (DURATION_MS.checkpoint ?? 0),
        complete_sim_time_ms: simNow(),
        accessible: true,
        command_key: cmd.command_key,
      });
      job.durable_work_units = job.progress_work_units;
      job.latest_checkpoint_id = checkpointId;
      job.version += 1;
      bumpEpoch(); // live physics: a completed checkpoint is a material change (decision_epoch + 1)
    } else if (cmd.operation === 'migrate_restart' && job) {
      const dest = (cmd.arguments as { destination_gpu_ids?: string[] }).destination_gpu_ids ?? [];
      snap.allocations = snap.allocations.filter((a) => a.job_id !== job.job_id);
      for (const gpu_id of dest) {
        snap.allocations.push({ schema_version: V, run_id: snap.run_id, job_id: job.job_id, gpu_id, since_sim_time_ms: simNow() });
      }
      job.allocated_gpu_ids = [...dest];
      job.status = 'running';
      job.version += 1;
      bumpEpoch();
    } else if (cmd.operation === 'pause_job' && job) {
      job.status = 'paused';
      job.version += 1;
    } else if (cmd.operation === 'cordon_gpu' || cmd.operation === 'uncordon_gpu') {
      const gpu = snap.gpus.find((g) => g.resource_id === cmd.target_resource_id);
      if (gpu) {
        gpu.availability = cmd.operation === 'cordon_gpu' ? 'cordoned' : 'ready';
        gpu.version += 1;
        emitGpuVersion(gpu);
        bumpEpoch();
      }
    } else if (cmd.operation === 'power_cap') {
      const limit = Number((cmd.arguments as { power_limit_w?: unknown }).power_limit_w ?? 500);
      for (const gpu of snap.gpus.filter((g) => job?.allocated_gpu_ids.includes(g.resource_id) || g.resource_id === cmd.target_resource_id)) {
        gpu.power_limit_w = limit;
        gpu.clocks_event_reasons |= 0x04;
        gpu.version += 1;
        emitGpuVersion(gpu);
      }
    }
  };

  // --- workflows -----------------------------------------------------------
  const getWf = (id: string): WorkflowRecord => {
    const wf = workflows.get(id);
    if (!wf) throw new DbError('NOT_FOUND', `workflow ${id}`);
    return wf;
  };
  const checkWfLease = (wf: WorkflowRecord, token: bigint, workerId?: string) => {
    if (wf.fencing_token !== token) throw new DbError('STALE_FENCING_TOKEN', `workflow ${wf.workflow_id} token ${token}`);
    if (workerId !== undefined && wf.lease_owner !== workerId) {
      throw new DbError('LEASE_HELD', `workflow ${wf.workflow_id} owned by ${wf.lease_owner}`);
    }
    if (wf.lease_expires_unix_ms <= now()) throw new DbError('LEASE_EXPIRED', `workflow ${wf.workflow_id}`);
  };
  const lease = (wf: WorkflowRecord): WorkflowLease => ({
    workflow: clone(wf),
    fencing_token: wf.fencing_token,
    lease_expires_unix_ms: wf.lease_expires_unix_ms,
  });

  // --- tick ----------------------------------------------------------------
  const tick = (simMs = snap.clock.step_ms) => {
    if (snap.clock.paused) return;
    snap.clock.sim_time_ms += simMs;
    snap.clock.tick_index += 1;
    // Like physics step(): every reachable GPU reports this tick, so evaluateSafety's EVIDENCE_STALE stays quiet.
    for (const g of snap.gpus) if (g.availability !== 'unreachable') g.last_seen_sim_ms = simNow();
    const rateById = new Map(snap.job_specs.map((s) => [s.job_id, s.work_rate_per_gpu_per_sim_s]));
    for (const job of snap.job_states) {
      job.last_update_sim_time_ms = simNow();
      if (job.status !== 'running') continue;
      job.progress_work_units += job.allocated_gpu_ids.length * (rateById.get(job.job_id) ?? 0) * (simMs / 1000);
    }
    for (const rec of actions.values()) {
      if (rec.status.status === 'running' && rec.dueSimMs !== null && rec.dueSimMs <= simNow()) {
        applyCompletion(rec.cmd);
        const outcome = { status: 'succeeded', reason_code: null, sim_time_ms: simNow() };
        transition(rec, 'succeeded', { result: { ...rec.status.result, outcome } }, { outcome });
      }
    }
    emit('gpu', 'jobs');
  };
  const autoTimer = opts.autoTickMs ? setInterval(() => tick(), opts.autoTickMs) : undefined;

  /** Physics failJob: roll back to durable, release the GPUs, fail the job's in-flight operations. */
  const failJob = (job: JobState) => {
    job.status = 'failed';
    job.progress_work_units = job.durable_work_units;
    job.allocated_gpu_ids = [];
    snap.allocations = snap.allocations.filter((a) => a.job_id !== job.job_id);
    job.version += 1;
    for (const rec of actions.values()) {
      if (rec.status.status !== 'running' || (rec.cmd.job_id ?? rec.cmd.target_resource_id) !== job.job_id) continue;
      rec.dueSimMs = null;
      const outcome = { status: 'failed', reason_code: 'JOB_FAILED_DURING_OPERATION', sim_time_ms: simNow() };
      transition(rec, 'failed', { reason_code: 'JOB_FAILED_DURING_OPERATION', result: { ...rec.status.result, outcome } }, { outcome });
    }
  };

  // --- fixture overlay -----------------------------------------------------
  /**
   * Apply a fixture's thermal + cooling state on top of the current run (see MockDbClient.loadSnapshot).
   * GPU versions do not change for a temperature change (as in physics); a changed cooling row bumps its version.
   */
  const overlayFixture = (name: MockSnapshotName) => {
    const src = MOCK_FIXTURES[name];
    const gpuSrc = new Map(src.gpus.map((g) => [g.resource_id, g]));
    for (const g of snap.gpus) {
      const s = gpuSrc.get(g.resource_id);
      if (!s || g.availability === 'unreachable') continue; // a dead GPU reports nothing
      g.temp_c = s.temp_c;
      g.last_seen_sim_ms = simNow();
      const reasons = (g.clocks_event_reasons & ~THERMAL_BIT) | (s.clocks_event_reasons & THERMAL_BIT);
      if (reasons !== g.clocks_event_reasons) {
        // the thermal bit is material in physics (gpuMaterialKey): version + resource_version
        g.clocks_event_reasons = reasons;
        g.version += 1;
        emitGpuVersion(g);
      }
    }
    const nodeSrc = new Map(src.nodes.map((n) => [n.resource_id, n]));
    for (const n of snap.nodes) {
      const s = nodeSrc.get(n.resource_id);
      if (s) n.thermal_headroom_c = s.thermal_headroom_c;
    }
    const coolSrc = new Map(src.cooling.map((c) => [c.resource_id, c]));
    for (const c of snap.cooling) {
      const s = coolSrc.get(c.resource_id);
      if (!s) continue;
      const changed =
        c.operating_state !== s.operating_state ||
        c.pump_power_w !== s.pump_power_w ||
        c.observed_capacity_estimate_w !== s.observed_capacity_estimate_w;
      if (!changed) continue;
      c.operating_state = s.operating_state;
      c.pump_power_w = s.pump_power_w;
      c.observed_capacity_estimate_w = s.observed_capacity_estimate_w;
      c.version += 1;
      emitChange({ kind: 'resource_version', resource_id: c.resource_id, version: c.version, sim_time_ms: simNow() });
    }
    bumpEpoch();
    emit('gpu', 'jobs');
  };

  /** Fresh run state: what live create_run wipes for the run (every run-scoped row). */
  const resetRunState = (runId: string) => {
    actions.clear();
    workflows.clear();
    incidents.clear();
    links.length = 0;
    symptoms.clear();
    plans.clear();
    agentEvents.length = 0;
    signals.length = 0;
    telemetry.length = 0;
    seenEventIds.clear();
    lastSourceSeq.clear();
    injectedFaults.length = 0;
    for (const [k, e] of evaluations) if (e.run_id === runId) evaluations.delete(k);
    runConfig = { speed: 1 };
  };

  // --- client --------------------------------------------------------------
  const client: MockDbClient = {
    mode: 'mock',
    calls,
    get injectedFaults() {
      return injectedFaults;
    },

    async getObservedSnapshot() {
      record('getObservedSnapshot', []);
      return clone(snap);
    },

    async getEvidence(incidentIds, windowSimMs) {
      record('getEvidence', [incidentIds, windowSimMs]);
      const asOf = simNow();
      const wanted = new Set(incidentIds);
      const selLinks = links.filter((l) => wanted.has(l.incident_id));
      const linkedIds = new Set(selLinks.map((l) => l.linked_id));
      const linkedResources = new Set(
        [...linkedIds].flatMap((id) => (symptoms.has(id) ? [symptoms.get(id)!.resource_id] : [id])),
      );
      const inScope = (x: { sim_time_ms: number; resource_id: string }) =>
        x.sim_time_ms >= asOf - windowSimMs &&
        x.sim_time_ms <= asOf &&
        (wanted.size === 0 || linkedResources.has(x.resource_id));
      const evidence: Evidence = {
        run_id: snap.run_id,
        incident_ids: [...incidentIds],
        window_sim_ms: windowSimMs,
        as_of_sim_time_ms: asOf,
        incidents: [...incidents.values()].filter((i) => wanted.size === 0 || wanted.has(i.incident_id)),
        links: wanted.size === 0 ? [...links] : selLinks,
        symptoms: [...symptoms.values()].filter(
          (s) => s.last_seen_sim_ms >= asOf - windowSimMs && (wanted.size === 0 || linkedIds.has(s.symptom_id)),
        ),
        signals: signals.filter(inScope),
        telemetry: telemetry.filter(inScope),
      };
      return clone(evidence);
    },

    async getActionStatus(commandKey) {
      record('getActionStatus', [commandKey]);
      const rec = actions.get(commandKey);
      return rec ? clone(rec.status) : null;
    },

    async requestAction(cmd) {
      record('requestAction', [cmd]);
      mustValidate('ActionCommand', cmd);
      const canonical = canonicalCommand(cmd);
      const existing = actions.get(cmd.command_key);
      if (existing) {
        if (existing.canonical !== canonical) {
          throw new DbError('COMMAND_KEY_COLLISION', `command_key ${cmd.command_key} reused with a different payload`);
        }
        return clone(existing.status);
      }
      const violations: string[] = [];
      if (cmd.expected_decision_epoch !== snap.clock.decision_epoch) violations.push('STALE_DECISION_EPOCH');
      const staleVersion = Object.entries(cmd.expected_resource_versions).some(([id, v]) => {
        const cur = versionOf(id);
        return cur !== undefined && cur !== v;
      });
      if (staleVersion) violations.push('STALE_RESOURCE_VERSION');
      let safety: ActionSafety | null =
        violations.length > 0
          ? { decision: 'deny', violations: [...violations], checked_decision_epoch: snap.clock.decision_epoch, evidence: {} }
          : null;
      if (violations.length === 0 && opts.evaluateSafety) {
        const d = opts.evaluateSafety(clone(snap), cmd, {
          decision_epoch: snap.clock.decision_epoch,
          leased_resource_ids: leasedResourceIds(),
        });
        if (d.decision !== 'allow') violations.push(...d.violations);
        safety = { decision: d.decision, violations: [...d.violations], checked_decision_epoch: d.checked_decision_epoch, evidence: clone(d.evidence) };
      }
      const rejected = violations.length > 0;
      const rec: ActionRecord = {
        cmd: clone(cmd),
        canonical,
        status: {
          schema_version: V,
          run_id: cmd.run_id,
          action_id: cmd.action_id,
          command_key: cmd.command_key,
          status: rejected ? 'failed' : 'requested',
          attempt: 1,
          updated_sim_time_ms: simNow(),
          result: rejected ? { violations } : {},
          reason_code: rejected ? 'SAFETY_REJECTED' : null,
          version: 1,
        },
        fencingToken: null,
        dueSimMs: null,
        claimedAtMs: null,
        claimedBy: null,
        safety,
        history: [],
      };
      logEvent(rec, { safety });
      actions.set(cmd.command_key, rec);
      emitChange({ kind: 'action_status', status: rec.status });
      emit('actions');
      return clone(rec.status);
    },

    async claimAction(commandKey, expectedVersion, workerId) {
      record('claimAction', [commandKey, expectedVersion, workerId]);
      const rec = getRec(commandKey);
      if (rec.status.version !== expectedVersion) {
        throw new DbError('VERSION_CONFLICT', `action ${commandKey} is v${rec.status.version}, expected v${expectedVersion}`);
      }
      if (rec.status.status === 'claimed') {
        if (now() < (rec.claimedAtMs ?? 0) + claimLeaseMs) throw new DbError('LEASE_HELD', `${commandKey} claimed by ${rec.claimedBy}`);
      } else if (rec.status.status !== 'requested') {
        throw new DbError('INVALID_TRANSITION', `cannot claim ${commandKey} from ${rec.status.status}`);
      }
      // Whole closure (target, job, destination GPUs) must be free of other actions' reservations.
      const held = new Set(leasedResourceIds(commandKey));
      const clash = closureOf(rec.cmd).filter((id) => held.has(id));
      if (clash.length > 0) {
        throw new DbError('LEASE_HELD', `${clash.join(', ')} reserved by another action`);
      }
      rec.fencingToken = nextToken++;
      rec.claimedAtMs = now();
      rec.claimedBy = workerId;
      transition(
        rec,
        'claimed',
        { result: { ...rec.status.result, claimed_by: workerId } },
        { worker_id: workerId, fencing_token: rec.fencingToken.toString(), locked: closureOf(rec.cmd) },
      );
      return { status: clone(rec.status), fencing_token: rec.fencingToken };
    },

    async startAction(commandKey, fencingToken) {
      record('startAction', [commandKey, fencingToken]);
      const rec = getRec(commandKey);
      if (rec.status.status !== 'claimed') throw new DbError('INVALID_TRANSITION', `cannot start ${commandKey} from ${rec.status.status}`);
      if (rec.fencingToken !== fencingToken) throw new DbError('STALE_FENCING_TOKEN', `token ${fencingToken} for ${commandKey}`);
      for (const dep of rec.cmd.depends_on_command_keys) {
        if (actions.get(dep)?.status.status !== 'succeeded') {
          throw new DbError('INVALID_TRANSITION', `${commandKey} depends on ${dep}, which has not succeeded`);
        }
      }
      rec.dueSimMs = simNow() + (DURATION_MS[rec.cmd.operation] ?? snap.clock.step_ms);
      transition(rec, 'running', { result: { ...rec.status.result, due_sim_time_ms: rec.dueSimMs } }, { enqueued: true });
      return clone(rec.status);
    },

    async cancelAction(commandKey, reasonCode, fencingToken) {
      record('cancelAction', [commandKey, reasonCode, fencingToken]);
      const rec = getRec(commandKey);
      const wf = workflows.get(rec.cmd.workflow_id);
      const wfTokenOk = !!wf && wf.fencing_token === fencingToken && wf.lease_expires_unix_ms > now();
      if (rec.fencingToken !== fencingToken && !wfTokenOk) {
        throw new DbError('STALE_FENCING_TOKEN', `token ${fencingToken} for ${commandKey}`);
      }
      if (rec.status.status !== 'requested' && rec.status.status !== 'claimed') {
        throw new DbError('INVALID_TRANSITION', `cannot cancel ${commandKey} from ${rec.status.status}`);
      }
      transition(rec, 'cancelled', { reason_code: reasonCode }, { by: rec.fencingToken === fencingToken ? 'action_token' : 'workflow_token' });
      return clone(rec.status);
    },

    async verifyAction(commandKey, evidence) {
      record('verifyAction', [commandKey, evidence]);
      const rec = getRec(commandKey);
      if (rec.status.status !== 'succeeded') throw new DbError('INVALID_TRANSITION', `cannot verify ${commandKey} in ${rec.status.status}`);
      transition(rec, 'succeeded', { result: { ...rec.status.result, verification: clone(evidence) } }, { verification: evidence });
      return clone(rec.status);
    },

    async claimWorkflow(workflowId, workerId, expectedVersion, leaseMs) {
      record('claimWorkflow', [workflowId, workerId, expectedVersion, leaseMs]);
      let wf = workflows.get(workflowId);
      if (!wf) {
        if (expectedVersion !== 0) throw new DbError('NOT_FOUND', `workflow ${workflowId} (expected v${expectedVersion})`);
        wf = {
          workflow_id: workflowId,
          run_id: snap.run_id,
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
          updated_at_unix_ms: now(),
          version: 0,
        };
        workflows.set(workflowId, wf);
      }
      if (wf.version !== expectedVersion) {
        throw new DbError('VERSION_CONFLICT', `workflow ${workflowId} is v${wf.version}, expected v${expectedVersion}`);
      }
      if (wf.lease_owner && wf.lease_owner !== workerId && wf.lease_expires_unix_ms > now()) {
        throw new DbError('LEASE_HELD', `workflow ${workflowId} leased by ${wf.lease_owner}`);
      }
      wf.lease_owner = workerId;
      wf.fencing_token = nextToken++;
      wf.lease_expires_unix_ms = now() + leaseMs;
      wf.attempt += 1;
      wf.version += 1;
      wf.updated_at_unix_ms = now();
      return lease(wf);
    },

    async heartbeatWorkflow(workflowId, workerId, fencingToken, leaseMs) {
      record('heartbeatWorkflow', [workflowId, workerId, fencingToken, leaseMs]);
      const wf = getWf(workflowId);
      checkWfLease(wf, fencingToken, workerId);
      wf.lease_expires_unix_ms = now() + leaseMs; // §0.11 #16: no version bump
      wf.updated_at_unix_ms = now();
      return lease(wf);
    },

    async updateWorkflow(workflowId, expectedVersion, fencingToken, stage, state) {
      record('updateWorkflow', [workflowId, expectedVersion, fencingToken, stage, state]);
      const wf = getWf(workflowId);
      if (wf.version !== expectedVersion) {
        throw new DbError('VERSION_CONFLICT', `workflow ${workflowId} is v${wf.version}, expected v${expectedVersion}`);
      }
      checkWfLease(wf, fencingToken);
      wf.stage = stage;
      wf.state = clone(state);
      const s = state as { incident_ids?: unknown; plan_id?: unknown; current_command_key?: unknown };
      if (Array.isArray(s.incident_ids)) wf.incident_ids = s.incident_ids.filter((x): x is string => typeof x === 'string');
      if ('plan_id' in s) wf.plan_id = typeof s.plan_id === 'string' ? s.plan_id : null;
      if ('current_command_key' in s) {
        wf.current_command_key = typeof s.current_command_key === 'string' ? s.current_command_key : null;
      }
      wf.version += 1;
      wf.updated_at_unix_ms = now();
      return clone(wf);
    },

    async getWorkflow(workflowId) {
      record('getWorkflow', [workflowId]);
      const wf = workflows.get(workflowId);
      return wf ? clone(wf) : null;
    },

    async listOpenWorkflows() {
      record('listOpenWorkflows', []);
      return [...workflows.values()].filter((w) => w.stage !== 'done').map(clone);
    },

    async upsertIncident(incident, newLinks) {
      record('upsertIncident', [incident, newLinks]);
      mustValidate('Incident', incident);
      newLinks.forEach((l) => mustValidate('IncidentLink', l));
      incidents.set(incident.incident_id, clone(incident));
      for (const l of newLinks) {
        const dup = links.some(
          (x) => x.incident_id === l.incident_id && x.linked_id === l.linked_id && x.link_kind === l.link_kind,
        );
        if (!dup) links.push(clone(l));
      }
      emit('incidents');
      return clone(incident);
    },

    async listIncidents() {
      record('listIncidents', []);
      return [...incidents.values()].map(clone);
    },

    async upsertSymptoms(list) {
      record('upsertSymptoms', [list]);
      for (const s of list) {
        const prev = symptoms.get(s.symptom_id);
        symptoms.set(s.symptom_id, { ...clone(s), first_seen_sim_ms: prev?.first_seen_sim_ms ?? s.first_seen_sim_ms });
      }
    },

    async submitPlan(plan) {
      record('submitPlan', [plan]);
      mustValidate('PlanCandidate', plan);
      plans.set(plan.plan_id, clone(plan));
    },

    async publishAgentEvent(ev) {
      record('publishAgentEvent', [ev]);
      agentEvents.push(clone(ev));
      emit('agentEvents');
    },

    onChange(cb) {
      changeSubs.add(cb);
      return () => changeSubs.delete(cb);
    },

    async ingestObservations(batch) {
      record('ingestObservations', [batch]);
      // Validate the whole batch first: ingestion is atomic.
      const seqs = new Map(lastSourceSeq);
      const ids = new Set<string>();
      for (const ev of batch) {
        const type = 'event_type' in ev ? 'SignalEvent' : 'TelemetryEvent';
        mustValidate(type, ev);
        if (seenEventIds.has(ev.event_id) || ids.has(ev.event_id)) throw new DbError('INVALID_PAYLOAD', `duplicate event_id ${ev.event_id}`);
        const last = seqs.get(ev.source_id) ?? -1;
        if (ev.source_seq <= last) throw new DbError('INVALID_PAYLOAD', `non-monotonic source_seq ${ev.source_seq} for ${ev.source_id}`);
        seqs.set(ev.source_id, ev.source_seq);
        ids.add(ev.event_id);
      }
      for (const ev of batch) {
        seenEventIds.add(ev.event_id);
        if ('event_type' in ev) client.injectSignal(ev);
        else telemetry.push(clone(ev));
      }
      seqs.forEach((v, k) => lastSourceSeq.set(k, v));
    },

    async createRun(runId, _seed, presetId) {
      record('createRun', [runId, _seed, presetId]);
      if (presetId !== 'gpu_demo_8') throw new DbError('INVALID_PAYLOAD', `unknown preset ${presetId}`);
      // Like live create_run: one consistent new run, no rows left over from the old one.
      resetRunState(runId);
      snap = pick('demo');
      restampRunId(snap, runId);
      emitChange({ kind: 'decision_epoch', decision_epoch: snap.clock.decision_epoch, sim_time_ms: simNow() });
      (Object.keys(subs) as Topic[]).forEach((t) => emit(t));
    },

    async configureRun(runId, config) {
      record('configureRun', [runId, config]);
      runConfig = { ...runConfig, ...config };
    },

    async pauseRun(runId, paused) {
      record('pauseRun', [runId, paused]);
      snap.clock.paused = paused;
    },

    async injectFault(fault) {
      record('injectFault', [fault]);
      mustValidate('FaultInjection', fault);
      injectedFaults.push(clone(fault));
      // Mock-only visible effects so dashboards have something to show. Applied now, on top of the current state.
      // event_ids never derive from fault_id: the fault is private truth.
      const seq = (lastSourceSeq.get(SIM_SOURCE) ?? -1) + 1; // monotonic per source (CONTRACTS §A)
      if (fault.kind === 'cooling_pump_degradation' && fault.target_resource_id === 'pump-a') {
        overlayFixture('pump_degraded');
        const pump = snap.cooling.find((c) => c.resource_id === 'pump-a');
        client.injectSignal({
          schema_version: V,
          event_id: `sig.${simNow()}.pump-a.equipment_alarm.${seq}`,
          run_id: snap.run_id,
          resource_id: 'pump-a',
          source_kind: 'simulator',
          source_id: SIM_SOURCE,
          source_seq: seq,
          sim_time_ms: simNow(),
          observed_unix_ms: now(),
          event_type: 'equipment_alarm',
          xid_code: null,
          severity: 'warning',
          message: 'pump-a low-flow alarm: pump power below nominal (simulated)',
          evidence: { operating_state: pump?.operating_state ?? null, pump_power_w: pump?.pump_power_w ?? null, cooling_loop_id: 'loop-a', simulated: true },
        });
      } else if (XID_OF_FAULT[fault.kind] !== undefined) {
        const code = XID_OF_FAULT[fault.kind]!;
        const fx = XID[code]!;
        const gpu = snap.gpus.find((g) => g.resource_id === fault.target_resource_id);
        if (!gpu) throw new DbError('NOT_FOUND', `gpu ${fault.target_resource_id}`);
        // unreachable beats cordoned beats degraded (physics gpuAvailability)
        if (fx.availability === 'unreachable' || gpu.availability === 'ready') gpu.availability = fx.availability;
        gpu.last_xid_code = code;
        gpu.version += 1;
        if (fx.jobFatal) {
          for (const job of snap.job_states.filter((j) => j.allocated_gpu_ids.includes(gpu.resource_id))) failJob(job);
        }
        const rackId = snap.nodes.find((n) => n.resource_id === gpu.node_id)?.rack_id ?? null;
        client.injectSignal({
          ...MOCK_FIXTURES.signal_xid79,
          event_id: `sig.${simNow()}.${gpu.resource_id}.xid_error.${seq}`,
          run_id: snap.run_id,
          resource_id: gpu.resource_id,
          sim_time_ms: simNow(),
          observed_unix_ms: now(),
          source_seq: seq,
          xid_code: code,
          severity: fx.severity,
          message: `Xid ${code}: ${fx.text} (simulated)`,
          evidence: { ...MOCK_FIXTURES.signal_xid79.evidence, xid_code: code, gpu_id: gpu.resource_id, node_id: gpu.node_id, rack_id: rackId },
        });
        emitChange({ kind: 'resource_version', resource_id: gpu.resource_id, version: gpu.version, sim_time_ms: simNow() });
        bumpEpoch();
        emit('gpu', 'jobs');
      }
    },

    async publishEvaluationResult(result) {
      record('publishEvaluationResult', [result]);
      mustValidate('EvaluationResult', result);
      evaluations.set(`${result.scenario_id}|${result.policy}|${result.seed}`, clone(result));
      emit('evaluation');
    },

    onGpu: (cb) => subscribe<GpuCurrent[]>('gpu', () => clone(snap.gpus), cb),
    onJobs: (cb) => subscribe<JobState[]>('jobs', () => clone(snap.job_states), cb),
    onIncidents: (cb) => subscribe<Incident[]>('incidents', () => [...incidents.values()].map(clone), cb),
    onActions: (cb) => subscribe<ActionStatus[]>('actions', () => [...actions.values()].map((r) => clone(r.status)), cb),
    onActionDetails: (cb) =>
      subscribe<ActionDetail[]>(
        'actions',
        () =>
          [...actions.values()]
            .map(toDetail)
            .sort((a, b) => a.command.requested_sim_time_ms - b.command.requested_sim_time_ms || a.status.command_key.localeCompare(b.status.command_key)),
        cb,
      ),
    onAgentEvents: (cb) => subscribe<AgentEventInput[]>('agentEvents', () => agentEvents.map(clone), cb),
    onEvaluation: (cb) => subscribe<EvaluationResult[]>('evaluation', () => [...evaluations.values()].map(clone), cb),

    close() {
      if (autoTimer) clearInterval(autoTimer);
      Object.values(subs).forEach((s) => s.clear());
      changeSubs.clear();
    },

    tick,

    loadSnapshot(s) {
      if (typeof s === 'string') return overlayFixture(s);
      const before = new Map(snap.gpus.map((g) => [g.resource_id, g.version]));
      const epoch = snap.clock.decision_epoch;
      snap = pick(s);
      snap.clock.decision_epoch = Math.max(snap.clock.decision_epoch, epoch);
      for (const g of snap.gpus) {
        if (before.get(g.resource_id) !== g.version) {
          emitChange({ kind: 'resource_version', resource_id: g.resource_id, version: g.version, sim_time_ms: simNow() });
        }
      }
      bumpEpoch();
      emit('gpu', 'jobs');
    },

    injectSignal(signal) {
      signals.push(clone(signal));
      lastSourceSeq.set(signal.source_id, Math.max(lastSourceSeq.get(signal.source_id) ?? -1, signal.source_seq));
      emitChange({ kind: 'signal', signal });
    },
  };
  return client;
}
