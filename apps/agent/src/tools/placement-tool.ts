// list_placement_candidates: feasible destination GPU sets for a job, annotated with rack headroom.

import { z } from 'zod';
import { GPU_THROTTLE_TEMP_C, REAL_GPU_ID, indexSnapshot, type SnapshotIndex } from './snapshot-index.js';
import { ToolError, clipSummary, type ToolSpec } from './types.js';

export const MAX_CANDIDATES = 8;
const MAX_NODE_POOL = 6;
/** Below this thermal headroom a destination is flagged (the hard check still belongs to evaluateSafety). */
export const LOW_HEADROOM_C = 5;

const argsSchema = z.object({ job_id: z.string().min(1).describe('Job to find destinations for, e.g. job-a.') });

interface NodeOption {
  node_id: string;
  rack_id: string;
  free: string[];
  size: number;
  thermal_headroom_c: number;
  power_headroom_w: number;
  cooling_loop: string | null;
  cooling_state: string | null;
}

export interface PlacementCandidate {
  destination_gpu_ids: string[];
  node_ids: string[];
  rack_ids: string[];
  min_thermal_headroom_c: number;
  min_power_headroom_w: number;
  cooling_states: string[];
  low_headroom: boolean;
  note: string;
}

function eligibleNodes(ix: SnapshotIndex, compatible: ReadonlySet<string>): NodeOption[] {
  const out: NodeOption[] = [];
  for (const [nodeId, gpuIds] of ix.nodeGpus) {
    const node = ix.node.get(nodeId);
    if (!node || node.availability !== 'ready' || !compatible.has(nodeId)) continue;
    const free = gpuIds.filter((id) => {
      const g = ix.gpu.get(id);
      return (
        g !== undefined &&
        id !== REAL_GPU_ID &&
        g.availability === 'ready' &&
        g.temp_c < GPU_THROTTLE_TEMP_C &&
        g.last_xid_code === null &&
        !ix.allocatedGpus.has(id)
      );
    });
    if (free.length === 0) continue;
    const loop = ix.loopOfRack.get(node.rack_id) ?? null;
    out.push({
      node_id: nodeId,
      rack_id: node.rack_id,
      free,
      size: gpuIds.length,
      thermal_headroom_c: node.thermal_headroom_c,
      power_headroom_w: node.power_headroom_w,
      cooling_loop: loop,
      cooling_state: loop ? (ix.cooling.get(loop)?.operating_state ?? null) : null,
    });
  }
  return out.sort(
    (a, b) =>
      b.thermal_headroom_c - a.thermal_headroom_c ||
      b.power_headroom_w - a.power_headroom_w ||
      a.node_id.localeCompare(b.node_id),
  );
}

const combinations = <T>(items: T[], k: number): T[][] => {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [head, ...rest] = items;
  return [...combinations(rest, k - 1).map((c) => [head!, ...c]), ...combinations(rest, k)];
};

function toCandidate(nodes: NodeOption[], need: number): PlacementCandidate {
  const gpus = nodes.flatMap((n) => n.free).slice(0, need);
  const minThermal = Math.min(...nodes.map((n) => n.thermal_headroom_c));
  const low = minThermal < LOW_HEADROOM_C || nodes.some((n) => n.cooling_state !== null && n.cooling_state !== 'normal');
  return {
    destination_gpu_ids: gpus,
    node_ids: nodes.map((n) => n.node_id),
    rack_ids: nodes.map((n) => n.rack_id),
    min_thermal_headroom_c: minThermal,
    min_power_headroom_w: Math.min(...nodes.map((n) => n.power_headroom_w)),
    cooling_states: [...new Set(nodes.map((n) => `${n.cooling_loop ?? 'no-loop'}:${n.cooling_state ?? 'unknown'}`))],
    low_headroom: low,
    note: low ? 'low thermal headroom or degraded cooling: likely blocked by safety' : 'healthy, free, compatible',
  };
}

/** Pure helper (also used by the planner): feasible destination sets, best headroom first. */
export function placementCandidates(ix: SnapshotIndex, jobId: string): PlacementCandidate[] {
  const spec = ix.jobSpec.get(jobId);
  if (!spec) throw new ToolError(`unknown job_id ${jobId}`);
  const pool = eligibleNodes(ix, new Set(spec.compatible_node_ids));
  const need = spec.gpus_required;
  const nodeSize = Math.max(...[...ix.nodeGpus.values()].map((g) => g.length), 1);

  let sets: NodeOption[][];
  if (spec.placement_policy === 'same_node' || need <= nodeSize) {
    sets = pool.filter((n) => n.free.length >= need).map((n) => [n]);
  } else {
    const k = Math.ceil(need / nodeSize);
    const whole = pool.filter((n) => n.free.length === n.size).slice(0, MAX_NODE_POOL);
    sets = combinations(whole, k);
  }
  return sets
    .map((s) => toCandidate(s, need))
    .sort(
      (a, b) =>
        Number(a.low_headroom) - Number(b.low_headroom) ||
        b.min_thermal_headroom_c - a.min_thermal_headroom_c ||
        b.min_power_headroom_w - a.min_power_headroom_w ||
        a.destination_gpu_ids[0]!.localeCompare(b.destination_gpu_ids[0]!),
    )
    .slice(0, MAX_CANDIDATES);
}

export const listPlacementCandidatesTool: ToolSpec<z.infer<typeof argsSchema>> = {
  name: 'list_placement_candidates',
  description:
    'List feasible destination GPU sets for moving a job: whole-node sets sized to gpus_required, on compatible, ready nodes, with healthy, ' +
    'unallocated GPUs (never the real hardware GPU), each annotated with rack thermal/power headroom and cooling state, best headroom first. ' +
    'Feasible here is not the same as safe: simulate_plan and the coordinator still check. Read-only.',
  schema: argsSchema,
  async run(args, { db }) {
    const ix = indexSnapshot(await db.getObservedSnapshot());
    const candidates = placementCandidates(ix, args.job_id);
    const top = candidates[0];
    const racks = candidates.map((c) => c.rack_ids.map((r) => r.replace('rack-', '')).join('+')).join(', ');
    return {
      data: { job_id: args.job_id, gpus_required: ix.jobSpec.get(args.job_id)!.gpus_required, candidates },
      summary: clipSummary(
        `list_placement_candidates(${args.job_id}): ${candidates.length} options${top ? ` [${racks}], best ${top.min_thermal_headroom_c}C headroom` : ''}`,
      ),
    };
  },
};
