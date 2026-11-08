// Stable seams between the P3 orchestrator and everything it depends on.
//
// - DbPort       -> adapter over @dcos/db-client (P2) once it exists; FakeDb in tests.
// - PhysicsPort  -> adapter over @dcos/physics GPU functions (P1) once they exist; FakePhysics in tests.
// - LlmPort      -> NIM (OpenAI-compatible) client in src/llm.ts; FakeLlm in tests.
//
// Rule: every wire type that exists in @dcos/contracts is imported from there, never redeclared.
// Types below that are NOT in the wire schema are marked "local until @dcos/db-client exists"
// (or "@dcos/physics") and must be replaced by imports when those packages ship.

import type {
  ActionCommand,
  ActionStatus,
  Incident,
  IncidentLink,
  ObservedSnapshot,
  PlanCandidate,
  SafetyDecision,
  SignalEvent,
  TelemetryEvent,
} from '@dcos/contracts';

// ---------------------------------------------------------------------------
// Shared names (CONTRACTS §0.6, §0.7, §0.8)
// ---------------------------------------------------------------------------

/**
 * Policy interface shared by the evaluation harness and P3 (CONTRACTS §0.6, frozen).
 * `nemotronPolicy` (P3-9) implements this with no DB.
 */
export type Policy = (
  obs: ObservedSnapshot,
  ctx: { sim_time_ms: number },
) => Promise<ActionCommand[]> | ActionCommand[];

/**
 * Output of `simulatePlan` (CONTRACTS §0.6 comment, verbatim shape).
 * TODO(P1): replace with `import type { PlanMetrics } from '@dcos/physics'` once it is exported.
 */
export interface PlanMetrics {
  expected_completion_delay_sim_s: number;
  expected_lost_work_units: number;
  expected_gpu_busy_waste_s: number;
  failure_risk_estimate: number;
  violations: string[];
  assumptions: string[];
}

/** Frozen safety reason codes (CONTRACTS §0.7), used in SafetyDecision.violations. */
export const SAFETY_REASON_CODES = [
  'DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT',
  'DEST_POWER_HEADROOM_INSUFFICIENT',
  'DEST_GPU_UNHEALTHY',
  'DEST_GPU_BUSY',
  'DEST_GPU_LEASED',
  'DEST_GPU_COUNT_INSUFFICIENT',
  'DEST_NOT_COMPATIBLE',
  'CHECKPOINT_NOT_ACCESSIBLE',
  'NO_COMPLETED_CHECKPOINT',
  'JOB_NOT_PREEMPTIBLE',
  'CHECKPOINT_UNSUPPORTED',
  'STALE_DECISION_EPOCH',
  'STALE_RESOURCE_VERSION',
  'CONFLICTING_ACTION',
  'EVIDENCE_STALE',
  'UNSUPPORTED_OPERATION',
  'CORDON_IS_NOT_REPAIR',
  'REAL_GPU_NOT_ALLOCATABLE',
] as const;
export type SafetyReasonCode = (typeof SAFETY_REASON_CODES)[number];

/** DCGM `clocks_event_reasons` bits (CONTRACTS §0.11 #5). */
/** DCGM SW thermal slowdown: throttling because of temperature. */
export const CLOCKS_EVENT_SW_THERMAL = 0x20;
/** DCGM SW power cap: set when a power cap is active. */
export const CLOCKS_EVENT_SW_POWER_CAP = 0x04;

/** Convenience aliases over wire enums (derived, not duplicated). */
export type ActionOperation = ActionCommand['operation'];
export type ActionLifecycle = ActionStatus['status'];

// ---------------------------------------------------------------------------
// DB-side types — local until @dcos/db-client exists
// ---------------------------------------------------------------------------

/** F-NV1 stages (CONTRACTS §0.8 / LANE-P3 P3-6). Local until @dcos/db-client exists. */
export type AgentStage = 'triage' | 'diagnose' | 'plan' | 'safety' | 'execute' | 'replan' | 'verify';

/**
 * Workflow stage persisted by `updateWorkflow`. `idle` = created by first claim, `done` = closed.
 * Local until @dcos/db-client exists.
 */
export type WorkflowStage = 'idle' | AgentStage | 'escalated' | 'done';

/** One tool call shown in the F-NV1 feed (CONTRACTS §0.8 `tool_calls_json` item). Local until @dcos/db-client exists. */
export interface ToolCallSummary {
  tool: string;
  args_summary: string;
  result_summary: string;
}

/**
 * Input to `publishAgentEvent` — the `agent_event` row (CONTRACTS §B) plus §0.8 `tool_calls_json`.
 * The adapter serializes `evidence_ids` -> `evidence_ids_json` and `tool_calls` -> `tool_calls_json`.
 * Never contains raw chain-of-thought or secrets. Local until @dcos/db-client exists.
 */
export interface AgentEventInput {
  agent_event_id: string;
  run_id: string;
  workflow_id: string | null;
  incident_id: string | null;
  stage: AgentStage;
  summary: string;
  evidence_ids: string[];
  tool_calls: ToolCallSummary[];
  sim_time_ms: number;
  observed_unix_ms: number;
}

/** `symptom` row (CONTRACTS §B). Local until @dcos/db-client exists. */
export interface SymptomRecord {
  symptom_id: string;
  run_id: string;
  resource_id: string;
  first_seen_sim_ms: number;
  last_seen_sim_ms: number;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  evidence_event_ids: string[];
  status: string;
}

/**
 * Bounded evidence bundle returned by `getEvidence` (feeds the `get_incident_evidence` tool).
 * Never includes `fault_injection_truth` or any private field. Local until @dcos/db-client exists.
 */
export interface Evidence {
  run_id: string;
  /** Incidents asked for; empty = run-wide recent evidence (used by triage before incidents exist). */
  incident_ids: string[];
  window_sim_ms: number;
  /** Window is [as_of_sim_time_ms - window_sim_ms, as_of_sim_time_ms]. */
  as_of_sim_time_ms: number;
  incidents: Incident[];
  links: IncidentLink[];
  symptoms: SymptomRecord[];
  signals: SignalEvent[];
  telemetry: TelemetryEvent[];
}

/** `workflow` row (CONTRACTS §B) + its `workflow_incident` ids. Local until @dcos/db-client exists. */
export interface WorkflowRecord {
  workflow_id: string;
  run_id: string;
  stage: WorkflowStage;
  state: Record<string, unknown>;
  incident_ids: string[];
  plan_id: string | null;
  current_command_key: string | null;
  last_processed_event_seq: number;
  attempt: number;
  lease_owner: string | null;
  lease_expires_unix_ms: number;
  fencing_token: bigint;
  updated_at_unix_ms: number;
  version: number;
}

/** Result of `claimWorkflow` / `heartbeatWorkflow`. Local until @dcos/db-client exists. */
export interface WorkflowLease {
  workflow: WorkflowRecord;
  fencing_token: bigint;
  lease_expires_unix_ms: number;
}

/**
 * Change notification from the DB subscription (`onChange`). Local until @dcos/db-client exists.
 * Replan (P3-7) watches `decision_epoch` and `resource_version`; triage watches `signal`;
 * the coordinator may watch `action_status` instead of polling.
 */
export type DbChange =
  | { kind: 'decision_epoch'; decision_epoch: number; sim_time_ms: number }
  | { kind: 'resource_version'; resource_id: string; version: number; sim_time_ms: number }
  | { kind: 'signal'; signal: SignalEvent }
  | { kind: 'action_status'; status: ActionStatus };

/** Error codes a DbPort implementation throws (as DbError). Local until @dcos/db-client exists. */
export type DbErrorCode =
  | 'COMMAND_KEY_COLLISION' // same command_key, different payload hash
  | 'SAFETY_REJECTED' // legacy/unused since §0.11 #3: a safety deny is RETURNED as a failed ActionStatus, not thrown
  | 'VERSION_CONFLICT' // CAS expected_version mismatch
  | 'STALE_FENCING_TOKEN' // token older than the current lease
  | 'LEASE_HELD' // another worker holds an unexpired workflow lease
  | 'LEASE_EXPIRED' // caller's workflow lease has expired
  | 'INVALID_TRANSITION' // lifecycle step not allowed from the current status
  | 'NOT_FOUND'
  | 'INVALID_PAYLOAD'; // failed validatePayload

export class DbError extends Error {
  readonly code: DbErrorCode;
  readonly violations: string[];
  constructor(code: DbErrorCode, message: string, violations: string[] = []) {
    super(`${code}: ${message}`);
    this.name = 'DbError';
    this.code = code;
    this.violations = violations;
  }
}

/**
 * True when `requestAction` (or a later read-back) shows a safety rejection (CONTRACTS §0.11 #3):
 * `status: "failed"` with `reason_code: "SAFETY_REJECTED"`. Violations are in `status.result.violations`.
 */
export const isSafetyRejected = (status: ActionStatus): boolean =>
  status.status === 'failed' && status.reason_code === 'SAFETY_REJECTED';

export const isDbError = (e: unknown, code?: DbErrorCode): e is DbError =>
  e instanceof DbError && (code === undefined || e.code === code);

// ---------------------------------------------------------------------------
// DbPort — the agent-facing @dcos/db-client wrapper names (CONTRACTS §0.6, frozen)
// ---------------------------------------------------------------------------

/**
 * Everything the agent reads from / writes to SpacetimeDB. Only P2's reducers mutate state;
 * this port never exposes private tables. All writes are idempotent or CAS-guarded.
 */
export interface DbPort {
  /** Planner-visible snapshot (no private fault truth). */
  getObservedSnapshot(): Promise<ObservedSnapshot>;

  /** Bounded evidence for incidents over the last `windowSimMs`; `[]` = run-wide recent evidence. */
  getEvidence(incidentIds: string[], windowSimMs: number): Promise<Evidence>;

  /** Ledger read-back by logical key; `null` if no action with that key exists. */
  getActionStatus(commandKey: string): Promise<ActionStatus | null>;

  /**
   * `request_action`: DB re-runs safety and epoch/version checks. Idempotent by `command_key`:
   * a retry with the same payload returns the persisted record; a different payload under the same
   * key throws DbError('COMMAND_KEY_COLLISION').
   *
   * CONTRACTS §0.11 #3: a safety deny (or stale decision epoch) does NOT throw. It persists the action
   * with `status: "failed"`, `reason_code: "SAFETY_REJECTED"`, `result.violations` = the §0.7 codes, appends
   * an action event, and RETURNS that ActionStatus (the UI shows it as BLOCKED). Test it with
   * `isSafetyRejected(status)`. Malformed payloads (INVALID_PAYLOAD), COMMAND_KEY_COLLISION, stale fencing
   * tokens and held leases still throw DbError and persist nothing.
   */
  requestAction(cmd: ActionCommand): Promise<ActionStatus>;

  /** `claim_action`: CAS on action version; acquires resource reservations; returns the fencing token. */
  claimAction(
    commandKey: string,
    expectedVersion: number,
    workerId: string,
  ): Promise<{ status: ActionStatus; fencing_token: bigint }>;

  /** `start_action`: claimed -> running (completion happens later in the DB tick). */
  startAction(commandKey: string, fencingToken: bigint): Promise<ActionStatus>;

  /** `cancel_action`: only safe-to-cancel actions (requested/claimed); `reasonCode` is recorded. */
  cancelAction(commandKey: string, reasonCode: string, fencingToken: bigint): Promise<ActionStatus>;

  /** `verify_action`: attach verifier evidence to a succeeded action. */
  verifyAction(commandKey: string, evidence: Record<string, unknown>): Promise<ActionStatus>;

  /**
   * `claim_workflow`: CAS-claim the coordinator lease. A missing workflow is created when
   * `expectedVersion` is 0. Throws LEASE_HELD if another worker's lease is unexpired.
   */
  claimWorkflow(
    workflowId: string,
    workerId: string,
    expectedVersion: number,
    leaseMs: number,
  ): Promise<WorkflowLease>;

  /** `heartbeat_workflow`: extend the lease; does not change `version`. */
  heartbeatWorkflow(
    workflowId: string,
    workerId: string,
    fencingToken: bigint,
    leaseMs: number,
  ): Promise<WorkflowLease>;

  /** `update_workflow`: CAS on version + fencing token; persists stage + state; returns the new record. */
  updateWorkflow(
    workflowId: string,
    expectedVersion: number,
    fencingToken: bigint,
    stage: WorkflowStage,
    state: Record<string, unknown>,
  ): Promise<WorkflowRecord>;

  getWorkflow(workflowId: string): Promise<WorkflowRecord | null>;

  /** Workflows whose stage is not `done` (used on boot by resume, P3-8). */
  listOpenWorkflows(): Promise<WorkflowRecord[]>;

  /** `upsert_incident`: insert or update the incident and merge its links. */
  upsertIncident(incident: Incident, links: IncidentLink[]): Promise<Incident>;

  listIncidents(): Promise<Incident[]>;

  /**
   * `upsert_symptoms` (CONTRACTS §0.11 #10): idempotent by `symptom_id`. A repeat call for an existing id
   * updates `last_seen_sim_ms` / `status` (and other mutable fields); `first_seen_sim_ms` is preserved.
   * Triage writes symptoms before linking them to an incident.
   */
  upsertSymptoms(symptoms: SymptomRecord[]): Promise<void>;

  /** `submit_plan`: persists a proposal only; never executes. */
  submitPlan(plan: PlanCandidate): Promise<void>;

  /** `publish_agent_event`: F-NV1 feed row. */
  publishAgentEvent(ev: AgentEventInput): Promise<void>;

  /** Subscribe to epoch / resource-version / signal / action-status changes. Returns unsubscribe. */
  onChange(cb: (change: DbChange) => void): () => void;
}

// ---------------------------------------------------------------------------
// PhysicsPort — @dcos/physics GPU functions (CONTRACTS §0.6, frozen; pure + deterministic)
// ---------------------------------------------------------------------------

export interface PhysicsPort {
  /** Counterfactual score of a plan on a snapshot clone (default horizon 600 sim-s). */
  simulatePlan(
    obs: ObservedSnapshot,
    plan: { commands: ActionCommand[] },
    opts?: { horizon_s?: number; seed?: number },
  ): PlanMetrics;

  /** Hard safety check for one command (§0.7 reason codes in `violations`). */
  evaluateSafety(
    obs: ObservedSnapshot,
    cmd: ActionCommand,
    ctx: { decision_epoch: number; leased_resource_ids: string[] },
  ): SafetyDecision;

  /** Deterministic fallback when the LLM is unavailable (used with `needs_approval`). */
  thresholdPolicy(obs: ObservedSnapshot): ActionCommand[];
}

// ---------------------------------------------------------------------------
// LlmPort — OpenAI-compatible chat with tools (NIM primary -> fallback lives in the adapter)
// ---------------------------------------------------------------------------

export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw JSON string from the model; callers MUST validate before use. */
  argumentsJson: string;
}

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface LlmToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export type LlmToolChoice = 'auto' | 'none' | 'required' | { name: string };

export interface LlmChatRequest {
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  toolChoice?: LlmToolChoice;
  /** Defaults to LLM_MAX_TOKENS in the adapter. */
  maxTokens?: number;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmChatResponse {
  content: string | null;
  toolCalls: LlmToolCall[];
  /** Model ID that actually answered (primary or fallback). */
  model: string;
  finishReason?: string;
  usage?: LlmUsage;
}

export interface LlmPort {
  chat(req: LlmChatRequest): Promise<LlmChatResponse>;
}
