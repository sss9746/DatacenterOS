// connect(): the live DbClient over the generated SpacetimeDB bindings (src/generated).
//
// - One WebSocket connection, subscribed to every public table the API reads.
// - Mutations call the reducer and await its commit. The SDK applies the transaction to the client
//   cache BEFORE the promise resolves, so the result is read straight back from the cache (reducers
//   can't return values). claimAction's fencing token is the action row's `lease_token`.
// - Reducer errors ("CODE: message", CONTRACTS §0.11 #14) become DbError with `.code`.
// - Generated rows are camelCase; everything returned here is the snake_case contract shape.
import type {
  ActionCommand,
  ActionStatus,
  Checkpoint,
  CoolingCurrent,
  DependencyEdge,
  EvaluationResult,
  FaultInjection,
  GpuCurrent,
  Incident,
  IncidentLink,
  JobGpuAllocation,
  JobSpec,
  JobState,
  NodeCurrent,
  ObservedSnapshot,
  PlanCandidate,
  ResourceSpec,
  SignalEvent,
  TelemetryEvent,
} from '@dcos/contracts';
import type { ConnectOptions, DbClient, Unsubscribe } from './client.js';
import { DbConnection } from './generated/index.js';
import type * as G from './generated/types.js';
import {
  DbError,
  parseDbError,
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

const V = '1.1.0' as const;
/** Bound on observation_event_ids in a snapshot (most recent signals). */
const MAX_OBSERVATION_IDS = 100;

/** Public tables the client keeps in its cache. */
const TABLES = [
  'run', 'resource', 'dependency_edge', 'gpu_current', 'node_current', 'cooling_current',
  'job_spec', 'job_current', 'job_gpu_allocation', 'checkpoint', 'telemetry_recent', 'signal_event',
  'symptom', 'incident', 'incident_symptom', 'incident_resource', 'workflow', 'workflow_incident',
  'plan', 'action', 'action_event', 'resource_lease', 'agent_event', 'evaluation_result',
] as const;

const nul = <T>(v: T | undefined): T | null => (v === undefined ? null : v);
const parse = <T>(json: string, fallback: T): T => {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
};

// ---------------------------------------------------------------------------------------------
// Row → contract mappers
// ---------------------------------------------------------------------------------------------

function toActionStatus(r: G.Action): ActionStatus {
  const { command: _stored, ...result } = parse<Record<string, unknown>>(r.resultJson, {});
  return {
    schema_version: V,
    run_id: r.runId,
    action_id: r.actionId,
    command_key: r.commandKey,
    status: r.status as ActionStatus['status'],
    attempt: r.attempt,
    updated_sim_time_ms: r.updatedSimTimeMs,
    result: { ...result, ...(r.dueSimTimeMs !== undefined ? { due_sim_time_ms: r.dueSimTimeMs } : {}) },
    reason_code: nul(r.reasonCode),
    version: r.version,
  };
}

function toSafety(v: unknown): ActionSafety | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Partial<ActionSafety>;
  return {
    decision: s.decision ?? 'deny',
    violations: Array.isArray(s.violations) ? s.violations : [],
    checked_decision_epoch: typeof s.checked_decision_epoch === 'number' ? s.checked_decision_epoch : null,
    evidence: s.evidence && typeof s.evidence === 'object' ? s.evidence : {},
  };
}

/** `events` = this action's action_event rows, any order. */
function toActionDetail(r: G.Action, events: G.ActionEvent[]): ActionDetail {
  const stored = parse<{ command?: ActionCommand; safety?: unknown; start_safety?: unknown }>(r.resultJson, {});
  // request_action always stores the command; rebuild it from the columns if a row ever lacks it.
  const command: ActionCommand = stored.command ?? {
    schema_version: V,
    run_id: r.runId,
    action_id: r.actionId,
    command_key: r.commandKey,
    workflow_id: r.workflowId,
    plan_id: r.planId,
    incident_ids: parse<ActionCommand['incident_ids']>(r.incidentIdsJson, [] as unknown as ActionCommand['incident_ids']),
    operation: r.operation as ActionCommand['operation'],
    target_resource_id: r.targetResourceId,
    job_id: nul(r.jobId),
    arguments: parse<Record<string, unknown>>(r.argsJson, {}),
    depends_on_command_keys: parse<string[]>(r.dependsOnCommandKeysJson, []),
    expected_decision_epoch: r.expectedDecisionEpoch,
    expected_resource_versions: parse<Record<string, number>>(r.expectedVersionsJson, {}),
    requested_sim_time_ms: r.requestedSimTimeMs,
  };
  const history = [...events]
    .sort((a, b) => (a.actionEventId < b.actionEventId ? -1 : a.actionEventId > b.actionEventId ? 1 : 0))
    .map((e): ActionHistoryEntry => {
      const { version, ...detail } = parse<Record<string, unknown>>(e.detailJson, {});
      return {
        status: e.status as ActionStatus['status'],
        version: typeof version === 'number' ? version : 0,
        sim_time_ms: e.simTimeMs,
        observed_unix_ms: e.observedUnixMs,
        reason_code: nul(e.reasonCode),
        detail,
      };
    });
  return {
    status: toActionStatus(r),
    command,
    claimed_by: nul(r.claimedBy),
    due_sim_time_ms: nul(r.dueSimTimeMs),
    safety: toSafety(stored.safety),
    start_safety: toSafety(stored.start_safety),
    history,
  };
}

const toIncident = (r: G.Incident): Incident => ({
  schema_version: V,
  run_id: r.runId,
  incident_id: r.incidentId,
  state: r.state as Incident['state'],
  severity: r.severity as Incident['severity'],
  title: r.title,
  hypothesis: nul(r.hypothesis),
  confidence: r.confidence,
  opened_sim_time_ms: r.openedSimTimeMs,
  updated_sim_time_ms: r.updatedSimTimeMs,
  version: r.version,
});

const toSymptom = (r: G.Symptom): SymptomRecord => ({
  symptom_id: r.symptomId,
  run_id: r.runId,
  resource_id: r.resourceId,
  first_seen_sim_ms: r.firstSeenSimMs,
  last_seen_sim_ms: r.lastSeenSimMs,
  kind: r.kind,
  severity: r.severity as SymptomRecord['severity'],
  evidence_event_ids: parse<string[]>(r.evidenceEventIdsJson, []),
  status: r.status,
});

const toSignal = (r: G.SignalEvent): SignalEvent => ({
  schema_version: V,
  event_id: r.eventId,
  run_id: r.runId,
  resource_id: r.resourceId,
  source_kind: r.sourceKind as SignalEvent['source_kind'],
  source_id: r.sourceId,
  source_seq: r.sourceSeq,
  sim_time_ms: r.simTimeMs,
  observed_unix_ms: r.observedUnixMs,
  event_type: r.eventType as SignalEvent['event_type'],
  xid_code: nul(r.xidCode),
  severity: r.severity as SignalEvent['severity'],
  message: r.message,
  evidence: parse<Record<string, unknown>>(r.evidenceJson, {}),
});

const toTelemetry = (r: G.TelemetryRecent): TelemetryEvent => ({
  schema_version: V,
  event_id: r.eventId,
  run_id: r.runId,
  resource_id: r.resourceId,
  source_kind: r.sourceKind as TelemetryEvent['source_kind'],
  source_id: r.sourceId,
  source_seq: r.sourceSeq,
  observed_unix_ms: r.observedUnixMs,
  sim_time_ms: r.simTimeMs,
  metric: r.metric,
  value: r.value,
  unit: r.unit,
  quality: r.quality as TelemetryEvent['quality'],
  labels: parse<Record<string, string>>(r.labelsJson, {}),
});

const toGpu = (r: G.GpuCurrent): GpuCurrent => ({
  schema_version: V,
  run_id: r.runId,
  resource_id: r.resourceId,
  node_id: r.nodeId,
  availability: r.availability as GpuCurrent['availability'],
  temp_c: r.tempC,
  sm_clock_mhz: r.smClockMhz,
  power_w: r.powerW,
  power_limit_w: r.powerLimitW,
  clocks_event_reasons: r.clocksEventReasons,
  last_xid_code: nul(r.lastXidCode),
  last_seen_sim_ms: r.lastSeenSimMs,
  version: r.version,
});

const toAgentEvent = (r: G.AgentEvent): AgentEventInput => ({
  agent_event_id: r.agentEventId,
  run_id: r.runId,
  workflow_id: nul(r.workflowId),
  incident_id: nul(r.incidentId),
  stage: r.stage as AgentEventInput['stage'],
  summary: r.summary,
  evidence_ids: parse<string[]>(r.evidenceIdsJson, []),
  tool_calls: parse<AgentEventInput['tool_calls']>(r.toolCallsJson, []),
  actor: r.actor as AgentEventInput['actor'],
  sim_time_ms: r.simTimeMs,
  observed_unix_ms: r.observedUnixMs,
});

const toEvaluation = (r: G.EvaluationResult): EvaluationResult => ({
  schema_version: V,
  run_id: r.runId,
  scenario_id: r.scenarioId,
  seed: r.seed,
  policy: r.policy as EvaluationResult['policy'],
  ...parse<Omit<EvaluationResult, 'schema_version' | 'run_id' | 'scenario_id' | 'seed' | 'policy'>>(r.metricsJson, {
    lost_work_units: 0, job_completion_delay_s: 0, gpu_busy_waste_s: 0, unnecessary_preemptions: 0,
    unsafe_actions_executed: 0, unsafe_actions_blocked: 0, successful_recoveries: 0, failed_recoveries: 0, agent_crash_resumes: 0,
  }),
});

// ---------------------------------------------------------------------------------------------
// connect()
// ---------------------------------------------------------------------------------------------

export async function connect(opts: ConnectOptions): Promise<DbClient> {
  const conn = await new Promise<DbConnection>((resolve, reject) => {
    DbConnection.builder()
      .withUri(opts.uri)
      .withDatabaseName(opts.db)
      .withToken(opts.token)
      .onConnect((c) => resolve(c))
      .onConnectError((_ctx, err) => reject(new Error(`@dcos/db-client: connect(${opts.db}) failed: ${String(err)}`)))
      .build();
  });
  await new Promise<void>((resolve, reject) => {
    conn
      .subscriptionBuilder()
      .onApplied(() => resolve())
      .onError((ctx) => reject(new Error(`@dcos/db-client: subscription failed: ${String((ctx as { event?: unknown }).event ?? 'error')}`)))
      .subscribe(TABLES.map((t) => `SELECT * FROM ${t}`));
  });

  const db = conn.db;
  const r = conn.reducers;

  /** Await a reducer; turn "CODE: message" rejections into DbError. */
  async function call(p: Promise<void>): Promise<void> {
    try {
      await p;
    } catch (e) {
      throw parseDbError(e);
    }
  }

  const runRow = (): G.Run | undefined => {
    const rows = [...db.run.iter()];
    return opts.runId ? rows.find((x) => x.runId === opts.runId) : rows[0];
  };
  const requireRun = (): G.Run => {
    const run = runRow();
    if (!run) throw new DbError('NOT_FOUND', 'no run in the database (call createRun first)');
    return run;
  };
  const actionRow = (key: string) => [...db.action.iter()].find((a) => a.commandKey === key);
  const mustAction = (key: string): G.Action => {
    const row = actionRow(key);
    if (!row) throw new DbError('NOT_FOUND', `no action ${key}`);
    return row;
  };
  const workflowRow = (id: string) => [...db.workflow.iter()].find((w) => w.workflowId === id);

  function toWorkflow(w: G.Workflow): WorkflowRecord {
    return {
      workflow_id: w.workflowId,
      run_id: w.runId,
      stage: w.stage as WorkflowStage,
      state: parse<Record<string, unknown>>(w.stateJson, {}),
      incident_ids: [...db.workflowIncident.iter()].filter((l) => l.workflowId === w.workflowId).map((l) => l.incidentId).sort(),
      plan_id: nul(w.planId),
      current_command_key: nul(w.currentCommandKey),
      last_processed_event_seq: w.lastProcessedEventSeq,
      attempt: w.attempt,
      lease_owner: nul(w.leaseOwner),
      lease_expires_unix_ms: w.leaseExpiresUnixMs,
      fencing_token: w.fencingToken,
      updated_at_unix_ms: w.updatedAtUnixMs,
      version: w.version,
    };
  }
  const leaseOf = (id: string): WorkflowLease => {
    const w = workflowRow(id);
    if (!w) throw new DbError('NOT_FOUND', `workflow ${id}`);
    return { workflow: toWorkflow(w), fencing_token: w.fencingToken, lease_expires_unix_ms: w.leaseExpiresUnixMs };
  };

  function jobStates(): JobState[] {
    const alloc = [...db.jobGpuAllocation.iter()];
    return [...db.jobCurrent.iter()].map((j) => ({
      schema_version: V,
      run_id: j.runId,
      job_id: j.jobId,
      status: j.status as JobState['status'],
      allocated_gpu_ids: alloc.filter((a) => a.jobId === j.jobId).map((a) => a.gpuId).sort(),
      progress_work_units: j.progressWorkUnits,
      durable_work_units: j.durableWorkUnits,
      latest_checkpoint_id: nul(j.latestCheckpointId),
      version: j.version,
      last_update_sim_time_ms: j.lastUpdateSimTimeMs,
    }));
  }

  function snapshot(): ObservedSnapshot {
    const run = requireRun();
    const resources: ResourceSpec[] = [...db.resource.iter()].map((x) => ({
      schema_version: V, run_id: x.runId, resource_id: x.resourceId, kind: x.kind as ResourceSpec['kind'],
      parent_id: nul(x.parentId), failure_domain_id: x.failureDomainId, profile: x.profile,
      config: parse<Record<string, unknown>>(x.configJson, {}), enabled: x.enabled,
    }));
    const dependencies: DependencyEdge[] = [...db.dependencyEdge.iter()].map((x) => ({
      schema_version: V, run_id: x.runId, edge_id: x.edgeId, consumer_id: x.consumerId, provider_id: x.providerId,
      relation: x.relation as DependencyEdge['relation'], weight: x.weight,
    }));
    const nodes: NodeCurrent[] = [...db.nodeCurrent.iter()].map((x) => ({
      schema_version: V, run_id: x.runId, resource_id: x.resourceId, rack_id: x.rackId,
      availability: x.availability as NodeCurrent['availability'], power_headroom_w: x.powerHeadroomW,
      thermal_headroom_c: x.thermalHeadroomC, version: x.version,
    }));
    const cooling: CoolingCurrent[] = [...db.coolingCurrent.iter()].map((x) => ({
      schema_version: V, run_id: x.runId, resource_id: x.resourceId, operating_state: x.operatingState as CoolingCurrent['operating_state'],
      nominal_capacity_w: x.nominalCapacityW, pump_power_w: x.pumpPowerW,
      observed_capacity_estimate_w: nul(x.observedCapacityEstimateW), version: x.version,
    }));
    const job_specs: JobSpec[] = [...db.jobSpec.iter()].map((x) => ({
      schema_version: V, run_id: x.runId, job_id: x.jobId, gpus_required: x.gpusRequired,
      placement_policy: x.placementPolicy as JobSpec['placement_policy'],
      compatible_node_ids: parse<JobSpec['compatible_node_ids']>(x.compatibleNodeIdsJson, [] as unknown as JobSpec['compatible_node_ids']),
      gpu_profile: x.gpuProfile, priority: x.priority, preemptible: x.preemptible, checkpoint_supported: x.checkpointSupported,
      checkpoint_storage_id: nul(x.checkpointStorageId), checkpoint_duration_ms: x.checkpointDurationMs,
      restart_duration_ms: x.restartDurationMs, checkpoint_interval_ms: x.checkpointIntervalMs,
      total_work_units: x.totalWorkUnits, work_rate_per_gpu_per_sim_s: x.workRatePerGpuPerSimS,
    }));
    const allocations: JobGpuAllocation[] = [...db.jobGpuAllocation.iter()].map((x) => ({
      schema_version: V, run_id: x.runId, job_id: x.jobId, gpu_id: x.gpuId, since_sim_time_ms: x.sinceSimTimeMs,
    }));
    const checkpoints: Checkpoint[] = [...db.checkpoint.iter()].map((x) => ({
      schema_version: V, run_id: x.runId, checkpoint_id: x.checkpointId, job_id: x.jobId, storage_resource_id: x.storageResourceId,
      status: x.status as Checkpoint['status'], progress_work_units: x.progressWorkUnits, requested_sim_time_ms: x.requestedSimTimeMs,
      complete_sim_time_ms: nul(x.completeSimTimeMs), accessible: x.accessible, command_key: x.commandKey,
    }));
    const observation_event_ids = [...db.signalEvent.iter()]
      .sort((a, b) => a.simTimeMs - b.simTimeMs || a.sourceSeq - b.sourceSeq)
      .slice(-MAX_OBSERVATION_IDS)
      .map((s) => s.eventId);
    return {
      schema_version: V,
      run_id: run.runId,
      clock: {
        sim_time_ms: run.simTimeMs, tick_index: run.tickIndex, step_ms: run.stepMs,
        wall_tick_ms: run.wallTickMs, paused: run.paused, decision_epoch: run.decisionEpoch,
      },
      resources, dependencies, gpus: [...db.gpuCurrent.iter()].map(toGpu), nodes, cooling,
      job_specs, job_states: jobStates(), allocations, checkpoints, observation_event_ids,
    };
  }

  // --- list subscriptions (fire now, then once per batch of changes) -----------------------------
  type Cb = (...a: never[]) => void;
  type Watchable = {
    onInsert(cb: Cb): void; removeOnInsert(cb: Cb): void;
    onUpdate?(cb: Cb): void; removeOnUpdate?(cb: Cb): void;
    onDelete(cb: Cb): void; removeOnDelete(cb: Cb): void;
  };
  function watch<T>(tables: Watchable[], read: () => T, cb: (v: T) => void): Unsubscribe {
    let live = true;
    let queued = false;
    const fire = () => {
      if (!live || queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (live) cb(read());
      });
    };
    for (const t of tables) {
      t.onInsert(fire);
      t.onUpdate?.(fire);
      t.onDelete(fire);
    }
    cb(read());
    return () => {
      live = false;
      for (const t of tables) {
        t.removeOnInsert(fire);
        t.removeOnUpdate?.(fire);
        t.removeOnDelete(fire);
      }
    };
  }
  const w = (t: unknown) => t as Watchable;

  // --- change feed (§0.11 #15) ----------------------------------------------------------------
  const changeSubs = new Set<(c: DbChange) => void>();
  const emit = (c: DbChange) => changeSubs.forEach((cb) => cb(c));
  db.run.onUpdate((_ctx, oldRow, newRow) => {
    if (oldRow.decisionEpoch !== newRow.decisionEpoch) {
      emit({ kind: 'decision_epoch', decision_epoch: newRow.decisionEpoch, sim_time_ms: newRow.simTimeMs });
    }
  });
  const simNow = () => runRow()?.simTimeMs ?? 0;
  db.gpuCurrent.onUpdate((_ctx, oldRow, newRow) => {
    if (oldRow.version !== newRow.version) emit({ kind: 'resource_version', resource_id: newRow.resourceId, version: newRow.version, sim_time_ms: simNow() });
  });
  db.resource.onUpdate((_ctx, oldRow, newRow) => {
    if (oldRow.version !== newRow.version && newRow.kind !== 'gpu') {
      emit({ kind: 'resource_version', resource_id: newRow.resourceId, version: newRow.version, sim_time_ms: simNow() });
    }
  });
  db.signalEvent.onInsert((_ctx, row) => emit({ kind: 'signal', signal: toSignal(row) }));
  db.action.onInsert((_ctx, row) => emit({ kind: 'action_status', status: toActionStatus(row) }));
  db.action.onUpdate((_ctx, _old, row) => emit({ kind: 'action_status', status: toActionStatus(row) }));

  const client: DbClient = {
    mode: 'live',

    async getObservedSnapshot() {
      return snapshot();
    },

    async getEvidence(incidentIds, windowSimMs) {
      const asOf = simNow();
      const wanted = new Set(incidentIds);
      const incidents = [...db.incident.iter()].filter((i) => wanted.size === 0 || wanted.has(i.incidentId)).map(toIncident);
      const symLinks = [...db.incidentSymptom.iter()].filter((l) => wanted.size === 0 || wanted.has(l.incidentId));
      const resLinks = [...db.incidentResource.iter()].filter((l) => wanted.size === 0 || wanted.has(l.incidentId));
      const wfLinks = [...db.workflowIncident.iter()].filter((l) => wanted.size === 0 || wanted.has(l.incidentId));
      const links: IncidentLink[] = [
        ...symLinks.map((l) => ({ schema_version: V, run_id: l.runId, incident_id: l.incidentId, linked_id: l.symptomId, link_kind: 'symptom' as const, reason: l.reason })),
        ...resLinks.map((l) => ({ schema_version: V, run_id: l.runId, incident_id: l.incidentId, linked_id: l.resourceId, link_kind: 'resource' as const, reason: l.reason })),
        // workflow_incident has no reason column
        ...wfLinks.map((l) => ({ schema_version: V, run_id: l.runId, incident_id: l.incidentId, linked_id: l.workflowId, link_kind: 'workflow' as const, reason: 'workflow' })),
      ];
      const symptomIds = new Set(symLinks.map((l) => l.symptomId));
      const allSymptoms = [...db.symptom.iter()];
      const linkedResources = new Set([
        ...resLinks.map((l) => l.resourceId),
        ...allSymptoms.filter((s) => symptomIds.has(s.symptomId)).map((s) => s.resourceId),
      ]);
      const inScope = (x: { simTimeMs: number; resourceId: string }) =>
        x.simTimeMs >= asOf - windowSimMs && x.simTimeMs <= asOf && (wanted.size === 0 || linkedResources.has(x.resourceId));
      const evidence: Evidence = {
        run_id: runRow()?.runId ?? '',
        incident_ids: [...incidentIds],
        window_sim_ms: windowSimMs,
        as_of_sim_time_ms: asOf,
        incidents,
        links,
        symptoms: allSymptoms
          .filter((s) => s.lastSeenSimMs >= asOf - windowSimMs && (wanted.size === 0 || symptomIds.has(s.symptomId)))
          .map(toSymptom),
        signals: [...db.signalEvent.iter()].filter(inScope).map(toSignal),
        telemetry: [...db.telemetryRecent.iter()].filter(inScope).map(toTelemetry),
      };
      return evidence;
    },

    async getActionStatus(commandKey) {
      const row = actionRow(commandKey);
      return row ? toActionStatus(row) : null;
    },

    async requestAction(cmd: ActionCommand) {
      await call(r.requestAction({ actionCommandJson: JSON.stringify(cmd) }));
      return toActionStatus(mustAction(cmd.command_key));
    },

    async claimAction(commandKey, expectedVersion, workerId) {
      await call(r.claimAction({ commandKey, expectedActionVersion: expectedVersion, workerId }));
      const row = mustAction(commandKey);
      const status = toActionStatus(row);
      return { status: { ...status, result: { ...status.result, claimed_by: workerId } }, fencing_token: row.leaseToken };
    },

    async startAction(commandKey, fencingToken) {
      await call(r.startAction({ commandKey, fencingToken }));
      return toActionStatus(mustAction(commandKey));
    },

    async cancelAction(commandKey, reasonCode, fencingToken) {
      await call(r.cancelAction({ commandKey, reasonCode, fencingToken }));
      return toActionStatus(mustAction(commandKey));
    },

    async verifyAction(commandKey, evidence) {
      await call(r.verifyAction({ commandKey, evidenceJson: JSON.stringify(evidence) }));
      return toActionStatus(mustAction(commandKey));
    },

    async claimWorkflow(workflowId, workerId, expectedVersion, leaseMs) {
      await call(r.claimWorkflow({ workflowId, workerId, expectedVersion, leaseMs }));
      return leaseOf(workflowId);
    },

    async heartbeatWorkflow(workflowId, workerId, fencingToken, leaseMs) {
      await call(r.heartbeatWorkflow({ workflowId, workerId, fencingToken, leaseMs }));
      return leaseOf(workflowId);
    },

    async updateWorkflow(workflowId, expectedVersion, fencingToken, stage, state) {
      await call(r.updateWorkflow({ workflowId, expectedVersion, fencingToken, stage, stateJson: JSON.stringify(state) }));
      return leaseOf(workflowId).workflow;
    },

    async getWorkflow(workflowId) {
      const row = workflowRow(workflowId);
      return row ? toWorkflow(row) : null;
    },

    async listOpenWorkflows() {
      return [...db.workflow.iter()].filter((x) => x.stage !== 'done').map(toWorkflow);
    },

    async upsertIncident(incident, links) {
      await call(r.upsertIncident({ incidentJson: JSON.stringify(incident), linksJson: JSON.stringify(links) }));
      const row = [...db.incident.iter()].find((i) => i.incidentId === incident.incident_id);
      return row ? toIncident(row) : incident;
    },

    async listIncidents() {
      return [...db.incident.iter()].map(toIncident);
    },

    async upsertSymptoms(symptoms) {
      await call(r.upsertSymptoms({ symptomsJson: JSON.stringify(symptoms) }));
    },

    async submitPlan(plan: PlanCandidate) {
      await call(r.submitPlan({ planJson: JSON.stringify(plan) }));
    },

    async publishAgentEvent(ev) {
      await call(r.publishAgentEvent({ agentEventJson: JSON.stringify(ev) }));
    },

    onChange(cb) {
      changeSubs.add(cb);
      return () => changeSubs.delete(cb);
    },

    async ingestObservations(_batch) {
      throw new DbError('INVALID_TRANSITION', 'ingest_observations lands in P2-9');
    },

    async createRun(runId, seed, presetId) {
      await call(r.createRun({ runId, seed, presetId }));
    },

    async configureRun(runId, config: RunConfig) {
      await call(r.configureRun({ runId, configJson: JSON.stringify(config) }));
    },

    async pauseRun(runId, paused) {
      await call(r.pauseRun({ runId, paused }));
    },

    async injectFault(fault: FaultInjection) {
      await call(r.injectFault({ faultJson: JSON.stringify(fault) }));
    },

    async publishEvaluationResult(result: EvaluationResult) {
      await call(r.publishEvaluationResult({ resultJson: JSON.stringify(result) }));
    },

    onGpu: (cb) => watch([w(db.gpuCurrent)], () => [...db.gpuCurrent.iter()].map(toGpu), cb),
    onJobs: (cb) => watch([w(db.jobCurrent), w(db.jobGpuAllocation)], jobStates, cb),
    onIncidents: (cb) => watch([w(db.incident)], () => [...db.incident.iter()].map(toIncident), cb),
    onActions: (cb) => watch([w(db.action)], () => [...db.action.iter()].map(toActionStatus), cb),
    onActionDetails: (cb) =>
      watch([w(db.action), w(db.actionEvent)], () => {
        const byKey = new Map<string, G.ActionEvent[]>();
        for (const e of db.actionEvent.iter()) {
          const list = byKey.get(e.commandKey);
          if (list) list.push(e);
          else byKey.set(e.commandKey, [e]);
        }
        return [...db.action.iter()]
          .map((a) => toActionDetail(a, byKey.get(a.commandKey) ?? []))
          .sort((a, b) => a.command.requested_sim_time_ms - b.command.requested_sim_time_ms || a.status.command_key.localeCompare(b.status.command_key));
      }, cb),
    onAgentEvents: (cb) =>
      watch([w(db.agentEvent)], () => [...db.agentEvent.iter()].map(toAgentEvent).sort((a, b) => a.sim_time_ms - b.sim_time_ms), cb),
    onEvaluation: (cb) => watch([w(db.evaluationResult)], () => [...db.evaluationResult.iter()].map(toEvaluation), cb),

    close() {
      changeSubs.clear();
      conn.disconnect();
    },
  };
  return client;
}
