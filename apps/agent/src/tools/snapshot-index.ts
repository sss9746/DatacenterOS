// Read-only lookup helpers over an ObservedSnapshot (shared by the tools and buildCommand).

import type { ObservedSnapshot } from '@dcos/contracts';

export const REAL_GPU_ID = 'gpu-real-0';
export const GPU_THROTTLE_TEMP_C = 85;

export interface SnapshotIndex {
  snap: ObservedSnapshot;
  gpu: Map<string, ObservedSnapshot['gpus'][number]>;
  node: Map<string, ObservedSnapshot['nodes'][number]>;
  cooling: Map<string, ObservedSnapshot['cooling'][number]>;
  jobSpec: Map<string, ObservedSnapshot['job_specs'][number]>;
  jobState: Map<string, ObservedSnapshot['job_states'][number]>;
  resource: Map<string, ObservedSnapshot['resources'][number]>;
  /** GPU ids currently allocated to any job (allocations table or job_states). */
  allocatedGpus: Set<string>;
  /** node id -> its GPU ids (sorted). */
  nodeGpus: Map<string, string[]>;
  /** rack id -> cooling loop id (cooled_by edge). */
  loopOfRack: Map<string, string>;
}

const byId = <T>(items: T[], key: (t: T) => string): Map<string, T> => new Map(items.map((i) => [key(i), i]));

export function indexSnapshot(snap: ObservedSnapshot): SnapshotIndex {
  const nodeGpus = new Map<string, string[]>();
  for (const g of snap.gpus) {
    const list = nodeGpus.get(g.node_id) ?? [];
    list.push(g.resource_id);
    nodeGpus.set(g.node_id, list);
  }
  for (const list of nodeGpus.values()) list.sort();
  const allocatedGpus = new Set<string>([
    ...snap.allocations.map((a) => a.gpu_id),
    ...snap.job_states.filter((j) => j.status !== 'completed').flatMap((j) => j.allocated_gpu_ids),
  ]);
  const loopOfRack = new Map<string, string>();
  for (const e of snap.dependencies) if (e.relation === 'cooled_by') loopOfRack.set(e.consumer_id, e.provider_id);
  return {
    snap,
    gpu: byId(snap.gpus, (g) => g.resource_id),
    node: byId(snap.nodes, (n) => n.resource_id),
    cooling: byId(snap.cooling, (c) => c.resource_id),
    jobSpec: byId(snap.job_specs, (j) => j.job_id),
    jobState: byId(snap.job_states, (j) => j.job_id),
    resource: byId(snap.resources, (r) => r.resource_id),
    allocatedGpus,
    nodeGpus,
    loopOfRack,
  };
}

/** Version of any versioned resource/job in the snapshot, or undefined. */
export function versionOf(ix: SnapshotIndex, id: string): number | undefined {
  return (
    ix.gpu.get(id)?.version ??
    ix.node.get(id)?.version ??
    ix.cooling.get(id)?.version ??
    ix.jobState.get(id)?.version
  );
}
