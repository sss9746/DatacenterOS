// P3-3 Triage + correlation (LANE-P3 "How the agent decides", ARCHITECTURE §4).
//
// 1. Deterministic symptom extraction from the ObservedSnapshot + recent SignalEvents.
// 2. Deterministic grouping by dependency path (gpu -> node -> rack -> loop -> pump): symptoms whose
//    most-upstream *degraded* provider is the same, within a time window, form one candidate.
//    Symptoms with no degraded provider stand alone. Time overlap alone never merges candidates.
// 3. Nemotron (LlmPort) confirms / splits / merges candidates through one tool call. Code validates
//    everything: unknown evidence ids and merges without a shared provider are overridden.
// 4. Incidents are upserted with stable ids, so reruns update instead of duplicating.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  DependencyEdge,
  Incident,
  IncidentLink,
  ObservedSnapshot,
  ResourceSpec,
  SignalEvent,
} from '@dcos/contracts';
import type { DbPort, Evidence, LlmPort, SymptomRecord, ToolCallSummary } from './ports.js';
import { TRIAGE_SYSTEM_PROMPT, TRIAGE_TOOL, TRIAGE_TOOL_NAME, buildTriageUserMessage } from './prompts/triage.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const V = '1.1.0' as const;
export const THERMAL_THROTTLE_BIT = 0x20; // CONTRACTS §0.11.5
export const THROTTLE_TEMP_C = 85; // CONTRACTS §0.4
export const NEAR_THROTTLE_TEMP_C = 83;
export const TRIAGE_XID_CODES: ReadonlySet<number> = new Set([48, 74, 79]);
export const STALE_TELEMETRY_MS = 30_000;
export const SYMPTOM_BUCKET_MS = 300_000;
export const DEFAULT_TRIAGE_WINDOW_MS = 600_000;
export const LLM_PAYLOAD_MAX_BYTES = 6_000;
export const DETERMINISTIC_CONFIDENCE = 0.5;
export const LLM_UNAVAILABLE_HYPOTHESIS = 'deterministic grouping (LLM unavailable)';
const MAX_DETERMINISTIC_EVIDENCE = 20;
const MAX_REASON = 500;
const MAX_TITLE = 180;
/** F-NV1: a hypothesis is ONE conclusion sentence (evidence -> conclusion). */
const MAX_HYPOTHESIS = 200;

export type SymptomKind =
  | 'thermal_throttle'
  | 'near_throttle'
  | 'gpu_xid'
  | 'gpu_unavailable'
  | 'node_unavailable'
  | 'cooling_degraded'
  | 'cooling_outage'
  | 'stale_telemetry';

/** thermal = cooling/hosting path; compute = hosting path only, unreachable providers only. */
export type SymptomFamily = 'thermal' | 'compute';

const FAMILY: Record<SymptomKind, SymptomFamily> = {
  thermal_throttle: 'thermal',
  near_throttle: 'thermal',
  cooling_degraded: 'thermal',
  cooling_outage: 'thermal',
  gpu_xid: 'compute',
  gpu_unavailable: 'compute',
  node_unavailable: 'compute',
  stale_telemetry: 'compute',
};

const SEVERITY: Record<SymptomKind, SymptomRecord['severity']> = {
  thermal_throttle: 'warning',
  near_throttle: 'info',
  cooling_degraded: 'warning',
  cooling_outage: 'critical',
  gpu_xid: 'critical',
  gpu_unavailable: 'critical',
  node_unavailable: 'critical',
  stale_telemetry: 'warning',
};

/** Kinds that open an incident on their own; others only join a group that has a degraded provider. */
const PRIMARY: ReadonlySet<SymptomKind> = new Set([
  'thermal_throttle',
  'gpu_xid',
  'gpu_unavailable',
  'node_unavailable',
  'cooling_degraded',
  'cooling_outage',
]);

type Relation = DependencyEdge['relation'];
const PATH_RELATIONS: Record<SymptomFamily, ReadonlySet<Relation>> = {
  thermal: new Set<Relation>(['hosted_on', 'cooled_by']),
  compute: new Set<Relation>(['hosted_on']),
};
const SHARED_PROVIDER_RELATIONS: ReadonlySet<Relation> = new Set<Relation>(['hosted_on', 'cooled_by']);
const PROVIDER_KINDS: ReadonlySet<ResourceSpec['kind']> = new Set(['node', 'rack', 'cooling_loop', 'cooling_pump']);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TriageDeps {
  db: DbPort;
  /** null = no LLM configured; the deterministic grouping is used as-is. */
  llm: LlmPort | null;
  /** Wall clock (unix ms), used only for latency in tool-call summaries. */
  now: () => number;
}

export interface TriageOptions {
  /** Extra recent signals (deduplicated by event_id with getEvidence's signals). */
  signals?: SignalEvent[];
  windowSimMs?: number;
  maxTokens?: number;
  log?: (msg: string) => void;
}

export interface TriageResult {
  incidents: Incident[];
  links: IncidentLink[];
  toolCalls: ToolCallSummary[];
  usedLlm: boolean;
  /** Incident ids whose hypothesis is Nemotron's own conclusion (LLM assessment accepted). */
  llmIncidentIds?: string[];
  symptoms: SymptomRecord[];
  /** Non-primary symptoms with no degraded provider (e.g. near-throttle on a healthy rack): watched, no incident. */
  unassignedSymptoms: SymptomRecord[];
  /** LLM decisions that code rejected, with the reason. */
  overrides: string[];
  /** Evidence ids cited per incident (LLM-cited if accepted, else deterministic). For F-NV1 events. */
  evidenceIdsByIncident: Record<string, string[]>;
}

export interface Candidate {
  candidate_id: string;
  family: SymptomFamily;
  /** Most-upstream degraded provider shared by the symptoms; null = standalone. */
  cause_id: string | null;
  anchor_id: string;
  symptoms: SymptomRecord[];
  /** symptom_id -> dependency path from the symptom's resource to the cause. */
  paths: Record<string, string[]>;
  /** Every hosting/cooling provider (healthy or not) of the symptoms' resources. */
  provider_ids: string[];
  opened_sim_ms: number;
}

// ---------------------------------------------------------------------------
// Topology helpers
// ---------------------------------------------------------------------------

interface Topology {
  obs: ObservedSnapshot;
  providers: Map<string, DependencyEdge[]>;
  kinds: Map<string, ResourceSpec['kind']>;
}

function buildTopology(obs: ObservedSnapshot): Topology {
  const providers = new Map<string, DependencyEdge[]>();
  for (const e of obs.dependencies) {
    const list = providers.get(e.consumer_id) ?? [];
    providers.set(e.consumer_id, [...list, e]);
  }
  const kinds = new Map(obs.resources.map((r) => [r.resource_id, r.kind] as const));
  return { obs, providers, kinds };
}

interface ProviderHop {
  id: string;
  path: string[];
}

/** BFS up consumer -> provider edges restricted to `relations`. */
function walkProviders(t: Topology, start: string, relations: ReadonlySet<Relation>, maxDepth = 6): ProviderHop[] {
  const out: ProviderHop[] = [];
  const seen = new Set([start]);
  let frontier: ProviderHop[] = [{ id: start, path: [start] }];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: ProviderHop[] = [];
    for (const hop of frontier) {
      for (const e of t.providers.get(hop.id) ?? []) {
        if (!relations.has(e.relation) || seen.has(e.provider_id)) continue;
        seen.add(e.provider_id);
        const n = { id: e.provider_id, path: [...hop.path, e.provider_id] };
        out.push(n);
        next.push(n);
      }
    }
    frontier = next;
  }
  return out;
}

/** Health of a resource as a provider. `compute` only counts unreachable hosts. */
function providerState(t: Topology, id: string, family: SymptomFamily): string | null {
  const cooling = t.obs.cooling.find((c) => c.resource_id === id);
  if (cooling) return family === 'thermal' && cooling.operating_state !== 'normal' ? cooling.operating_state : null;
  const node = t.obs.nodes.find((n) => n.resource_id === id);
  if (node) {
    if (family === 'thermal') return node.availability !== 'ready' ? node.availability : null;
    return node.availability === 'unreachable' ? 'unreachable' : null;
  }
  return null;
}

function isProviderResource(t: Topology, id: string): boolean {
  const kind = t.kinds.get(id);
  return kind !== undefined && PROVIDER_KINDS.has(kind);
}

/** Most-upstream degraded provider for a symptom (the resource itself counts if it is a provider). */
function findCause(t: Topology, s: SymptomRecord): ProviderHop | null {
  const family = FAMILY[s.kind as SymptomKind];
  const hops = walkProviders(t, s.resource_id, PATH_RELATIONS[family]);
  const self = isProviderResource(t, s.resource_id) ? [{ id: s.resource_id, path: [s.resource_id] }] : [];
  const degraded = [...self, ...hops].filter((h) => providerState(t, h.id, family) !== null);
  if (degraded.length === 0) return null;
  return [...degraded].sort((a, b) => b.path.length - a.path.length || a.id.localeCompare(b.id))[0] ?? null;
}

function sharedProviderSet(t: Topology, resourceId: string): string[] {
  const hops = walkProviders(t, resourceId, SHARED_PROVIDER_RELATIONS).map((h) => h.id);
  return isProviderResource(t, resourceId) ? [resourceId, ...hops] : hops;
}

// ---------------------------------------------------------------------------
// 1. Symptom extraction
// ---------------------------------------------------------------------------

const bucketOf = (simMs: number) => Math.floor(simMs / SYMPTOM_BUCKET_MS);
const symptomPrefix = (kind: SymptomKind, resourceId: string) => `sym-${kind}-${resourceId}-b`;

/** Event ids in the snapshot that name this resource (bounded by '-' or string ends). */
function mentionedEventIds(obs: ObservedSnapshot, resourceId: string): string[] {
  const re = new RegExp(`(^|-)${resourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-|$)`);
  return obs.observation_event_ids.filter((id) => re.test(id));
}

interface Draft {
  kind: SymptomKind;
  resource_id: string;
  first_seen: number;
  last_seen: number;
  evidence: string[];
}

export interface ExtractOptions {
  /** Existing symptom ids (from evidence links / symptom rows) to reuse, keyed by id. */
  existingSymptoms?: Map<string, { first_seen_sim_ms: number }>;
}

/** Deterministic symptom extraction. Stable ids: `sym-<kind>-<resource>-b<first_seen bucket>`. */
export function extractSymptoms(obs: ObservedSnapshot, signals: SignalEvent[], opts: ExtractOptions = {}): SymptomRecord[] {
  const now = obs.clock.sim_time_ms;
  const drafts = new Map<string, Draft>();
  const add = (d: Draft) => {
    const key = `${d.kind}|${d.resource_id}`;
    const prev = drafts.get(key);
    if (!prev) {
      drafts.set(key, { ...d, evidence: [...new Set(d.evidence)] });
      return;
    }
    drafts.set(key, {
      ...prev,
      first_seen: Math.min(prev.first_seen, d.first_seen),
      last_seen: Math.max(prev.last_seen, d.last_seen),
      evidence: [...new Set([...prev.evidence, ...d.evidence])],
    });
  };
  const snapEvidence = (id: string, version: number) => [...mentionedEventIds(obs, id), `obs:${id}:v${version}`];

  // Signals first (they carry real timestamps).
  for (const sig of signals) {
    const ev = { resource_id: sig.resource_id, first_seen: sig.sim_time_ms, last_seen: sig.sim_time_ms, evidence: [sig.event_id] };
    if (sig.event_type === 'xid_error' && sig.xid_code !== null && TRIAGE_XID_CODES.has(sig.xid_code)) add({ kind: 'gpu_xid', ...ev });
    else if (sig.event_type === 'gpu_unreachable') add({ kind: 'gpu_unavailable', ...ev });
    else if (sig.event_type === 'node_unreachable') add({ kind: 'node_unavailable', ...ev });
    else if (sig.event_type === 'sensor_timeout') add({ kind: 'stale_telemetry', ...ev });
  }

  for (const c of obs.cooling) {
    if (c.operating_state === 'normal') continue;
    const kind: SymptomKind = c.operating_state === 'failed' ? 'cooling_outage' : 'cooling_degraded';
    add({ kind, resource_id: c.resource_id, first_seen: now, last_seen: now, evidence: snapEvidence(c.resource_id, c.version) });
  }
  for (const n of obs.nodes) {
    if (n.availability !== 'unreachable') continue;
    add({ kind: 'node_unavailable', resource_id: n.resource_id, first_seen: now, last_seen: now, evidence: snapEvidence(n.resource_id, n.version) });
  }
  for (const g of obs.gpus) {
    const ev = snapEvidence(g.resource_id, g.version);
    const base = { resource_id: g.resource_id, last_seen: now, evidence: ev };
    if ((g.clocks_event_reasons & THERMAL_THROTTLE_BIT) !== 0 || g.temp_c >= THROTTLE_TEMP_C) {
      add({ kind: 'thermal_throttle', first_seen: now, ...base });
    } else if (g.temp_c >= NEAR_THROTTLE_TEMP_C) {
      add({ kind: 'near_throttle', first_seen: now, ...base });
    }
    const hasXid = g.last_xid_code !== null && TRIAGE_XID_CODES.has(g.last_xid_code);
    if (hasXid) add({ kind: 'gpu_xid', first_seen: g.last_seen_sim_ms, ...base, last_seen: g.last_seen_sim_ms });
    if (g.availability === 'unreachable' && !hasXid && !drafts.has(`gpu_xid|${g.resource_id}`)) {
      add({ kind: 'gpu_unavailable', first_seen: g.last_seen_sim_ms, ...base, last_seen: g.last_seen_sim_ms });
    }
    if (g.availability !== 'unreachable' && now - g.last_seen_sim_ms > STALE_TELEMETRY_MS) {
      add({ kind: 'stale_telemetry', first_seen: g.last_seen_sim_ms, ...base, last_seen: g.last_seen_sim_ms });
    }
  }

  // An XID symptom supersedes a gpu_unavailable symptom on the same GPU.
  for (const key of [...drafts.keys()]) {
    const [kind, rid] = key.split('|');
    if (kind === 'gpu_unavailable' && drafts.has(`gpu_xid|${rid}`)) drafts.delete(key);
  }

  const existing = opts.existingSymptoms ?? new Map<string, { first_seen_sim_ms: number }>();
  const out = [...drafts.values()].map((d): SymptomRecord => {
    const prefix = symptomPrefix(d.kind, d.resource_id);
    const reuse = [...existing.entries()].filter(([id]) => id.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))[0];
    const first = reuse ? Math.min(reuse[1].first_seen_sim_ms, d.first_seen) : d.first_seen;
    return {
      symptom_id: reuse ? reuse[0] : `${prefix}${bucketOf(d.first_seen)}`,
      run_id: obs.run_id,
      resource_id: d.resource_id,
      first_seen_sim_ms: first,
      last_seen_sim_ms: Math.max(d.last_seen, first),
      kind: d.kind,
      severity: SEVERITY[d.kind],
      evidence_event_ids: d.evidence,
      status: 'active',
    };
  });
  return out.sort((a, b) => a.symptom_id.localeCompare(b.symptom_id));
}

// ---------------------------------------------------------------------------
// 2. Deterministic grouping
// ---------------------------------------------------------------------------

export interface GroupOptions {
  windowSimMs?: number;
  /** Existing incidents; an open one with the same group prefix and a nearby open time keeps its id. */
  existingIncidents?: Incident[];
}

export interface GroupResult {
  candidates: Candidate[];
  unassigned: SymptomRecord[];
}

function incidentPrefix(family: SymptomFamily, anchor: string): string {
  return `inc-${family}-${anchor}-b`;
}

function pickIncidentId(family: SymptomFamily, anchor: string, start: number, window: number, existing: Incident[], taken: Set<string>): string {
  const prefix = incidentPrefix(family, anchor);
  const reuse = existing
    .filter((i) => i.incident_id.startsWith(prefix) && i.state !== 'resolved' && !taken.has(i.incident_id))
    .filter((i) => Math.abs(i.opened_sim_time_ms - start) <= window)
    .sort((a, b) => a.incident_id.localeCompare(b.incident_id))[0];
  return reuse ? reuse.incident_id : `${prefix}${bucketOf(start)}`;
}

/** Group symptoms by most-upstream degraded provider + time window. Never merges on time alone. */
export function groupSymptoms(obs: ObservedSnapshot, symptoms: SymptomRecord[], opts: GroupOptions = {}): GroupResult {
  const t = buildTopology(obs);
  const window = opts.windowSimMs ?? DEFAULT_TRIAGE_WINDOW_MS;
  const keyed = new Map<string, { family: SymptomFamily; cause: string | null; anchor: string; items: { s: SymptomRecord; path: string[] }[] }>();
  const unassigned: SymptomRecord[] = [];

  for (const s of symptoms) {
    const kind = s.kind as SymptomKind;
    const family = FAMILY[kind];
    const cause = findCause(t, s);
    if (!cause && !PRIMARY.has(kind)) {
      unassigned.push(s);
      continue;
    }
    const anchor = cause ? cause.id : s.resource_id;
    const key = `${family}|${anchor}`;
    const group = keyed.get(key) ?? { family, cause: cause ? cause.id : null, anchor, items: [] };
    keyed.set(key, { ...group, items: [...group.items, { s, path: cause ? cause.path : [s.resource_id] }] });
  }

  const candidates: Candidate[] = [];
  const taken = new Set<string>();
  for (const g of [...keyed.values()].sort((a, b) => `${a.family}|${a.anchor}`.localeCompare(`${b.family}|${b.anchor}`))) {
    const items = [...g.items].sort((a, b) => a.s.first_seen_sim_ms - b.s.first_seen_sim_ms || a.s.symptom_id.localeCompare(b.s.symptom_id));
    // Time-window clustering inside one dependency group.
    const clusters: (typeof items)[] = [];
    for (const it of items) {
      const cur = clusters[clusters.length - 1];
      if (cur && it.s.first_seen_sim_ms - (cur[0]?.s.first_seen_sim_ms ?? 0) <= window) cur.push(it);
      else clusters.push([it]);
    }
    for (const cl of clusters) {
      const start = cl[0]?.s.first_seen_sim_ms ?? obs.clock.sim_time_ms;
      const id = pickIncidentId(g.family, g.anchor, start, window, opts.existingIncidents ?? [], taken);
      taken.add(id);
      const providerIds = new Set<string>();
      for (const it of cl) for (const p of sharedProviderSet(t, it.s.resource_id)) providerIds.add(p);
      candidates.push({
        candidate_id: id,
        family: g.family,
        cause_id: g.cause,
        anchor_id: g.anchor,
        symptoms: cl.map((it) => it.s),
        paths: Object.fromEntries(cl.map((it) => [it.s.symptom_id, it.path])),
        provider_ids: [...providerIds].sort(),
        opened_sim_ms: start,
      });
    }
  }
  return { candidates, unassigned };
}

// ---------------------------------------------------------------------------
// Incident + link construction
// ---------------------------------------------------------------------------

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

function incidentSeverity(symptoms: SymptomRecord[]): Incident['severity'] {
  if (symptoms.some((s) => s.severity === 'critical')) return 'critical';
  if (symptoms.some((s) => s.severity === 'warning')) return 'high';
  return 'medium';
}

function countKinds(symptoms: SymptomRecord[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of symptoms) m.set(s.kind, (m.get(s.kind) ?? 0) + 1);
  return m;
}

function rackOfResource(obs: ObservedSnapshot, id: string): string | null {
  const g = obs.gpus.find((x) => x.resource_id === id);
  const nodeId = g ? g.node_id : id;
  return obs.nodes.find((n) => n.resource_id === nodeId)?.rack_id ?? null;
}

function describeCause(obs: ObservedSnapshot, causeId: string | null): string {
  if (!causeId) return 'no degraded shared provider';
  const c = obs.cooling.find((x) => x.resource_id === causeId);
  if (c) return `${causeId} ${c.operating_state}`;
  const n = obs.nodes.find((x) => x.resource_id === causeId);
  return n ? `${causeId} ${n.availability}` : causeId;
}

export function candidateTitle(obs: ObservedSnapshot, c: Candidate): string {
  const kinds = countKinds(c.symptoms);
  const racks = [...new Set(c.symptoms.map((s) => rackOfResource(obs, s.resource_id)).filter((r): r is string => r !== null))].sort();
  const throttled = kinds.get('thermal_throttle') ?? 0;
  const near = kinds.get('near_throttle') ?? 0;
  if (c.family === 'thermal' && c.cause_id) {
    const gpuPart = throttled + near > 0 ? `: ${throttled} GPUs throttling${near ? ` (+${near} near throttle)` : ''}` : '';
    return clip(`Cooling ${describeCause(obs, c.cause_id)}${gpuPart}${racks.length ? ` on ${racks.join(', ')}` : ''}`, MAX_TITLE);
  }
  if (c.family === 'thermal') return clip(`Local thermal throttle on ${c.anchor_id}`, MAX_TITLE);
  const xid = c.symptoms.find((s) => s.kind === 'gpu_xid');
  if (xid && c.symptoms.length === 1) {
    const code = obs.gpus.find((g) => g.resource_id === xid.resource_id)?.last_xid_code;
    return clip(`XID ${code ?? ''} on ${xid.resource_id}`.replace('XID  ', 'XID '), MAX_TITLE);
  }
  const summary = [...kinds.entries()].map(([k, n]) => `${n}× ${k}`).join(', ');
  return clip(`${c.cause_id ? `Host ${describeCause(obs, c.cause_id)}` : `Compute fault on ${c.anchor_id}`}: ${summary}`, MAX_TITLE);
}

function deterministicSummary(obs: ObservedSnapshot, c: Candidate): string {
  if (!c.cause_id) return `${c.symptoms.length} symptom(s) on ${c.anchor_id}; ${describeCause(obs, null)}, treated as independent`;
  return `${c.symptoms.length} symptom(s) share degraded provider ${describeCause(obs, c.cause_id)}`;
}

function buildLinks(obs: ObservedSnapshot, c: Candidate): IncidentLink[] {
  const link = (linked_id: string, link_kind: IncidentLink['link_kind'], reason: string): IncidentLink => ({
    schema_version: V,
    run_id: obs.run_id,
    incident_id: c.candidate_id,
    linked_id,
    link_kind,
    reason: clip(reason, MAX_REASON),
  });
  const out: IncidentLink[] = [];
  const resources = new Map<string, string>();
  for (const s of c.symptoms) {
    const path = c.paths[s.symptom_id] ?? [s.resource_id];
    const why = c.cause_id ? `shares degraded provider ${c.cause_id} via ${path.join(' -> ')}` : 'standalone: no degraded shared provider';
    out.push(link(s.symptom_id, 'symptom', `${s.kind} on ${s.resource_id}; ${why}`));
    if (!resources.has(s.resource_id)) resources.set(s.resource_id, `affected: ${s.kind}`);
  }
  if (c.cause_id) {
    resources.set(c.cause_id, `hypothesized cause (deterministic): ${describeCause(obs, c.cause_id)}`);
    const t = buildTopology(obs);
    for (const path of Object.values(c.paths)) {
      for (const id of path.slice(1, -1)) {
        if (!resources.has(id) && providerState(t, id, c.family) !== null) {
          resources.set(id, `degraded provider on dependency path to ${c.cause_id}`);
        }
      }
    }
  }
  const affectedGpus = new Set(c.symptoms.map((s) => s.resource_id));
  const jobs = new Map<string, number>();
  for (const a of obs.allocations) if (affectedGpus.has(a.gpu_id)) jobs.set(a.job_id, (jobs.get(a.job_id) ?? 0) + 1);
  for (const [job, n] of [...jobs.entries()].sort()) resources.set(job, `impacted job: allocated on ${n} affected GPU(s)`);
  for (const [id, reason] of resources) out.push(link(id, 'resource', reason));
  return out;
}

// ---------------------------------------------------------------------------
// 3. Nemotron confirmation
// ---------------------------------------------------------------------------

const assessmentItem = z.object({
  candidate_id: z.string().min(1),
  decision: z.enum(['confirm', 'split', 'merge_into']),
  target: z.string().min(1).optional(),
  split_symptom_ids: z.array(z.string()).optional(),
  hypothesis: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  evidence_ids: z.array(z.string()).min(1),
});
const assessmentArgs = z.object({ incidents: z.array(assessmentItem) });
export type AssessmentItem = z.infer<typeof assessmentItem>;

interface LlmPayload {
  json: string;
  allowedEvidence: Set<string>;
}

/** Compact candidate JSON for the model, shrunk until it fits LLM_PAYLOAD_MAX_BYTES. */
export function buildLlmPayload(obs: ObservedSnapshot, candidates: Candidate[], windowSimMs: number): LlmPayload {
  const levels = [
    { perCandidate: Infinity, withEvidence: true },
    { perCandidate: Infinity, withEvidence: false },
    { perCandidate: 8, withEvidence: false },
    { perCandidate: 3, withEvidence: false },
    { perCandidate: 1, withEvidence: false },
  ];
  let last: LlmPayload = { json: '{}', allowedEvidence: new Set() };
  for (const lvl of levels) {
    const allowed = new Set<string>();
    const body = {
      as_of_sim_time_ms: obs.clock.sim_time_ms,
      window_sim_ms: windowSimMs,
      candidates: candidates.map((c) => {
        const shown = c.symptoms.slice(0, lvl.perCandidate);
        const firstPath = c.paths[c.symptoms[0]?.symptom_id ?? ''] ?? [];
        return {
          candidate_id: c.candidate_id,
          family: c.family,
          hypothesized_cause: c.cause_id ? describeCause(obs, c.cause_id) : null,
          example_path: firstPath,
          severity: incidentSeverity(c.symptoms),
          symptom_count: c.symptoms.length,
          kinds: Object.fromEntries(countKinds(c.symptoms)),
          symptoms: shown.map((s) => {
            allowed.add(s.symptom_id);
            if (lvl.withEvidence) for (const e of s.evidence_event_ids) allowed.add(e);
            return lvl.withEvidence
              ? { id: s.symptom_id, kind: s.kind, resource_id: s.resource_id, evidence_ids: s.evidence_event_ids }
              : { id: s.symptom_id, kind: s.kind, resource_id: s.resource_id };
          }),
        };
      }),
    };
    last = { json: JSON.stringify(body), allowedEvidence: allowed };
    if (Buffer.byteLength(last.json, 'utf8') <= LLM_PAYLOAD_MAX_BYTES) return last;
  }
  return last;
}

interface Assessed {
  candidate: Candidate;
  hypothesis: string;
  confidence: number;
  evidence_ids: string[];
  source: 'llm' | 'deterministic';
}

const shortHash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);

function deterministicAssessment(obs: ObservedSnapshot, c: Candidate, why: string): Assessed {
  const ev = [...new Set(c.symptoms.flatMap((s) => [s.symptom_id, ...s.evidence_event_ids]))].slice(0, MAX_DETERMINISTIC_EVIDENCE);
  return {
    candidate: c,
    hypothesis: clip(`${why}: ${deterministicSummary(obs, c)}`, 2000),
    confidence: DETERMINISTIC_CONFIDENCE,
    evidence_ids: ev,
    source: 'deterministic',
  };
}

const shareProvider = (a: Candidate, b: Candidate) => a.provider_ids.some((p) => b.provider_ids.includes(p));

/** Apply validated LLM items to candidates. Returns final assessments + override notes. */
export function applyAssessment(
  obs: ObservedSnapshot,
  candidates: Candidate[],
  items: AssessmentItem[],
  allowedEvidence: Set<string>,
): { assessed: Assessed[]; overrides: string[] } {
  const overrides: string[] = [];
  const byId = new Map(candidates.map((c) => [c.candidate_id, c]));
  const accepted = new Map<string, AssessmentItem>();
  for (const it of items) {
    if (!byId.has(it.candidate_id)) {
      overrides.push(`${it.candidate_id}: unknown candidate_id, ignored`);
      continue;
    }
    if (accepted.has(it.candidate_id)) {
      overrides.push(`${it.candidate_id}: duplicate assessment, ignored`);
      continue;
    }
    const bad = it.evidence_ids.filter((e) => !allowedEvidence.has(e));
    if (bad.length > 0) {
      overrides.push(`${it.candidate_id}: rejected, evidence_ids not in input: ${bad.slice(0, 5).join(', ')}`);
      continue;
    }
    accepted.set(it.candidate_id, it);
  }

  // Merges: only between candidates that share a hosting/cooling provider; one level deep.
  const mergedInto = new Map<string, string>();
  for (const it of accepted.values()) {
    if (it.decision !== 'merge_into') continue;
    const src = byId.get(it.candidate_id);
    const dst = it.target ? byId.get(it.target) : undefined;
    const reject = (why: string) => {
      overrides.push(`${it.candidate_id}: merge_into ${it.target ?? '(none)'} overridden, ${why}`);
      accepted.set(it.candidate_id, { ...it, decision: 'confirm' });
    };
    if (!src || !dst || dst === src) reject('target missing or invalid');
    else if (accepted.get(dst.candidate_id)?.decision === 'merge_into') reject('target is itself merged');
    else if (!shareProvider(src, dst)) reject('no shared provider');
    else mergedInto.set(src.candidate_id, dst.candidate_id);
  }

  const working = new Map(candidates.map((c) => [c.candidate_id, { ...c, symptoms: [...c.symptoms], paths: { ...c.paths } }]));
  for (const [srcId, dstId] of mergedInto) {
    const src = working.get(srcId);
    const dst = working.get(dstId);
    if (!src || !dst) continue;
    const seen = new Set(dst.symptoms.map((s) => s.symptom_id));
    working.set(dstId, {
      ...dst,
      symptoms: [...dst.symptoms, ...src.symptoms.filter((s) => !seen.has(s.symptom_id))],
      paths: { ...src.paths, ...dst.paths },
      provider_ids: [...new Set([...dst.provider_ids, ...src.provider_ids])].sort(),
      opened_sim_ms: Math.min(dst.opened_sim_ms, src.opened_sim_ms),
    });
    working.delete(srcId);
  }

  const assessed: Assessed[] = [];
  for (const c of working.values()) {
    const it = accepted.get(c.candidate_id);
    if (!it) {
      assessed.push(deterministicAssessment(obs, c, 'deterministic grouping (no valid LLM assessment)'));
      continue;
    }
    let main = c;
    if (it.decision === 'split') {
      const ids = new Set(it.split_symptom_ids ?? []);
      const out = c.symptoms.filter((s) => ids.has(s.symptom_id));
      if (out.length === 0 || out.length === c.symptoms.length || out.length !== ids.size) {
        overrides.push(`${c.candidate_id}: split overridden, split_symptom_ids must be a proper subset of the candidate's symptoms`);
      } else {
        main = { ...c, symptoms: c.symptoms.filter((s) => !ids.has(s.symptom_id)) };
        const splitId = `${c.candidate_id}-split-${shortHash([...ids].sort().join(','))}`;
        const part: Candidate = {
          ...c,
          candidate_id: splitId,
          cause_id: null,
          symptoms: out,
          paths: Object.fromEntries(out.map((s) => [s.symptom_id, [s.resource_id]])),
          opened_sim_ms: Math.min(...out.map((s) => s.first_seen_sim_ms)),
        };
        assessed.push(deterministicAssessment(obs, part, `split from ${c.candidate_id} by Nemotron assessment; cause undetermined`));
      }
    }
    assessed.push({
      candidate: main,
      hypothesis: clip(it.hypothesis, MAX_HYPOTHESIS),
      confidence: it.confidence,
      evidence_ids: [...new Set(it.evidence_ids)],
      source: 'llm',
    });
  }
  return { assessed, overrides };
}

interface LlmOutcome {
  items: AssessmentItem[] | null;
  toolCall: ToolCallSummary;
  error: string | null;
}

async function askLlm(deps: TriageDeps, payload: LlmPayload, candidates: Candidate[], maxTokens?: number): Promise<LlmOutcome> {
  const argsSummary = `${candidates.length} candidate(s), ${Buffer.byteLength(payload.json, 'utf8')} B`;
  const fail = (error: string): LlmOutcome => ({
    items: null,
    error,
    toolCall: { tool: TRIAGE_TOOL_NAME, args_summary: argsSummary, result_summary: `fallback to deterministic grouping: ${clip(error, 200)}`, actor: 'code' },
  });
  if (!deps.llm) return fail('no LLM configured');
  const started = deps.now();
  let toolCalls;
  try {
    const res = await deps.llm.chat({
      messages: [
        { role: 'system', content: TRIAGE_SYSTEM_PROMPT },
        { role: 'user', content: buildTriageUserMessage(payload.json) },
      ],
      tools: [TRIAGE_TOOL],
      toolChoice: 'required',
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    });
    toolCalls = res.toolCalls;
  } catch (err) {
    return fail(`LLM unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const call = toolCalls.find((c) => c.name === TRIAGE_TOOL_NAME);
  if (!call) return fail('LLM returned no submit_incident_assessment call');
  let raw: unknown;
  try {
    raw = JSON.parse(call.argumentsJson);
  } catch {
    return fail('LLM tool arguments are not valid JSON');
  }
  const parsed = assessmentArgs.safeParse(raw);
  if (!parsed.success) return fail(`LLM tool arguments failed validation: ${parsed.error.issues.map((i) => i.path.join('.') || i.message).join('; ')}`);
  const decisions = parsed.data.incidents.map((i) => `${i.candidate_id}:${i.decision}`).join(', ');
  return {
    items: parsed.data.incidents,
    error: null,
    toolCall: {
      tool: TRIAGE_TOOL_NAME,
      args_summary: argsSummary,
      result_summary: clip(`${parsed.data.incidents.length} assessment(s) in ${deps.now() - started} ms: ${decisions}`, 500),
      actor: 'nemotron',
    },
  };
}

// ---------------------------------------------------------------------------
// 4. runTriage
// ---------------------------------------------------------------------------

function existingSymptomsFrom(evidence: Evidence): Map<string, { first_seen_sim_ms: number }> {
  const open = new Set(evidence.incidents.filter((i) => i.state !== 'resolved').map((i) => i.incident_id));
  const out = new Map<string, { first_seen_sim_ms: number }>();
  for (const s of evidence.symptoms) out.set(s.symptom_id, { first_seen_sim_ms: s.first_seen_sim_ms });
  for (const l of evidence.links) {
    if (l.link_kind !== 'symptom' || !open.has(l.incident_id) || out.has(l.linked_id)) continue;
    const m = /-b(\d+)$/.exec(l.linked_id);
    if (m) out.set(l.linked_id, { first_seen_sim_ms: Number(m[1]) * SYMPTOM_BUCKET_MS });
  }
  return out;
}

function toIncident(obs: ObservedSnapshot, a: Assessed, existing: Incident | undefined): Incident {
  const c = a.candidate;
  const next = {
    severity: incidentSeverity(c.symptoms),
    title: candidateTitle(obs, c),
    hypothesis: a.hypothesis,
    confidence: a.confidence,
  };
  const now = obs.clock.sim_time_ms;
  if (!existing) {
    return {
      schema_version: V,
      run_id: obs.run_id,
      incident_id: c.candidate_id,
      state: 'open',
      ...next,
      opened_sim_time_ms: Math.min(c.opened_sim_ms, now),
      updated_sim_time_ms: now,
      version: 1,
    };
  }
  const changed =
    existing.severity !== next.severity ||
    existing.title !== next.title ||
    existing.hypothesis !== next.hypothesis ||
    existing.confidence !== next.confidence;
  return {
    ...existing,
    ...next,
    updated_sim_time_ms: changed ? Math.max(now, existing.updated_sim_time_ms) : existing.updated_sim_time_ms,
    version: changed ? existing.version + 1 : existing.version,
  };
}

/** Triage + correlation: extract -> group -> Nemotron confirm -> upsertIncident. Leaves state at `open`. */
export async function runTriage(deps: TriageDeps, opts: TriageOptions = {}): Promise<TriageResult> {
  const log = opts.log ?? (() => {});
  const window = opts.windowSimMs ?? DEFAULT_TRIAGE_WINDOW_MS;
  const toolCalls: ToolCallSummary[] = [];

  const obs = await deps.db.getObservedSnapshot();
  const evidence = await deps.db.getEvidence([], window);
  const signalMap = new Map<string, SignalEvent>();
  for (const s of [...evidence.signals, ...(opts.signals ?? [])]) if (s.run_id === obs.run_id) signalMap.set(s.event_id, s);
  const signals = [...signalMap.values()];
  toolCalls.push({
    tool: 'get_incident_evidence',
    args_summary: `incident_ids=[] window_sim_ms=${window}`,
    result_summary: `${evidence.signals.length} signal(s), ${evidence.telemetry.length} telemetry, ${evidence.incidents.length} incident(s)`,
    actor: 'code',
  });

  const existingIncidents = await deps.db.listIncidents();
  const symptoms = extractSymptoms(obs, signals, { existingSymptoms: existingSymptomsFrom({ ...evidence, incidents: existingIncidents }) });
  const { candidates, unassigned } = groupSymptoms(obs, symptoms, { windowSimMs: window, existingIncidents });
  toolCalls.push({
    tool: 'group_symptoms',
    args_summary: `${symptoms.length} symptom(s), window_sim_ms=${window}`,
    result_summary: `${candidates.length} candidate(s): ${candidates.map((c) => c.candidate_id).join(', ') || 'none'}; ${unassigned.length} unassigned`,
    actor: 'code',
  });

  let assessed: Assessed[];
  let overrides: string[] = [];
  let usedLlm = false;
  if (candidates.length === 0) {
    assessed = [];
  } else {
    const payload = buildLlmPayload(obs, candidates, window);
    const outcome = await askLlm(deps, payload, candidates, opts.maxTokens);
    toolCalls.push(outcome.toolCall);
    if (outcome.items) {
      usedLlm = true;
      ({ assessed, overrides } = applyAssessment(obs, candidates, outcome.items, payload.allowedEvidence));
    } else {
      overrides = [`LLM assessment not used: ${outcome.error ?? 'unknown'}`];
      assessed = candidates.map((c) => deterministicAssessment(obs, c, LLM_UNAVAILABLE_HYPOTHESIS));
    }
  }
  for (const o of overrides) log(`triage: overridden ${o}`);

  if (symptoms.length > 0) {
    await deps.db.upsertSymptoms(symptoms);
    toolCalls.push({
      tool: 'upsert_symptoms',
      args_summary: `${symptoms.length} symptom(s)`,
      result_summary: `persisted ${symptoms.length} symptom(s) before linking incidents`,
      actor: 'code',
    });
  }

  const incidents: Incident[] = [];
  const links: IncidentLink[] = [];
  const evidenceIdsByIncident: Record<string, string[]> = {};
  const llmIncidentIds: string[] = [];
  const existingById = new Map(existingIncidents.map((i) => [i.incident_id, i]));
  for (const a of assessed) {
    const incident = toIncident(obs, a, existingById.get(a.candidate.candidate_id));
    const incLinks = buildLinks(obs, a.candidate);
    const saved = await deps.db.upsertIncident(incident, incLinks);
    incidents.push(saved);
    links.push(...incLinks);
    evidenceIdsByIncident[saved.incident_id] = a.evidence_ids;
    if (a.source === 'llm') llmIncidentIds.push(saved.incident_id);
    toolCalls.push({
      tool: 'upsert_incident',
      args_summary: `${saved.incident_id} (${a.source}), ${incLinks.length} link(s)`,
      result_summary: `v${saved.version} ${saved.state} ${saved.severity}: ${clip(saved.title, 120)}`,
      actor: 'code',
    });
  }

  return { incidents, links, toolCalls, usedLlm, llmIncidentIds, symptoms, unassignedSymptoms: unassigned, overrides, evidenceIdsByIncident };
}

/**
 * F-NV1 diagnose-stage event content (CONTRACTS �0.8). When Nemotron's assessment was used, the summary is its own
 * one-sentence conclusion(s) (the stored hypotheses); otherwise it is clearly labelled deterministic. Never claims
 * `nemotron` when the LLM was not used. Callers pass `{ summary, actor, toolCalls }` straight into `events.emit`.
 */
export function diagnoseEvent(result: TriageResult): { summary: string; actor: 'nemotron' | 'code'; toolCalls: ToolCallSummary[] } {
  const llmIds = new Set(result.llmIncidentIds ?? []);
  const llmHyps = result.usedLlm ? result.incidents.filter((i) => llmIds.has(i.incident_id)).map((i) => i.hypothesis).filter((h): h is string => !!h) : [];
  if (llmHyps.length > 0) return { summary: clip(llmHyps.join(' | '), MAX_HYPOTHESIS), actor: 'nemotron', toolCalls: result.toolCalls };
  const titles = result.incidents.map((i) => i.title).join('; ') || 'no incident candidates';
  return { summary: clip(`deterministic: ${titles}`, MAX_HYPOTHESIS), actor: 'code', toolCalls: result.toolCalls };
}
