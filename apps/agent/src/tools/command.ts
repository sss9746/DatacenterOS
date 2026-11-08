// Deterministic command construction shared by simulate_plan and the planner (P3-4).
//
// command_key format (stable across retries, unique per logical step):
//   `${workflowId}:${operation}:${job_id ?? target_resource_id}:${n}`
// e.g. `wf-1:migrate_restart:job-a:1`. `n` is the 1-based ordinal of that (operation, subject) pair within
// the workflow; callers bump it only for a genuinely new step (a replan), never for a retry.
// action_id = `act:${command_key}`, so a retry of the same step produces the same ids.

import { validatePayload, type ActionCommand, type ObservedSnapshot } from '@dcos/contracts';
import { indexSnapshot, versionOf } from './snapshot-index.js';

export type ActionOperation = ActionCommand['operation'];

export interface PartialCommand {
  operation: ActionOperation;
  target_resource_id: string;
  job_id?: string | null;
  arguments?: Record<string, unknown>;
  depends_on_command_keys?: string[];
  /** Override the derived key (e.g. replay of a persisted command). */
  command_key?: string;
  incident_ids?: [string, ...string[]];
  plan_id?: string;
}

export interface CommandContext {
  runId: string;
  workflowId: string;
  /** Ordinal used in the derived command_key (default 1). */
  n?: number;
  /** Fallbacks when the partial has none. */
  incidentIds?: [string, ...string[]];
  planId?: string;
}

export const DEFAULT_INCIDENT_ID = 'incident-unassigned';

export const commandKey = (workflowId: string, operation: string, subject: string, n = 1): string =>
  `${workflowId}:${operation}:${subject}:${n}`;

export class CommandBuildError extends Error {}

/** Per-operation `arguments` shape check (CONTRACTS §0.11). Returns an error string or null. */
export function checkArguments(operation: ActionOperation, args: Record<string, unknown>): string | null {
  switch (operation) {
    case 'migrate_restart': {
      const d = args.destination_gpu_ids;
      return Array.isArray(d) && d.length > 0 && d.every((x) => typeof x === 'string' && x.length > 0)
        ? null
        : 'migrate_restart needs arguments.destination_gpu_ids: non-empty string[]';
    }
    case 'power_cap':
      return typeof args.power_limit_w === 'number' && args.power_limit_w > 0
        ? null
        : 'power_cap needs arguments.power_limit_w: positive number';
    case 'escalate':
      return typeof args.reason === 'string' && args.reason.length > 0 ? null : 'escalate needs arguments.reason: string';
    default:
      return null;
  }
}

/** Build a schema-valid ActionCommand from a partial. Throws CommandBuildError when it cannot. */
export function buildCommand(partial: PartialCommand, snapshot: ObservedSnapshot, ctx: CommandContext): ActionCommand {
  const args = partial.arguments ?? {};
  const argError = checkArguments(partial.operation, args);
  if (argError) throw new CommandBuildError(argError);

  const ix = indexSnapshot(snapshot);
  const jobId = partial.job_id ?? null;
  const subject = jobId ?? partial.target_resource_id;
  const key = partial.command_key ?? commandKey(ctx.workflowId, partial.operation, subject, ctx.n ?? 1);

  const versions: Record<string, number> = {};
  const dest = Array.isArray(args.destination_gpu_ids) ? (args.destination_gpu_ids as string[]) : [];
  for (const id of [partial.target_resource_id, ...(jobId ? [jobId] : []), ...dest]) {
    const v = versionOf(ix, id);
    if (v !== undefined) versions[id] = v;
  }

  const cmd: ActionCommand = {
    schema_version: '1.1.0',
    run_id: ctx.runId,
    action_id: `act:${key}`,
    command_key: key,
    workflow_id: ctx.workflowId,
    plan_id: partial.plan_id ?? ctx.planId ?? `plan-sim-${ctx.workflowId}`,
    incident_ids: partial.incident_ids ?? ctx.incidentIds ?? [DEFAULT_INCIDENT_ID],
    operation: partial.operation,
    target_resource_id: partial.target_resource_id,
    job_id: jobId,
    arguments: args,
    depends_on_command_keys: partial.depends_on_command_keys ?? [],
    expected_decision_epoch: snapshot.clock.decision_epoch,
    expected_resource_versions: versions,
    requested_sim_time_ms: snapshot.clock.sim_time_ms,
  };
  const v = validatePayload('ActionCommand', cmd);
  if (!v.ok) throw new CommandBuildError(`invalid command: ${v.errors.join('; ')}`);
  return cmd;
}
