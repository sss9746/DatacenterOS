// simulate_plan, propose_plan, get_action_status. None of these executes anything.

import { createHash } from 'node:crypto';
import { validatePayload, type ActionCommand, type PlanCandidate } from '@dcos/contracts';
import { z } from 'zod';
import { isDbError } from '../ports.js';
import { CommandBuildError, buildCommand, type ActionOperation } from './command.js';
import { indexSnapshot } from './snapshot-index.js';
import { ToolError, clipSummary, type ToolSpec } from './types.js';

const OPERATIONS = [
  'keep_running',
  'power_cap',
  'checkpoint',
  'pause_job',
  'cordon_gpu',
  'migrate_restart',
  'uncordon_gpu',
  'escalate',
] as const satisfies readonly ActionOperation[];

// ------------------------------------------------------------------ simulate_plan

const commandSchema = z.object({
  operation: z.enum(OPERATIONS).describe('Action operation.'),
  target_resource_id: z.string().min(1).describe('Job ID for job-level operations, GPU ID for cordon/uncordon.'),
  job_id: z.string().min(1).nullable().optional().describe('Job this command acts on (null/omitted for pure GPU actions).'),
  arguments: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'checkpoint/pause_job/cordon_gpu/uncordon_gpu/keep_running: {}. migrate_restart: {destination_gpu_ids: string[]}. power_cap: {power_limit_w: number}. escalate: {reason: string}.',
    ),
  depends_on_command_keys: z.array(z.string()).optional().describe('Command keys that must finish first (e.g. checkpoint before move).'),
});

const simulateSchema = z.object({
  commands: z.array(commandSchema).min(1).max(10).describe('Ordered commands of the candidate plan. Envelope fields are filled in for you.'),
});

const rackShort = (gpuId: string, ix: ReturnType<typeof indexSnapshot>): string => {
  const node = ix.gpu.get(gpuId)?.node_id;
  return (node && ix.node.get(node)?.rack_id.replace('rack-', '')) || gpuId;
};

const LABELS: Partial<Record<ActionOperation, string>> = {
  checkpoint: 'ckpt',
  power_cap: 'cap',
  pause_job: 'pause',
  keep_running: 'keep',
  cordon_gpu: 'cordon',
  uncordon_gpu: 'uncordon',
  escalate: 'escalate',
};

function planLabel(cmds: ActionCommand[], ix: ReturnType<typeof indexSnapshot>): string {
  const subject = cmds.find((c) => c.job_id)?.job_id ?? cmds[0]!.target_resource_id;
  const steps = cmds.map((c) => {
    if (c.operation !== 'migrate_restart') return LABELS[c.operation] ?? c.operation;
    const racks = [...new Set(((c.arguments.destination_gpu_ids as string[]) ?? []).map((g) => rackShort(g, ix)))];
    return `move→${racks.join('+')}`;
  });
  return `${subject} ${steps.join('+')}`;
}

export const simulatePlanTool: ToolSpec<z.infer<typeof simulateSchema>> = {
  name: 'simulate_plan',
  description:
    'Counterfactually score a candidate plan (ordered commands) on a fresh snapshot with the deterministic physics engine. Returns expected completion delay, ' +
    'expected lost work, GPU-busy waste, failure risk, constraint violations and assumptions. Does not execute anything.',
  schema: simulateSchema,
  async run(args, { db, physics, runId, workflowId }) {
    const snap = await db.getObservedSnapshot();
    const ix = indexSnapshot(snap);
    const ordinals = new Map<string, number>();
    const commands: ActionCommand[] = args.commands.map((c) => {
      const subject = c.job_id ?? c.target_resource_id;
      const k = `${c.operation}|${subject}`;
      const n = (ordinals.get(k) ?? 0) + 1;
      ordinals.set(k, n);
      try {
        return buildCommand(
          { ...c, job_id: c.job_id ?? (ix.jobSpec.has(c.target_resource_id) ? c.target_resource_id : null) },
          snap,
          { runId, workflowId, n },
        );
      } catch (e) {
        if (e instanceof CommandBuildError) throw new ToolError(`command ${c.operation}/${subject}: ${e.message}`);
        throw e;
      }
    });
    const metrics = physics.simulatePlan(snap, { commands });
    const summary = clipSummary(
      `simulate_plan(${planLabel(commands, ix)}): lost ${Math.round(metrics.expected_lost_work_units)} wu, ` +
        `delay ${Math.round(metrics.expected_completion_delay_sim_s)} s` +
        (metrics.violations.length > 0 ? `, violations: ${metrics.violations.join(',')}` : ''),
    );
    return {
      data: {
        metrics,
        decision_epoch: snap.clock.decision_epoch,
        commands: commands.map((c) => ({
          command_key: c.command_key,
          operation: c.operation,
          target_resource_id: c.target_resource_id,
          job_id: c.job_id,
        })),
      },
      summary,
    };
  },
};

// ------------------------------------------------------------------ propose_plan

const proposeSchema = z.object({
  plan_id: z.string().min(1).optional().describe('Optional; derived deterministically from the command keys when omitted.'),
  incident_ids: z.array(z.string().min(1)).min(1).describe('Incidents this plan addresses.'),
  based_on_decision_epoch: z.number().int().nonnegative().optional().describe('Decision epoch the plan was simulated on (default: current).'),
  assumptions: z.array(z.string()).max(50).describe('Assumptions the plan relies on.'),
  command_keys: z.array(z.string().min(1)).min(1).describe('Command keys, in order, as returned by simulate_plan.'),
  expected_completion_delay_sim_s: z.number(),
  expected_lost_work_units: z.number(),
  expected_gpu_busy_waste_s: z.number(),
  failure_risk_estimate: z.number().min(0).max(1),
  explanation: z.string().min(1).max(2000).describe('Short evidence-cited rationale (no chain-of-thought).'),
});

export const proposePlanTool: ToolSpec<z.infer<typeof proposeSchema>> = {
  name: 'propose_plan',
  description:
    'Persist a plan PROPOSAL (command keys, metrics from simulate_plan, assumptions, explanation). This never executes anything: ' +
    'the coordinator re-validates safety and requests actions separately. Rejected if based_on_decision_epoch is stale.',
  schema: proposeSchema,
  async run(args, { db, runId, workflowId }) {
    const snap = await db.getObservedSnapshot();
    const epoch = args.based_on_decision_epoch ?? snap.clock.decision_epoch;
    if (epoch !== snap.clock.decision_epoch) {
      throw new ToolError(`STALE_DECISION_EPOCH: plan based on ${epoch}, current is ${snap.clock.decision_epoch}; re-simulate`);
    }
    const derivedId = `plan-${workflowId}-${createHash('sha256').update(args.command_keys.join('|')).digest('hex').slice(0, 8)}`;
    const plan: PlanCandidate = {
      schema_version: '1.1.0',
      plan_id: args.plan_id ?? derivedId,
      run_id: runId,
      workflow_id: workflowId,
      incident_ids: args.incident_ids as [string, ...string[]],
      based_on_decision_epoch: epoch,
      assumptions: args.assumptions,
      command_keys: args.command_keys as [string, ...string[]],
      expected_completion_delay_sim_s: args.expected_completion_delay_sim_s,
      expected_lost_work_units: args.expected_lost_work_units,
      expected_gpu_busy_waste_s: args.expected_gpu_busy_waste_s,
      failure_risk_estimate: args.failure_risk_estimate,
      explanation: args.explanation,
    };
    const v = validatePayload('PlanCandidate', plan);
    if (!v.ok) throw new ToolError(`invalid plan: ${v.errors.join('; ')}`);
    try {
      await db.submitPlan(plan);
    } catch (e) {
      if (isDbError(e)) throw new ToolError(e.message);
      throw e;
    }
    return {
      data: { plan_id: plan.plan_id, status: 'proposed', based_on_decision_epoch: epoch },
      summary: clipSummary(
        `propose_plan(${plan.plan_id}): ${plan.command_keys.length} commands, delay ${Math.round(plan.expected_completion_delay_sim_s)} s, ` +
          `lost ${Math.round(plan.expected_lost_work_units)} wu (proposal only)`,
      ),
    };
  },
};

// ------------------------------------------------------------------ get_action_status

const statusSchema = z.object({ command_key: z.string().min(1).describe('Command key of the action.') });

export const getActionStatusTool: ToolSpec<z.infer<typeof statusSchema>> = {
  name: 'get_action_status',
  description: 'Read the ledger status of an action by command_key (requested, claimed, running, succeeded, failed, cancelled), or found:false if unknown. Read-only.',
  schema: statusSchema,
  async run(args, { db }) {
    const st = await db.getActionStatus(args.command_key);
    if (!st) return { data: { found: false, command_key: args.command_key }, summary: clipSummary(`get_action_status(${args.command_key}): not found`) };
    return {
      data: { found: true, status: st },
      summary: clipSummary(`get_action_status(${args.command_key}): ${st.status}${st.reason_code ? ` (${st.reason_code})` : ''}`),
    };
  },
};
