import type { ObservedSnapshot } from '@dcos/contracts';
import type { ActionDetail, PlanRecord, WorkflowRecord } from '@dcos/db-client';
import { DEFAULT_XID_GPU_ID, REAL_RESOURCE_IDS } from './fault-form';

/**
 * Default target for the "Fail a GPU (XID 79)" demo button. Three honest tiers, in order:
 *  1. `plan`     – a GPU the agent's newest open workflow is moving work onto (its persisted plan's commands →
 *                  `destination_gpu_ids`, else a `gpu-…` target). Failing it makes the agent replan on stage.
 *  2. `selected` – the GPU the presenter picked in the cluster or the Advanced form.
 *  3. `default`  – `gpu-r7-n1-0` (pump-b's loop, away from the pump-a incident and hot rack 6).
 * A GPU that is already failed, missing from the snapshot or real (`gpu-real-0`) is never chosen.
 */
export type XidTargetSource = 'plan' | 'selected' | 'default';
export interface XidTarget { gpuId: string; source: XidTargetSource; planId: string | null }

const isGpuId = (value: unknown): value is string => typeof value === 'string' && /^gpu-/.test(value) && !REAL_RESOURCE_IDS.has(value);
const OPEN = (wf: WorkflowRecord) => wf.stage !== 'done' && wf.stage !== 'escalated';

/** A GPU is a usable target when the snapshot lists it as ready without an XID; with no snapshot we trust the id. */
function usable(gpuId: string, snapshot: Pick<ObservedSnapshot, 'gpus'> | null): boolean {
  if (!isGpuId(gpuId)) return false;
  if (!snapshot) return true;
  const gpu = snapshot.gpus.find((row) => row.resource_id === gpuId);
  return !!gpu && gpu.availability === 'ready' && gpu.last_xid_code === null;
}

/** GPU ids a command would place work on, destination first, then a GPU target. */
export function commandGpuIds(command: ActionDetail['command']): string[] {
  const args = command.arguments as { destination_gpu_ids?: unknown };
  const dest = Array.isArray(args.destination_gpu_ids) ? args.destination_gpu_ids.filter(isGpuId) : [];
  return isGpuId(command.target_resource_id) ? [...dest, command.target_resource_id] : dest;
}

export function defaultXidTarget(input: {
  plans: readonly PlanRecord[]; workflows: readonly WorkflowRecord[]; actionDetails: readonly ActionDetail[];
  selectedGpuId: string; snapshot: Pick<ObservedSnapshot, 'gpus' | 'run_id'> | null;
}): XidTarget {
  const { snapshot } = input;
  const runId = snapshot?.run_id;
  const open = input.workflows
    .filter((wf) => OPEN(wf) && (runId === undefined || wf.run_id === runId))
    .sort((a, b) => b.updated_at_unix_ms - a.updated_at_unix_ms);
  for (const wf of open) {
    const plan = wf.plan_id ? input.plans.find((row) => row.plan_id === wf.plan_id) ?? null : null;
    const keys = new Set(plan?.command_keys ?? []);
    // commands of the selected plan first, then anything else this workflow requested
    const commands = input.actionDetails
      .filter((row) => keys.has(row.command.command_key) || row.command.workflow_id === wf.workflow_id)
      .sort((a, b) => Number(keys.has(b.command.command_key)) - Number(keys.has(a.command.command_key)));
    for (const detail of commands) {
      const hit = commandGpuIds(detail.command).find((id) => usable(id, snapshot));
      if (hit) return { gpuId: hit, source: 'plan', planId: plan?.plan_id ?? detail.command.plan_id };
    }
  }
  if (input.selectedGpuId !== DEFAULT_XID_GPU_ID && usable(input.selectedGpuId, snapshot)) return { gpuId: input.selectedGpuId, source: 'selected', planId: null };
  return { gpuId: DEFAULT_XID_GPU_ID, source: 'default', planId: null };
}

export const XID_SOURCE_LABEL: Record<XidTargetSource, string> = {
  plan: 'from the persisted plan',
  selected: 'selected in the cluster',
  default: 'default',
};
