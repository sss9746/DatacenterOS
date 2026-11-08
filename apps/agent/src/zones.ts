// Zones for multi-agent incident response. A zone is a cooling loop (`loop-a`, `loop-b`): the loop that cools
// the racks an incident touches. Derived ONLY from the observed snapshot (cooling_loop resources' `cools_racks`,
// pumps' failure domain, node -> rack membership) and the incident's resource links, so every agent computes the
// same answer from the same DB rows. Pure: no I/O.
//
// Zones are a claiming PREFERENCE (an agent takes its own zone's new incidents first, others after a grace
// period); reclaiming an expired lease is global, so a surviving agent always takes over stranded workflows.

import type { IncidentLink, ObservedSnapshot } from '@dcos/contracts';

export type Zone = string;

/** rack id -> cooling loop id, from `cooling_loop` resources (`config.cools_racks`). */
export function rackZones(snap: ObservedSnapshot): Map<string, Zone> {
  const out = new Map<string, Zone>();
  for (const r of snap.resources) {
    if (r.kind !== 'cooling_loop') continue;
    const racks = (r.config as { cools_racks?: unknown }).cools_racks;
    if (!Array.isArray(racks)) continue;
    for (const rack of racks) if (typeof rack === 'string') out.set(rack, r.resource_id);
  }
  return out;
}

/** Zone of one resource id (loop, pump, rack, node or GPU), or null when it cannot be derived. */
export function resourceZone(snap: ObservedSnapshot, resourceId: string, racks: Map<string, Zone> = rackZones(snap)): Zone | null {
  const res = snap.resources.find((r) => r.resource_id === resourceId);
  if (res?.kind === 'cooling_loop') return res.resource_id;
  if (res?.kind === 'cooling_pump') return res.failure_domain_id;
  if (racks.has(resourceId)) return racks.get(resourceId)!;
  const node = snap.nodes.find((n) => n.resource_id === resourceId);
  if (node) return racks.get(node.rack_id) ?? null;
  const gpu = snap.gpus.find((g) => g.resource_id === resourceId);
  if (gpu) {
    const host = snap.nodes.find((n) => n.resource_id === gpu.node_id);
    return host ? (racks.get(host.rack_id) ?? null) : null;
  }
  if (res?.kind === 'node' && res.parent_id) return racks.get(res.parent_id) ?? null;
  return null;
}

/** Every resource id of the snapshot that appears inside `text` (longest first), e.g. `gpu-r7-n1-3` in an incident id. */
export function resourceIdsIn(snap: ObservedSnapshot, text: string): string[] {
  const ids = new Set<string>([
    ...snap.resources.map((r) => r.resource_id),
    ...snap.gpus.map((g) => g.resource_id),
    ...snap.nodes.map((n) => n.resource_id),
    ...snap.cooling.map((c) => c.resource_id),
  ]);
  return [...ids].filter((id) => text.includes(id)).sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

/**
 * Zone of an incident: the most common zone among its linked resources (ties: lexicographic). With no resolvable
 * resource link (a live incident may carry only symptom links), the resource named in the incident id itself
 * (`inc-<family>-<resource>-b<bucket>`, e.g. `inc-compute-gpu-r7-n1-3-b1`) decides. Null when neither resolves.
 */
export function incidentZone(incidentId: string, links: readonly IncidentLink[], snap: ObservedSnapshot): Zone | null {
  const racks = rackZones(snap);
  const counts = new Map<Zone, number>();
  for (const l of links) {
    if (l.incident_id !== incidentId || l.link_kind !== 'resource') continue;
    const z = resourceZone(snap, l.linked_id, racks);
    if (z) counts.set(z, (counts.get(z) ?? 0) + 1);
  }
  let best: Zone | null = null;
  for (const [z, n] of [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (best === null || n > (counts.get(best) ?? 0)) best = z;
  }
  if (best !== null) return best;
  for (const id of resourceIdsIn(snap, incidentId)) {
    const z = resourceZone(snap, id, racks);
    if (z) return z;
  }
  return null;
}

/** Racks hosting the given GPU ids (unknown GPUs are skipped), sorted. */
export function racksOfGpus(snap: ObservedSnapshot, gpuIds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of gpuIds) {
    const gpu = snap.gpus.find((g) => g.resource_id === id);
    const node = gpu ? snap.nodes.find((n) => n.resource_id === gpu.node_id) : undefined;
    if (node) out.add(node.rack_id);
  }
  return [...out].sort();
}

/** Zones of the given racks (unknown racks are skipped), sorted and unique. */
export function zonesOfRacks(snap: ObservedSnapshot, rackIds: readonly string[]): Zone[] {
  const racks = rackZones(snap);
  return [...new Set(rackIds.map((r) => racks.get(r)).filter((z): z is Zone => !!z))].sort();
}

/**
 * Claim order for fresh incidents: this agent's zone first, unknown zone next, other zones last; ties by id.
 * `zoneOf` is the per-incident zone (null = unknown). With no agent zone every incident ranks equally.
 */
export function orderByZone<T extends { incident_id: string }>(incidents: readonly T[], agentZone: Zone | null, zoneOf: (id: string) => Zone | null): T[] {
  const rank = (i: T): number => {
    if (agentZone === null) return 1;
    const z = zoneOf(i.incident_id);
    return z === agentZone ? 0 : z === null ? 1 : 2;
  };
  return [...incidents].sort((a, b) => rank(a) - rank(b) || a.incident_id.localeCompare(b.incident_id));
}

/** True when this agent should claim the incident right away (its zone, unknown zone, or no zone configured). */
export const claimsImmediately = (agentZone: Zone | null, incidentZoneId: Zone | null): boolean =>
  agentZone === null || incidentZoneId === null || incidentZoneId === agentZone;
