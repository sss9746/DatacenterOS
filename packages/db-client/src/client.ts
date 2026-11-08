// The one client interface. `createMockClient()` and `connect()` both return a DbClient,
// so P3/P4 switch between mock and live without code changes (CONTRACTS §0.6, frozen names).

import type {
  ActionCommand,
  ActionStatus,
  EvaluationResult,
  FaultInjection,
  GpuCurrent,
  Incident,
  IncidentLink,
  JobState,
  ObservedSnapshot,
  PlanCandidate,
  SignalEvent,
  TelemetryEvent,
} from '@dcos/contracts';
import type {
  AgentEventInput,
  DbChange,
  Evidence,
  RunConfig,
  SymptomRecord,
  WorkflowLease,
  WorkflowRecord,
  WorkflowStage,
} from './types.js';

export type Unsubscribe = () => void;

/** Agent-facing API. Same method set as `DbPort` in apps/agent/src/ports.ts. */
export interface AgentApi {
  getObservedSnapshot(): Promise<ObservedSnapshot>;
  getEvidence(incidentIds: string[], windowSimMs: number): Promise<Evidence>;
  getActionStatus(commandKey: string): Promise<ActionStatus | null>;
  /** Idempotent by command_key. A safety deny RETURNS failed + SAFETY_REJECTED (§0.11 #3). */
  requestAction(cmd: ActionCommand): Promise<ActionStatus>;
  claimAction(
    commandKey: string,
    expectedVersion: number,
    workerId: string,
  ): Promise<{ status: ActionStatus; fencing_token: bigint }>;
  startAction(commandKey: string, fencingToken: bigint): Promise<ActionStatus>;
  /** Accepts the action's own token or its owning workflow's token (§0.11 #13). Only requested/claimed. */
  cancelAction(commandKey: string, reasonCode: string, fencingToken: bigint): Promise<ActionStatus>;
  verifyAction(commandKey: string, evidence: Record<string, unknown>): Promise<ActionStatus>;
  claimWorkflow(workflowId: string, workerId: string, expectedVersion: number, leaseMs: number): Promise<WorkflowLease>;
  /** Extends the lease only; does not bump `version` (§0.11 #16). */
  heartbeatWorkflow(workflowId: string, workerId: string, fencingToken: bigint, leaseMs: number): Promise<WorkflowLease>;
  updateWorkflow(
    workflowId: string,
    expectedVersion: number,
    fencingToken: bigint,
    stage: WorkflowStage,
    state: Record<string, unknown>,
  ): Promise<WorkflowRecord>;
  getWorkflow(workflowId: string): Promise<WorkflowRecord | null>;
  listOpenWorkflows(): Promise<WorkflowRecord[]>;
  upsertIncident(incident: Incident, links: IncidentLink[]): Promise<Incident>;
  listIncidents(): Promise<Incident[]>;
  upsertSymptoms(symptoms: SymptomRecord[]): Promise<void>;
  submitPlan(plan: PlanCandidate): Promise<void>;
  publishAgentEvent(ev: AgentEventInput): Promise<void>;
  onChange(cb: (change: DbChange) => void): Unsubscribe;
}

/** Gateway role (fan gateway, nvidia-smi collector). */
export interface GatewayApi {
  ingestObservations(batch: Array<TelemetryEvent | SignalEvent>): Promise<void>;
}

/** Admin role (presenter laptop, evaluation harness). */
export interface AdminApi {
  createRun(runId: string, seed: number, presetId: string): Promise<void>;
  configureRun(runId: string, config: RunConfig): Promise<void>;
  pauseRun(runId: string, paused: boolean): Promise<void>;
  injectFault(fault: FaultInjection): Promise<void>;
  publishEvaluationResult(result: EvaluationResult): Promise<void>;
}

/**
 * Public subscriptions for the dashboard. Each callback fires immediately with the current
 * full list, then again with the full list after every change (easy to drop into React state).
 */
export interface SubscriptionApi {
  onGpu(cb: (gpus: GpuCurrent[]) => void): Unsubscribe;
  onJobs(cb: (jobs: JobState[]) => void): Unsubscribe;
  onIncidents(cb: (incidents: Incident[]) => void): Unsubscribe;
  onActions(cb: (actions: ActionStatus[]) => void): Unsubscribe;
  onAgentEvents(cb: (events: AgentEventInput[]) => void): Unsubscribe;
  onEvaluation(cb: (results: EvaluationResult[]) => void): Unsubscribe;
}

export interface DbClient extends AgentApi, GatewayApi, AdminApi, SubscriptionApi {
  readonly mode: 'mock' | 'live';
  close(): void;
}

export interface ConnectOptions {
  /** e.g. `wss://maincloud.spacetimedb.com` (env STDB_URI / VITE_STDB_URI). */
  uri: string;
  /** Database name: `dcos-dev` | `dcos` | `dcos-eval` (env STDB_DB / VITE_STDB_DB). */
  db: string;
  /** Role token (admin / agent / gateway). Omit for read-only browser use. */
  token?: string;
  runId?: string;
}
