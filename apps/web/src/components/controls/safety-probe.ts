import type { ActionCommand, ActionStatus, ObservedSnapshot } from '@dcos/contracts';
import type { ActionDetail, ActionSafety } from '@dcos/db-client';

/**
 * Presenter manual safety probe (IMPLEMENTATION-SCOPE §6 step 3): a manual `migrate_restart` of job-b onto hot rack r6
 * through the normal `requestAction` path, so the same `evaluateSafety` the agent faces decides it.
 *
 * job-b (gpu_demo_8 preset): 8 GPUs on node-r4-n1, same_node, preemptible, checkpointed (latest checkpoint complete),
 * priority 50 (< the 80 approval threshold). Every move precondition on the job itself is met, so a denial is about
 * the destination: r6 is fully allocated to job-c (DEST_GPU_BUSY) and runs a +12 °C inlet offset (thermal headroom).
 * Arguments use the standard form `{ destination_gpu_ids }` (packages/physics/src/gpu/args.ts), as the planner sends.
 */
export const PROBE_JOB_ID = 'job-b';
export const PROBE_RACK_ID = 'rack-r6';
const NON_TERMINAL: ReadonlySet<ActionStatus['status']> = new Set(['requested', 'claimed', 'running', 'needs_reconciliation']);

export interface ProbeIds { commandKey: string; actionId: string; workflowId: string; planId: string; incidentId: string }

export function probeIds(uuid: string): ProbeIds {
  return {
    commandKey: `probe-r6-${uuid}`, actionId: `probe-r6-${uuid}`, workflowId: `presenter-probe-${uuid}`,
    planId: `plan-presenter-probe-${uuid}`, incidentId: `presenter-probe-${uuid}`,
  };
}

/** GPUs on the nodes of rack r6, in snapshot order. */
export function rackGpuIds(snapshot: ObservedSnapshot, rackId = PROBE_RACK_ID): string[] {
  const nodes = new Set(snapshot.resources.filter((r) => r.kind === 'node' && r.parent_id === rackId).map((r) => r.resource_id));
  return snapshot.gpus.filter((g) => nodes.has(g.node_id)).map((g) => g.resource_id);
}

const versionOf = (snapshot: ObservedSnapshot, id: string): number | undefined =>
  snapshot.gpus.find((g) => g.resource_id === id)?.version
  ?? snapshot.nodes.find((n) => n.resource_id === id)?.version
  ?? snapshot.job_states.find((j) => j.job_id === id)?.version;

export type ProbeBuild = { ok: true; command: ActionCommand } | { ok: false; reason: string };

/** Builds the probe from a snapshot read immediately before submitting: its epoch, clock and resource versions. */
export function buildR6Probe(snapshot: ObservedSnapshot, ids: ProbeIds): ProbeBuild {
  const job = snapshot.job_states.find((j) => j.job_id === PROBE_JOB_ID);
  const spec = snapshot.job_specs.find((j) => j.job_id === PROBE_JOB_ID);
  if (!job || !spec) return { ok: false, reason: `${PROBE_JOB_ID} is not in this run.` };
  if (job.status === 'completed') return { ok: false, reason: `${PROBE_JOB_ID} has completed; there is nothing to move.` };
  const rackGpus = rackGpuIds(snapshot);
  const destination = rackGpus.slice(0, spec.gpus_required);
  if (destination.length < spec.gpus_required) return { ok: false, reason: `Rack r6 has ${rackGpus.length} GPUs; ${PROBE_JOB_ID} needs ${spec.gpus_required}.` };
  if (job.allocated_gpu_ids.some((id) => rackGpus.includes(id))) return { ok: false, reason: `${PROBE_JOB_ID} already runs on rack r6.` };
  const versions: Record<string, number> = {};
  for (const id of [PROBE_JOB_ID, ...destination]) {
    const version = versionOf(snapshot, id);
    if (version !== undefined) versions[id] = version;
  }
  return {
    ok: true,
    command: {
      schema_version: '1.1.0', run_id: snapshot.run_id, action_id: ids.actionId, command_key: ids.commandKey,
      workflow_id: ids.workflowId, plan_id: ids.planId, incident_ids: [ids.incidentId], operation: 'migrate_restart',
      target_resource_id: PROBE_JOB_ID, job_id: PROBE_JOB_ID, arguments: { destination_gpu_ids: destination },
      depends_on_command_keys: [], expected_decision_epoch: snapshot.clock.decision_epoch,
      expected_resource_versions: versions, requested_sim_time_ms: snapshot.clock.sim_time_ms,
    },
  };
}

function touched(command: ActionCommand): string[] {
  const args = command.arguments as { destination_gpu_ids?: unknown; destination_node_ids?: unknown };
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
  return [command.target_resource_id, ...(command.job_id ? [command.job_id] : []), ...list(args.destination_gpu_ids), ...list(args.destination_node_ids)];
}

/**
 * Why the probe must not be submitted now, or null. A non-terminal action that touches job-b, job-c (r6's tenant),
 * job-b's GPUs, r6's GPUs or their nodes would overlap; an in-flight action whose details have not arrived is
 * treated as overlapping because its targets are unknown.
 */
export function probeConflict(snapshot: ObservedSnapshot, actions: ActionStatus[], details: ActionDetail[]): string | null {
  const rackGpus = rackGpuIds(snapshot);
  const owners = snapshot.job_states.filter((j) => j.allocated_gpu_ids.some((g) => rackGpus.includes(g))).map((j) => j.job_id);
  const probeJob = snapshot.job_states.find((j) => j.job_id === PROBE_JOB_ID);
  const nodes = new Set(snapshot.gpus.filter((g) => rackGpus.includes(g.resource_id) || probeJob?.allocated_gpu_ids.includes(g.resource_id)).map((g) => g.node_id));
  const watched = new Set<string>([PROBE_JOB_ID, ...owners, ...rackGpus, ...(probeJob?.allocated_gpu_ids ?? []), ...nodes, PROBE_RACK_ID]);
  const byKey = new Map(details.map((d) => [d.command.command_key, d]));
  for (const status of [...actions, ...details.map((d) => d.status)]) {
    if (!NON_TERMINAL.has(status.status) || status.run_id !== snapshot.run_id) continue;
    const detail = byKey.get(status.command_key);
    if (!detail) return `Action ${status.command_key} is ${status.status} and its targets have not loaded yet.`;
    const hit = touched(detail.command).find((id) => watched.has(id));
    if (hit) return `${detail.command.operation.replaceAll('_', ' ')} ${detail.command.command_key} is ${status.status} and touches ${hit}.`;
  }
  return null;
}

export type ProbeVerdict = 'blocked' | 'accepted' | 'failed' | 'other';

/** BLOCKED only for the ledger's own safety rejection: `failed` with reason SAFETY_REJECTED. */
export function probeVerdict(status: ActionStatus): ProbeVerdict {
  if (status.status === 'failed' && status.reason_code === 'SAFETY_REJECTED') return 'blocked';
  if (status.status === 'failed') return 'failed';
  if (status.status === 'requested' || status.status === 'claimed' || status.status === 'running' || status.status === 'succeeded') return 'accepted';
  return 'other';
}

export function violationsOf(status: ActionStatus, safety: ActionSafety | null | undefined): string[] {
  if (safety?.violations.length) return safety.violations;
  return Array.isArray(status.result.violations) ? status.result.violations.filter((v): v is string => typeof v === 'string') : [];
}

export interface ThermalEvidence { rackId: string; availableC: number | null; requiredC: number | null; projectedMaxC: number | null; inletNowC: number | null }

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Per-rack thermal evidence exactly as `evaluateSafety` recorded it (no recomputation). */
export function thermalEvidence(safety: ActionSafety | null | undefined): ThermalEvidence[] {
  const rows = safety?.evidence.thermal;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object').map((row) => ({
    rackId: typeof row.rack_id === 'string' ? row.rack_id : 'unknown rack',
    availableC: num(row.available_headroom_c), requiredC: num(row.required_headroom_c),
    projectedMaxC: num(row.projected_max_gpu_temp_c), inletNowC: num(row.inlet_now_c),
  }));
}

export interface PowerEvidence { resourceId: string; requiredW: number | null; availableW: number | null }

export function powerEvidence(safety: ActionSafety | null | undefined): PowerEvidence[] {
  const rows = safety?.evidence.power;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && 'required_w' in row).map((row) => ({
    resourceId: typeof row.resource_id === 'string' ? row.resource_id : 'unknown',
    requiredW: num(row.required_w), availableW: num(row.available_w),
  }));
}
