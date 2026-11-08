import { validatePayload, type ActionCommand, type ActionStatus, type FaultInjection, type PhysicsWorld } from '@dcos/contracts';
import { createMockClient, type ActionDetail, type DbClient, type MockDbClient } from '@dcos/db-client';
import { buildPreset, commandOutcome, enqueueCommands, evaluateSafety, inFlightCommands, step, thresholdPolicy, toObserved, STEP_MS, WIRE_SCHEMA_VERSION } from '@dcos/physics';

/**
 * Browser-local demo using P1's real physics engine. The mock DB client only supplies the
 * existing subscription/read API; it does not advance the world or apply faults here.
 * `requestAction` runs P1's real `evaluateSafety` (the same check the live `request_action` reducer
 * runs), so a presenter safety probe gets a real decision; accepted actions are recorded but never
 * executed by this local world. This is an isolated run, not a durable SpacetimeDB session or an agent execution.
 */
export interface LocalPhysicsClient extends MockDbClient {
  readonly localPhysics: true;
  advance(seconds: number): void;
  /**
   * In-browser recovery preview (deterministic, NOT the live agent and NOT Nemotron): runs @dcos/physics'
   * `thresholdPolicy` on the current observed snapshot and pushes its commands through the normal ledger path
   * (requestAction → real evaluateSafety → claim → start). Started commands are handed to the same physics `step`
   * that advances this world, so a checkpoint takes 30 sim-s and a migrate_restart 120 sim-s as the user advances.
   * Re-planned after every advance while enabled (the policy re-emits a cycle's move once its checkpoint is durable).
   */
  runRecoveryPreview(): Promise<void>;
  readonly recoveryPreview: RecoveryPreviewState;
}

export interface RecoveryPreviewState {
  enabled: boolean;
  /** Human-readable log of what the preview planner requested and what the ledger answered, oldest first. */
  log: string[];
}
export const PREVIEW_PLANNER_WORKER = 'preview-planner';
const PREVIEW_LOG_LIMIT = 30;

export interface LocalFacilityConfig {
  pumpACapacityPct: number;
  pumpBCapacityPct: number;
  rack6InletOffsetC: number;
}

export const DEFAULT_LOCAL_FACILITY: LocalFacilityConfig = {
  pumpACapacityPct: 100,
  pumpBCapacityPct: 100,
  rack6InletOffsetC: 12,
};

function configuredWorld(seed: number, config: LocalFacilityConfig, runId = 'run-demo-1'): PhysicsWorld {
  for (const value of [config.pumpACapacityPct, config.pumpBCapacityPct]) {
    if (!Number.isFinite(value) || value < 40 || value > 140) throw new Error('Pump capacity must be 40–140%.');
  }
  if (!Number.isFinite(config.rack6InletOffsetC) || config.rack6InletOffsetC < 0 || config.rack6InletOffsetC > 20) {
    throw new Error('Rack 6 inlet offset must be 0–20 °C.');
  }
  let next = buildPreset('gpu_demo_8', runId, seed);
  const pumpFactors: Record<string, number> = { 'pump-a': config.pumpACapacityPct / 100, 'pump-b': config.pumpBCapacityPct / 100 };
  for (const resource of next.observable.resources) {
    if (resource.kind === 'cooling_pump') {
      const nominal = resource.config.nominal_capacity_w;
      if (typeof nominal === 'number') resource.config.nominal_capacity_w = nominal * pumpFactors[resource.resource_id]!;
    }
    if (resource.resource_id === 'rack-r6') resource.config.inlet_offset_c = config.rack6InletOffsetC;
  }
  for (const row of next.observable.cooling) {
    const factor = pumpFactors[row.resource_id];
    if (factor !== undefined) {
      row.nominal_capacity_w *= factor;
      row.observed_capacity_estimate_w = row.nominal_capacity_w;
    }
  }
  if (config.pumpACapacityPct !== 100 || config.pumpBCapacityPct !== 100 || config.rack6InletOffsetC !== 12) {
    next = step({ schema_version: WIRE_SCHEMA_VERSION, run_id: next.run_id, world: next,
      step_ms: STEP_MS, seed, due_faults_private: [], requested_action_ids: [] }).world_after;
  }
  return next;
}

const allowedTargets: Record<FaultInjection['kind'], readonly string[]> = {
  cooling_pump_degradation: ['cooling_pump'],
  cooling_pump_outage: ['cooling_pump'],
  gpu_thermal_load: ['gpu'],
  gpu_xid_48: ['gpu'],
  gpu_xid_79: ['gpu'],
  gpu_xid_74: ['gpu'],
  network_link_down: ['network_link', 'checkpoint_store'],
  node_crash: ['node', 'checkpoint_store'],
  sensor_stale: ['gpu', 'rack', 'cooling_pump'],
};

export function createLocalPhysicsClient(seed = 42, config: LocalFacilityConfig = DEFAULT_LOCAL_FACILITY): LocalPhysicsClient {
  let world = configuredWorld(seed, config);
  const base = createMockClient({ snapshot: toObserved(world), evaluateSafety: (obs, cmd, ctx) => evaluateSafety(obs, cmd, ctx) });
  const pending: FaultInjection[] = [];
  const injected: FaultInjection[] = [];
  const sync = () => base.loadSnapshot(toObserved(world));

  // ---- command path: ledger `running` → physics inbox → the next step starts it; physics outcomes flow back ----
  /** Commands physics has been handed (started in the ledger), by command_key. */
  const tracked = new Map<string, ActionCommand>();
  /** action_ids to hand to the next step's requested_action_ids. */
  const requestedIds: string[] = [];
  /** Physics failures the mock ledger cannot represent itself (it only completes by due time): overlaid on reads. */
  const physicsFailed = new Map<string, { reason_code: string; sim_time_ms: number }>();
  const recovery: RecoveryPreviewState = { enabled: false, log: [] };
  const log = (line: string) => { recovery.log = [...recovery.log, `${formatSim(world.observable.clock.sim_time_ms)} ${line}`].slice(-PREVIEW_LOG_LIMIT); };

  const overlayStatus = (status: ActionStatus): ActionStatus => {
    const failed = physicsFailed.get(status.command_key);
    if (!failed || status.status !== 'running') return status;
    const outcome = { status: 'failed', reason_code: failed.reason_code, sim_time_ms: failed.sim_time_ms };
    return { ...status, status: 'failed', reason_code: failed.reason_code, updated_sim_time_ms: failed.sim_time_ms, version: status.version + 1, result: { ...status.result, outcome } };
  };
  const overlayDetail = (detail: ActionDetail): ActionDetail => {
    const status = overlayStatus(detail.status);
    const due = inFlightCommands(world).find((f) => f.command_key === detail.command.command_key)?.due_sim_time_ms ?? detail.due_sim_time_ms;
    if (status === detail.status && due === detail.due_sim_time_ms) return detail;
    const history = status === detail.status ? detail.history : [...detail.history, { status: status.status, version: status.version, sim_time_ms: status.updated_sim_time_ms, observed_unix_ms: Date.now(), reason_code: status.reason_code, detail: { outcome: status.result.outcome ?? {}, source: 'local physics' } }];
    return { ...detail, status, due_sim_time_ms: due, history };
  };
  let latestActions: ActionStatus[] = []; let latestDetails: ActionDetail[] = [];
  const actionSubs = new Set<(rows: ActionStatus[]) => void>(); const detailSubs = new Set<(rows: ActionDetail[]) => void>();
  base.onActions((rows) => { latestActions = rows; actionSubs.forEach((cb) => cb(rows.map(overlayStatus))); });
  base.onActionDetails((rows) => { latestDetails = rows; detailSubs.forEach((cb) => cb(rows.map(overlayDetail))); });
  const refan = () => { actionSubs.forEach((cb) => cb(latestActions.map(overlayStatus))); detailSubs.forEach((cb) => cb(latestDetails.map(overlayDetail))); };

  /** After physics stepped: finished commands land in the ledger (success via the mock's own due-time completion). */
  const settleCommands = () => {
    let succeeded = false;
    for (const [key, cmd] of tracked) {
      const outcome = commandOutcome(world, key);
      if (!outcome || outcome.status === 'running') continue;
      tracked.delete(key);
      if (outcome.status === 'failed') { physicsFailed.set(key, { reason_code: outcome.reason_code ?? 'FAILED', sim_time_ms: world.observable.clock.sim_time_ms }); log(`${cmd.operation} ${cmd.job_id ?? cmd.target_resource_id} FAILED in physics: ${outcome.reason_code ?? 'FAILED'}`); }
      else { succeeded = true; log(`${cmd.operation} ${cmd.job_id ?? cmd.target_resource_id} succeeded (physics)`); }
    }
    // The mock completes a running action once its due time has passed; physics completes at the same or a later tick, so
    // a zero-length mock tick now marks exactly the succeeded ones. Its canned effects are overwritten by the next sync.
    if (succeeded) { base.tick(0); sync(); }
    refan();
  };
  const runSteps = (count: number, publishEachStep: boolean) => {
    if (world.observable.clock.paused) return;
    const signals = [] as ReturnType<typeof step>['signals'];
    for (let i = 0; i < count; i++) {
      const due = pending.filter((fault) => fault.start_sim_time_ms <= world.observable.clock.sim_time_ms + STEP_MS);
      for (const fault of due) pending.splice(pending.indexOf(fault), 1);
      const result = step({
        schema_version: WIRE_SCHEMA_VERSION,
        run_id: world.run_id,
        world,
        step_ms: STEP_MS,
        seed,
        due_faults_private: due,
        requested_action_ids: requestedIds.splice(0),
      });
      world = result.world_after;
      signals.push(...result.signals);
      if (publishEachStep) sync();
    }
    if (!publishEachStep) sync();
    for (const signal of signals) base.injectSignal(signal);
    if (tracked.size > 0) settleCommands();
  };

  // ---- the preview planner (deterministic thresholdPolicy from @dcos/physics; never Nemotron, never the agent) ----
  let driving = false;
  const describe = (cmd: ActionCommand) => `${cmd.operation} ${cmd.job_id ?? cmd.target_resource_id}${Array.isArray(cmd.arguments.destination_gpu_ids) ? ` → ${[...new Set((cmd.arguments.destination_gpu_ids as string[]).map((id) => `R${/gpu-r(\d+)-/.exec(id)?.[1] ?? '?'}`))].join('+')}` : ''}`;
  const drive = async () => {
    if (!recovery.enabled || driving) return;
    driving = true;
    try {
      const obs = await client.getObservedSnapshot();
      const commands = thresholdPolicy(obs);
      if (commands.length === 0 && tracked.size === 0) { if (!recovery.log.at(-1)?.includes('nothing to do')) log('planner: nothing to do (no GPU over 83 °C, no failed job on an XID GPU)'); return; }
      for (const planned of commands) {
        if (await base.getActionStatus(planned.command_key)) continue; // already requested earlier (idempotent keys)
        const deps = await Promise.all(planned.depends_on_command_keys.map((key) => base.getActionStatus(key)));
        if (deps.some((dep) => dep?.status !== 'succeeded')) continue; // e.g. the move waits for its checkpoint to be durable
        const cmd: ActionCommand = { ...planned, workflow_id: `wf-preview-${planned.workflow_id}`, plan_id: `plan-preview-${planned.plan_id}` };
        const requested = await client.requestAction(cmd);
        if (requested.status !== 'requested') { log(`${describe(cmd)} BLOCKED by evaluateSafety: ${(Array.isArray(requested.result.violations) ? requested.result.violations : [requested.reason_code]).join(', ')}`); continue; }
        const claim = await base.claimAction(cmd.command_key, requested.version, PREVIEW_PLANNER_WORKER);
        const started = await client.startAction(cmd.command_key, claim.fencing_token);
        log(started.status === 'running' ? `${describe(cmd)} requested · allowed · running` : `${describe(cmd)} not started: ${started.status} ${started.reason_code ?? ''}`);
      }
    } catch (error) { log(`planner error: ${error instanceof Error ? error.message : String(error)}`); }
    finally { driving = false; }
  };

  const client: LocalPhysicsClient = {
    ...base,
    localPhysics: true,
    get injectedFaults() { return injected; },
    get recoveryPreview() { return recovery; },
    async runRecoveryPreview() { recovery.enabled = true; log('planner started: in-browser deterministic thresholdPolicy (not Nemotron, not the live agent)'); await drive(); },
    onActions(cb) { actionSubs.add(cb); cb(latestActions.map(overlayStatus)); return () => { actionSubs.delete(cb); }; },
    onActionDetails(cb) { detailSubs.add(cb); cb(latestDetails.map(overlayDetail)); return () => { detailSubs.delete(cb); }; },
    async getActionStatus(commandKey) { const status = await base.getActionStatus(commandKey); return status ? overlayStatus(status) : null; },
    async requestAction(cmd) { return base.requestAction(cmd); },
    async startAction(commandKey, fencingToken) {
      const status = await base.startAction(commandKey, fencingToken);
      const cmd = latestDetails.find((d) => d.command.command_key === commandKey)?.command;
      if (status.status === 'running' && cmd) { world = enqueueCommands(world, [cmd]); requestedIds.push(cmd.action_id); tracked.set(commandKey, cmd); }
      return status;
    },
    // The mock base bumps its decision epoch on every published step and checks commands against that epoch,
    // so reads expose the base's epoch: a command built from a fresh read then matches what requestAction checks.
    getObservedSnapshot: async () => {
      const observed = toObserved(world);
      observed.clock.decision_epoch = (await base.getObservedSnapshot()).clock.decision_epoch;
      return observed;
    },
    tick(simMs = STEP_MS) { runSteps(Math.max(1, Math.round(simMs / STEP_MS)), true); if (recovery.enabled) void drive(); },
    advance(seconds) { runSteps(Math.max(1, Math.min(600, Math.round(seconds))), false); if (recovery.enabled) void drive(); },
    async injectFault(fault) {
      const validation = validatePayload('FaultInjection', fault);
      if (!validation.ok) throw new Error(`Invalid fault injection: ${validation.errors.join('; ')}`);
      if (fault.run_id !== world.run_id) throw new Error('Fault belongs to a different run.');
      const target = world.observable.resources.find((resource) => resource.resource_id === fault.target_resource_id);
      if (!target || !allowedTargets[fault.kind].includes(target.kind) || target.resource_id === 'gpu-real-0' || target.resource_id === 'node-real-0') {
        throw new Error(`${fault.target_resource_id} is not a supported target for ${fault.kind}.`);
      }
      if (injected.some((entry) => entry.fault_id === fault.fault_id)) throw new Error(`Fault ${fault.fault_id} already exists.`);
      injected.push(structuredClone(fault));
      pending.push(structuredClone(fault));
    },
    async createRun(runId, nextSeed, presetId) {
      if (presetId !== 'gpu_demo_8') throw new Error(`Unknown preset ${presetId}.`);
      world = configuredWorld(nextSeed, config, runId);
      pending.length = 0;
      injected.length = 0;
      tracked.clear(); requestedIds.length = 0; physicsFailed.clear(); recovery.enabled = false; recovery.log = [];
      await base.createRun(runId, nextSeed, presetId);
      sync();
    },
    async pauseRun(runId, paused) {
      if (runId !== world.run_id) throw new Error('Run not found.');
      world = { ...world, observable: { ...world.observable, clock: { ...world.observable.clock, paused } } };
      await base.pauseRun(runId, paused);
      sync();
    },
  };
  return client;
}

const formatSim = (ms: number) => { const s = Math.floor(ms / 1000); return `[${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}]`; };

export function asLocalPhysics(client: DbClient): LocalPhysicsClient | null {
  return 'localPhysics' in client && client.localPhysics === true ? client as LocalPhysicsClient : null;
}
