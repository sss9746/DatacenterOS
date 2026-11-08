// DB-side types for @dcos/db-client. These are NOT wire types (those come from @dcos/contracts).
// Shapes match apps/agent/src/ports.ts on lane/p3-agent (CONTRACTS §0.11 #7, #10, #14, #15),
// so P3 can replace its local copies with `import type { … } from '@dcos/db-client'`.

import type {
  ActionCommand,
  ActionStatus,
  Incident,
  IncidentLink,
  SafetyDecision,
  SignalEvent,
  TelemetryEvent,
} from '@dcos/contracts';

/** F-NV1 stages (CONTRACTS §0.8). */
export type AgentStage = 'triage' | 'diagnose' | 'plan' | 'safety' | 'execute' | 'replan' | 'verify';

/** Workflow stage persisted by `updateWorkflow`. `idle` = created by first claim, `done` = closed. */
export type WorkflowStage = 'idle' | AgentStage | 'escalated' | 'done';

/** F-NV1 actor tag: `nemotron` = LLM step, `code` = deterministic code. */
export type AgentActor = 'nemotron' | 'code';

/** One tool call in the F-NV1 feed (`agent_event.tool_calls_json` item). */
export interface ToolCallSummary {
  tool: string;
  args_summary: string;
  result_summary: string;
  actor?: AgentActor;
}

/** `agent_event` row as written by `publishAgentEvent` and read by `onAgentEvents`. Never raw chain-of-thought. */
export interface AgentEventInput {
  agent_event_id: string;
  run_id: string;
  workflow_id: string | null;
  incident_id: string | null;
  stage: AgentStage;
  summary: string;
  evidence_ids: string[];
  tool_calls: ToolCallSummary[];
  actor?: AgentActor;
  sim_time_ms: number;
  observed_unix_ms: number;
}

/** `symptom` row (CONTRACTS §B). */
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

/** Bounded evidence bundle from `getEvidence`. Never contains private fault truth. */
export interface Evidence {
  run_id: string;
  /** Incidents asked for; empty = run-wide evidence (CONTRACTS §0.11 #6). */
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

/** `workflow` row + its `workflow_incident` ids. */
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

/** Result of `claimWorkflow` / `heartbeatWorkflow`. */
export interface WorkflowLease {
  workflow: WorkflowRecord;
  fencing_token: bigint;
  lease_expires_unix_ms: number;
}

/** Change notification from `onChange` (CONTRACTS §0.11 #15). */
export type DbChange =
  | { kind: 'decision_epoch'; decision_epoch: number; sim_time_ms: number }
  | { kind: 'resource_version'; resource_id: string; version: number; sim_time_ms: number }
  | { kind: 'signal'; signal: SignalEvent }
  | { kind: 'action_status'; status: ActionStatus };

// ---------------------------------------------------------------------------
// Action details (P4 handoff #4): a read-only public projection of the ledger.
// Live: `action` row (stored command + safety in result_json) + `action_event` rows. No new tables.
// ---------------------------------------------------------------------------

/** A safety check recorded on the action. `evidence` is evaluateSafety's own (actual vs required headroom etc.). */
export interface ActionSafety {
  decision: SafetyDecision['decision'];
  violations: string[];
  /** null when the check did not record it (start-time recheck). */
  checked_decision_epoch: number | null;
  evidence: Record<string, unknown>;
}

/** One status transition (live `action_event`), oldest first. */
export interface ActionHistoryEntry {
  status: ActionStatus['status'];
  /** Action version after this transition. */
  version: number;
  sim_time_ms: number;
  observed_unix_ms: number;
  reason_code: string | null;
  /** Transition-specific detail, e.g. `{ safety }`, `{ outcome }`, `{ verification }`. */
  detail: Record<string, unknown>;
}

/** Everything the ledger UI shows about one action. */
export interface ActionDetail {
  /** Same object `onActions` returns for this action. */
  status: ActionStatus;
  /** The command as requested: operation, target, job, arguments, dependencies, incidents, expected versions. */
  command: ActionCommand;
  claimed_by: string | null;
  due_sim_time_ms: number | null;
  /** Safety decision at request time. null only in the mock when no `evaluateSafety` is plugged in and nothing was violated. */
  safety: ActionSafety | null;
  /** Safety recheck at start time, present only when it rejected the start. */
  start_safety: ActionSafety | null;
  history: ActionHistoryEntry[];
}

/** Run configuration accepted by `configureRun` (P2-4 speed; P2-9 fan rule). */
export interface RunConfig {
  speed?: number;
  fan_drives_loop_a?: boolean;
}

// ---------------------------------------------------------------------------
// Errors (CONTRACTS §0.11 #14): recognise by `code`, never by class.
// ---------------------------------------------------------------------------

export const DB_ERROR_CODES = [
  'COMMAND_KEY_COLLISION',
  'VERSION_CONFLICT',
  'STALE_FENCING_TOKEN',
  'LEASE_HELD',
  'LEASE_EXPIRED',
  'INVALID_TRANSITION',
  'NOT_FOUND',
  'INVALID_PAYLOAD',
  'UNAUTHORIZED',
  /** Legacy, unused since §0.11 #3: a safety deny is RETURNED as a failed ActionStatus. */
  'SAFETY_REJECTED',
] as const;
export type DbErrorCode = (typeof DB_ERROR_CODES)[number];

const CODE_SET: ReadonlySet<string> = new Set(DB_ERROR_CODES);

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

/** True for any error carrying a DbErrorCode (optionally a specific one). Works across package copies. */
export function isDbError(e: unknown, code?: DbErrorCode): e is DbError {
  if (typeof e !== 'object' || e === null) return false;
  const c = (e as { code?: unknown }).code;
  return typeof c === 'string' && CODE_SET.has(c) && (code === undefined || c === code);
}

/** Turns a reducer error string like `"LEASE_HELD: …"` into a DbError; other errors pass through. */
export function parseDbError(e: unknown): unknown {
  if (isDbError(e)) return e;
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  // Optional "XxxError: " prefix, same convention as P3's dbErrorCode (§0.11 #14).
  const m = /^\s*(?:[A-Za-z]*Error:\s*)?([A-Z][A-Z_]+):\s*(.*)$/s.exec(msg);
  if (m && CODE_SET.has(m[1]!)) return new DbError(m[1] as DbErrorCode, m[2] ?? '');
  return e;
}

/** CONTRACTS §0.11 #3: a safety deny is persisted as failed + SAFETY_REJECTED and returned, not thrown. */
export const isSafetyRejected = (status: ActionStatus): boolean =>
  status.status === 'failed' && status.reason_code === 'SAFETY_REJECTED';
