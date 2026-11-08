// get_resource_dependencies and get_job_state: read-only views over the observed snapshot.

import { z } from 'zod';
import type { DependencyEdge } from '@dcos/contracts';
import { indexSnapshot } from './snapshot-index.js';
import { clipSummary, type ToolSpec } from './types.js';

const MAX_IDS = 20;
const MAX_NEIGHBORS = 30;
const MAX_CHAINS = 12;

// ------------------------------------------------------------------ get_resource_dependencies

const depsSchema = z.object({
  resource_ids: z.array(z.string().min(1)).min(1).max(MAX_IDS).describe('Resource IDs (gpu, node, rack, loop, pump, job, ...).'),
  depth: z.number().int().min(1).max(3).optional().describe('Traversal depth 1..3 (default 2).'),
});

interface Neighbor {
  id: string;
  relation: string;
  depth: number;
  via: string;
}

function walk(start: string, edges: Map<string, DependencyEdge[]>, pick: (e: DependencyEdge) => string, depth: number) {
  const out: Neighbor[] = [];
  const seen = new Set<string>([start]);
  let frontier = [start];
  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const from of frontier) {
      for (const e of edges.get(from) ?? []) {
        const id = pick(e);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, relation: e.relation, depth: d, via: from });
        next.push(id);
      }
    }
    frontier = next;
  }
  return out;
}

/** All provider paths from `start`, e.g. gpu -> node -> rack -> loop -> pump (depth-limited, capped). */
function providerChains(start: string, byConsumer: Map<string, DependencyEdge[]>, depth: number): string[] {
  const chains: string[] = [];
  const dfs = (path: string[]) => {
    if (chains.length >= MAX_CHAINS) return;
    const outs = (byConsumer.get(path[path.length - 1]!) ?? []).filter((e) => !path.includes(e.provider_id));
    if (path.length - 1 >= depth || outs.length === 0) {
      if (path.length > 1) chains.push(path.join(' -> '));
      return;
    }
    for (const e of outs) dfs([...path, e.provider_id]);
  };
  dfs([start]);
  return chains;
}

export const getResourceDependenciesTool: ToolSpec<z.infer<typeof depsSchema>> = {
  name: 'get_resource_dependencies',
  description:
    'Return what each resource depends on (providers, e.g. gpu -> node -> rack -> loop -> pump, rack -> power-main) and what depends on it ' +
    '(consumers) from the observed dependency graph, up to depth 3. Use it to check whether symptoms share a failure domain. Read-only.',
  schema: depsSchema,
  async run(args, { db }) {
    const depth = args.depth ?? 2;
    const snap = await db.getObservedSnapshot();
    const ix = indexSnapshot(snap);
    const byConsumer = new Map<string, DependencyEdge[]>();
    const byProvider = new Map<string, DependencyEdge[]>();
    for (const e of snap.dependencies) {
      byConsumer.set(e.consumer_id, [...(byConsumer.get(e.consumer_id) ?? []), e]);
      byProvider.set(e.provider_id, [...(byProvider.get(e.provider_id) ?? []), e]);
    }
    const results = args.resource_ids.map((id) => {
      const known = ix.resource.has(id) || ix.jobSpec.has(id) || byConsumer.has(id) || byProvider.has(id);
      if (!known) return { resource_id: id, error: 'unknown resource_id' };
      const providers = walk(id, byConsumer, (e) => e.provider_id, depth);
      const consumers = walk(id, byProvider, (e) => e.consumer_id, depth);
      return {
        resource_id: id,
        kind: ix.resource.get(id)?.kind ?? (ix.jobSpec.has(id) ? 'job' : 'unknown'),
        providers: providers.slice(0, MAX_NEIGHBORS),
        chains: providerChains(id, byConsumer, depth),
        consumers: consumers.slice(0, MAX_NEIGHBORS),
        consumers_omitted: Math.max(0, consumers.length - MAX_NEIGHBORS),
      };
    });
    const first = results[0] as { chains?: string[] } | undefined;
    const sample = first?.chains?.[0] ?? 'no chain';
    return {
      data: { depth, resources: results },
      summary: clipSummary(`get_resource_dependencies(${args.resource_ids.join(',')}, depth ${depth}): ${sample}`),
    };
  },
};

// ------------------------------------------------------------------ get_job_state

const jobSchema = z.object({
  job_ids: z.array(z.string().min(1)).min(1).max(MAX_IDS).describe('Job IDs, e.g. job-a.'),
});

const rackOf = (nodeId: string, ix: ReturnType<typeof indexSnapshot>) => ix.node.get(nodeId)?.rack_id ?? nodeId;

export const getJobStateTool: ToolSpec<z.infer<typeof jobSchema>> = {
  name: 'get_job_state',
  description:
    'Return each job\'s spec (GPUs required, preemptible, checkpoint support, durations), current state and progress, allocation summary by rack/node, ' +
    'and age of its latest checkpoint. Read-only.',
  schema: jobSchema,
  async run(args, { db }) {
    const snap = await db.getObservedSnapshot();
    const ix = indexSnapshot(snap);
    const now = snap.clock.sim_time_ms;
    const jobs = args.job_ids.map((id) => {
      const spec = ix.jobSpec.get(id);
      const state = ix.jobState.get(id);
      if (!spec || !state) return { job_id: id, error: 'unknown job_id' };
      const byRack: Record<string, number> = {};
      const nodes = new Set<string>();
      for (const gid of state.allocated_gpu_ids) {
        const node = ix.gpu.get(gid)?.node_id;
        if (!node) continue;
        nodes.add(node);
        const rack = rackOf(node, ix);
        byRack[rack] = (byRack[rack] ?? 0) + 1;
      }
      const ckpt =
        snap.checkpoints.find((c) => c.checkpoint_id === state.latest_checkpoint_id) ??
        [...snap.checkpoints]
          .filter((c) => c.job_id === id && c.status === 'complete')
          .sort((a, b) => (b.complete_sim_time_ms ?? 0) - (a.complete_sim_time_ms ?? 0))[0];
      const doneMs = ckpt?.complete_sim_time_ms ?? null;
      return {
        job_id: id,
        spec: {
          gpus_required: spec.gpus_required,
          placement_policy: spec.placement_policy,
          compatible_node_ids: spec.compatible_node_ids,
          priority: spec.priority,
          preemptible: spec.preemptible,
          checkpoint_supported: spec.checkpoint_supported,
          checkpoint_duration_ms: spec.checkpoint_duration_ms,
          restart_duration_ms: spec.restart_duration_ms,
          total_work_units: spec.total_work_units,
        },
        state: {
          status: state.status,
          progress_work_units: state.progress_work_units,
          durable_work_units: state.durable_work_units,
          at_risk_work_units: state.progress_work_units - state.durable_work_units,
          version: state.version,
        },
        allocation: { gpu_count: state.allocated_gpu_ids.length, by_rack: byRack, node_ids: [...nodes].sort() },
        checkpoint: ckpt
          ? {
              checkpoint_id: ckpt.checkpoint_id,
              status: ckpt.status,
              accessible: ckpt.accessible,
              progress_work_units: ckpt.progress_work_units,
              age_sim_s: doneMs === null ? null : Math.max(0, Math.round((now - doneMs) / 1000)),
            }
          : null,
      };
    });
    const parts = jobs.map((j) => {
      if ('error' in j) return `${j.job_id}: unknown`;
      const age = j.checkpoint?.age_sim_s;
      return `${j.job_id} ${j.state.status}, ${j.allocation.gpu_count} GPUs, ckpt ${age == null ? 'none' : `${age}s old`}`;
    });
    return { data: { sim_time_ms: now, jobs }, summary: clipSummary(`get_job_state: ${parts.join('; ')}`) };
  },
};
