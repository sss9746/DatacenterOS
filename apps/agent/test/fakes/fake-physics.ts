// ###########################################################################
//  TEST-ONLY  TEST-ONLY  TEST-ONLY  TEST-ONLY  TEST-ONLY  TEST-ONLY  TEST-ONLY
//
//  FakePhysics is a deterministic TOY scorer for agent unit tests. It is NOT
//  the simulator and its numbers mean nothing. Production code must use the
//  real @dcos/physics simulatePlan / evaluateSafety / thresholdPolicy (P1)
//  through the PhysicsPort adapter. Never import this from apps/agent/src/**.
//
//  Toy rules (just enough to drive planner/safety tests):
//    - a job on a GPU >= 85 C or a degraded cooling loop has p_fail 0.5 over
//      the horizon; elsewhere 0.02
//    - expected lost work = p_fail * (progress - durable + rate*gpus*horizon/2)
//    - checkpoint: durable := progress, +checkpoint_duration delay
//    - migrate_restart to cool GPUs: p_fail 0.02, +restart delay, GPU-busy
//      waste = gpus * restart_s; without a checkpoint it loses progress-durable
//    - power_cap: p_fail * 0.5, 15% slowdown; pause_job: p_fail 0, full delay
//    - evaluateSafety enforces a subset of CONTRACTS §0.7 codes
//
// ###########################################################################

import type { ActionCommand, JobSpec, JobState, ObservedSnapshot, SafetyDecision } from '@dcos/contracts';
import type { PhysicsPort, PlanMetrics } from '../../src/ports.js';

export const FAKE_PHYSICS_BANNER = 'TEST-ONLY FakePhysics toy model (not @dcos/physics)';
export const FAKE_REQUIRED_HEADROOM_C = 7;
const THROTTLE_C = 85;
const HOT_P_FAIL = 0.5;
const COOL_P_FAIL = 0.02;
const DEFAULT_HORIZON_S = 600;

const destGpuIds = (cmd: ActionCommand): string[] => {
  const d = cmd.arguments.destination_gpu_ids;
  return Array.isArray(d) ? d.filter((x): x is string => typeof x === 'string') : [];
};

/**
 * Frozen `ActionCommand.arguments` shapes per operation (CONTRACTS §0.11 #1). Returns true when `args`
 * has exactly the keys of the operation's shape with the right types.
 */
export function hasValidArguments(cmd: ActionCommand): boolean {
  const a = cmd.arguments as Record<string, unknown>;
  const keys = Object.keys(a);
  const only = (...want: string[]) => keys.length === want.length && want.every((k) => k in a);
  switch (cmd.operation) {
    case 'migrate_restart':
      return only('destination_gpu_ids') && Array.isArray(a.destination_gpu_ids) && a.destination_gpu_ids.every((x) => typeof x === 'string');
    case 'power_cap':
      return only('power_limit_w') && typeof a.power_limit_w === 'number' && Number.isFinite(a.power_limit_w) && a.power_limit_w > 0;
    case 'escalate':
      return only('reason') && typeof a.reason === 'string';
    default: // checkpoint, pause_job, cordon_gpu, uncordon_gpu, keep_running take {}
      return keys.length === 0;
  }
}

interface JobSim {
  spec: JobSpec;
  state: JobState;
  pFail: number;
  slowdown: number;
  durable: number;
  delayS: number;
  wasteS: number;
  extraLost: number;
}

export class FakePhysics implements PhysicsPort {
  readonly calls: { method: string; args: unknown[] }[] = [];

  private gpuIsHot(obs: ObservedSnapshot, gpuId: string): boolean {
    const g = obs.gpus.find((x) => x.resource_id === gpuId);
    if (!g) return false;
    if (g.temp_c >= THROTTLE_C) return true;
    const rackId = obs.nodes.find((n) => n.resource_id === g.node_id)?.rack_id;
    const loop = obs.dependencies.find((e) => e.consumer_id === rackId && e.relation === 'cooled_by')?.provider_id;
    const c = obs.cooling.find((x) => x.resource_id === loop);
    return c !== undefined && c.operating_state !== 'normal';
  }

  simulatePlan(obs: ObservedSnapshot, plan: { commands: ActionCommand[] }, opts?: { horizon_s?: number; seed?: number }): PlanMetrics {
    this.calls.push({ method: 'simulatePlan', args: [plan, opts] });
    const horizon = opts?.horizon_s ?? DEFAULT_HORIZON_S;
    const jobs = new Map<string, JobSim>();
    for (const state of obs.job_states) {
      const spec = obs.job_specs.find((s) => s.job_id === state.job_id);
      if (!spec || state.status === 'completed') continue;
      const hot = state.allocated_gpu_ids.some((g) => this.gpuIsHot(obs, g));
      const throttled = state.allocated_gpu_ids.some((g) => (obs.gpus.find((x) => x.resource_id === g)?.temp_c ?? 0) >= THROTTLE_C);
      jobs.set(state.job_id, {
        spec,
        state,
        pFail: hot ? HOT_P_FAIL : COOL_P_FAIL,
        slowdown: throttled ? 0.3 : 0,
        durable: state.durable_work_units,
        delayS: 0,
        wasteS: 0,
        extraLost: 0,
      });
    }
    const violations: string[] = [];
    for (const cmd of plan.commands) {
      const d = this.evaluateSafety(obs, cmd, { decision_epoch: cmd.expected_decision_epoch, leased_resource_ids: [] });
      if (d.decision === 'deny') violations.push(...d.violations);
      const j = cmd.job_id ? jobs.get(cmd.job_id) : undefined;
      if (!j) continue;
      switch (cmd.operation) {
        case 'checkpoint':
          j.durable = j.state.progress_work_units;
          j.delayS += j.spec.checkpoint_duration_ms / 1000;
          break;
        case 'migrate_restart': {
          const destHot = destGpuIds(cmd).some((g) => this.gpuIsHot(obs, g));
          j.extraLost += j.state.progress_work_units - j.durable; // restart from the last durable state
          j.durable = j.state.progress_work_units;
          j.pFail = destHot ? HOT_P_FAIL : COOL_P_FAIL;
          j.slowdown = 0;
          j.delayS += j.spec.restart_duration_ms / 1000;
          j.wasteS += j.spec.gpus_required * (j.spec.restart_duration_ms / 1000);
          break;
        }
        case 'power_cap':
          j.pFail *= 0.5;
          j.slowdown = 0.15;
          break;
        case 'pause_job':
          j.pFail = 0;
          j.delayS += horizon;
          break;
        default:
          break;
      }
    }
    let lost = 0;
    let delay = 0;
    let waste = 0;
    let risk = 0;
    for (const j of jobs.values()) {
      const atRisk = j.state.progress_work_units - j.durable + j.spec.work_rate_per_gpu_per_sim_s * j.spec.gpus_required * (horizon / 2);
      lost += j.extraLost + j.pFail * atRisk;
      delay += j.delayS + j.slowdown * horizon;
      waste += j.wasteS;
      risk = Math.max(risk, j.pFail);
    }
    const r = (n: number) => Math.round(n * 1000) / 1000;
    return {
      expected_completion_delay_sim_s: r(delay),
      expected_lost_work_units: r(lost),
      expected_gpu_busy_waste_s: r(waste),
      failure_risk_estimate: r(risk),
      violations: [...new Set(violations)],
      assumptions: [FAKE_PHYSICS_BANNER, `horizon_s=${horizon}`],
    };
  }

  evaluateSafety(obs: ObservedSnapshot, cmd: ActionCommand, ctx: { decision_epoch: number; leased_resource_ids: string[] }): SafetyDecision {
    this.calls.push({ method: 'evaluateSafety', args: [cmd, ctx] });
    const v = new Set<string>();
    const checked = new Set<string>([cmd.target_resource_id]);
    if (cmd.job_id) checked.add(cmd.job_id);
    const evidence: Record<string, unknown> = { model: FAKE_PHYSICS_BANNER };

    if (cmd.expected_decision_epoch !== ctx.decision_epoch || ctx.decision_epoch !== obs.clock.decision_epoch) {
      v.add('STALE_DECISION_EPOCH');
    }
    const versions = new Map<string, number>();
    for (const g of obs.gpus) versions.set(g.resource_id, g.version);
    for (const n of obs.nodes) versions.set(n.resource_id, n.version);
    for (const c of obs.cooling) versions.set(c.resource_id, c.version);
    for (const j of obs.job_states) versions.set(j.job_id, j.version);
    for (const [id, expected] of Object.entries(cmd.expected_resource_versions)) {
      if (versions.get(id) !== expected) v.add('STALE_RESOURCE_VERSION');
    }

    if (!hasValidArguments(cmd)) v.add('UNSUPPORTED_OPERATION'); // wrong/missing arguments for the operation (§0.11 #1)

    const spec = cmd.job_id ? obs.job_specs.find((s) => s.job_id === cmd.job_id) : undefined;
    const state = cmd.job_id ? obs.job_states.find((s) => s.job_id === cmd.job_id) : undefined;

    if ((cmd.operation === 'migrate_restart' || cmd.operation === 'pause_job') && spec && !spec.preemptible) v.add('JOB_NOT_PREEMPTIBLE');
    if (cmd.operation === 'checkpoint' && spec && !spec.checkpoint_supported) v.add('CHECKPOINT_UNSUPPORTED');
    if (cmd.operation === 'uncordon_gpu') {
      const g = obs.gpus.find((x) => x.resource_id === cmd.target_resource_id);
      if (g && g.last_xid_code !== null) v.add('CORDON_IS_NOT_REPAIR');
    }

    if (cmd.operation === 'migrate_restart' && spec && state) {
      const dest = destGpuIds(cmd);
      if (dest.length < spec.gpus_required) v.add('DEST_GPU_COUNT_INSUFFICIENT');
      const hasCheckpoint = obs.checkpoints.some((c) => c.job_id === spec.job_id && c.status === 'complete' && c.accessible);
      if (!hasCheckpoint && cmd.depends_on_command_keys.length === 0) v.add('NO_COMPLETED_CHECKPOINT');
      const ownGpus = new Set(state.allocated_gpu_ids);
      const destNodes = new Set<string>();
      for (const id of dest) {
        checked.add(id);
        const res = obs.resources.find((r) => r.resource_id === id);
        const g = obs.gpus.find((x) => x.resource_id === id);
        if (res?.profile === 'brev_real') {
          v.add('REAL_GPU_NOT_ALLOCATABLE');
          continue;
        }
        if (!g || !res) {
          v.add('DEST_NOT_COMPATIBLE');
          continue;
        }
        destNodes.add(g.node_id);
        if (!spec.compatible_node_ids.includes(g.node_id)) v.add('DEST_NOT_COMPATIBLE');
        if (g.last_xid_code !== null || g.availability !== 'ready') v.add('DEST_GPU_UNHEALTHY');
        const busy = obs.allocations.some((a) => a.gpu_id === id && a.job_id !== spec.job_id);
        if (busy && !ownGpus.has(id)) v.add('DEST_GPU_BUSY');
        if (ctx.leased_resource_ids.includes(id)) v.add('DEST_GPU_LEASED');
      }
      const headroom: Record<string, number> = {};
      for (const nodeId of destNodes) {
        const n = obs.nodes.find((x) => x.resource_id === nodeId);
        if (!n) continue;
        checked.add(n.resource_id);
        checked.add(n.rack_id);
        headroom[n.rack_id] = n.thermal_headroom_c;
        if (n.thermal_headroom_c < FAKE_REQUIRED_HEADROOM_C) v.add('DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT');
      }
      evidence.required_headroom_c = FAKE_REQUIRED_HEADROOM_C;
      evidence.available_headroom_c = headroom;
    }

    const violations = [...v];
    const decision: SafetyDecision['decision'] =
      violations.length > 0 ? 'deny' : cmd.operation === 'escalate' ? 'needs_approval' : 'allow';
    return {
      schema_version: '1.1.0',
      run_id: obs.run_id,
      plan_id: cmd.plan_id,
      action_id: cmd.action_id,
      decision,
      checked_decision_epoch: ctx.decision_epoch,
      violations,
      checked_resource_ids: [...checked],
      evidence,
    };
  }

  /** Toy threshold baseline: power-cap every job with any GPU >= 85 C. */
  thresholdPolicy(obs: ObservedSnapshot): ActionCommand[] {
    this.calls.push({ method: 'thresholdPolicy', args: [] });
    const epoch = obs.clock.decision_epoch;
    return obs.job_states
      .filter((j) => j.allocated_gpu_ids.some((g) => (obs.gpus.find((x) => x.resource_id === g)?.temp_c ?? 0) >= THROTTLE_C))
      .map((j) => ({
        schema_version: '1.1.0' as const,
        run_id: obs.run_id,
        action_id: `act-threshold-${j.job_id}-${epoch}`,
        command_key: `threshold:${j.job_id}:power_cap:${epoch}`,
        workflow_id: 'wf-threshold',
        plan_id: 'plan-threshold',
        incident_ids: ['inc-threshold'] as [string],
        operation: 'power_cap' as const,
        target_resource_id: j.job_id,
        job_id: j.job_id,
        arguments: { power_limit_w: 500 },
        depends_on_command_keys: [],
        expected_decision_epoch: epoch,
        expected_resource_versions: { [j.job_id]: j.version },
        requested_sim_time_ms: obs.clock.sim_time_ms,
      }));
  }
}
