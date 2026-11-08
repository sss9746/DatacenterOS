// get_incident_evidence: bounded evidence bundle (<= ~6 KB serialized) with evidence IDs.

import { z } from 'zod';
import type { Evidence } from '../ports.js';
import { clipSummary, type ToolSpec } from './types.js';

export const EVIDENCE_MAX_BYTES = 6000;
export const EVIDENCE_MAX_WINDOW_MS = 600_000;
const DEFAULT_WINDOW_MS = 300_000;

const argsSchema = z.object({
  incident_ids: z
    .array(z.string().min(1))
    .max(10)
    .describe('Incident IDs to fetch evidence for. An empty array returns recent run-wide evidence.'),
  window_sim_ms: z
    .number()
    .int()
    .positive()
    .max(EVIDENCE_MAX_WINDOW_MS)
    .optional()
    .describe(`Look-back window in simulated ms (max ${EVIDENCE_MAX_WINDOW_MS}, default ${DEFAULT_WINDOW_MS}).`),
});

interface Bounded {
  run_id: string;
  as_of_sim_time_ms: number;
  window_sim_ms: number;
  incidents: unknown[];
  links: unknown[];
  symptoms: unknown[];
  signals: unknown[];
  telemetry: unknown[];
  /** Event/symptom IDs that can be cited as evidence_ids. */
  evidence_ids: string[];
  omitted: Record<string, number>;
}

const LIST_CAPS = { incidents: 10, links: 40, symptoms: 20, signals: 20, telemetry: 30 } as const;
type ListName = keyof typeof LIST_CAPS;
/** Trim order when the payload is still too large: least valuable first. */
const SHRINK_ORDER: ListName[] = ['telemetry', 'links', 'symptoms', 'signals', 'incidents'];

const newestFirst = <T extends { sim_time_ms: number }>(xs: T[]): T[] => [...xs].sort((a, b) => b.sim_time_ms - a.sim_time_ms);

/** Latest sample per (resource, metric) first, so every signal source is represented; then the rest by recency. */
function pickTelemetry(ev: Evidence): Evidence['telemetry'] {
  const sorted = newestFirst(ev.telemetry);
  const seen = new Set<string>();
  const first: typeof sorted = [];
  const rest: typeof sorted = [];
  for (const t of sorted) {
    const k = `${t.resource_id}|${t.metric}`;
    if (seen.has(k)) rest.push(t);
    else {
      seen.add(k);
      first.push(t);
    }
  }
  return [...first, ...rest];
}

export function boundEvidence(ev: Evidence, maxBytes = EVIDENCE_MAX_BYTES): Bounded {
  const full = {
    incidents: ev.incidents.map((i) => ({
      incident_id: i.incident_id,
      state: i.state,
      severity: i.severity,
      title: i.title,
      hypothesis: i.hypothesis,
      confidence: i.confidence,
    })),
    links: ev.links.map((l) => ({ incident_id: l.incident_id, linked_id: l.linked_id, kind: l.link_kind })),
    symptoms: [...ev.symptoms]
      .sort((a, b) => b.last_seen_sim_ms - a.last_seen_sim_ms)
      .map((s) => ({
        symptom_id: s.symptom_id,
        resource_id: s.resource_id,
        kind: s.kind,
        severity: s.severity,
        last_seen_sim_ms: s.last_seen_sim_ms,
        evidence_event_ids: s.evidence_event_ids.slice(0, 5),
      })),
    signals: newestFirst(ev.signals).map((s) => ({
      event_id: s.event_id,
      resource_id: s.resource_id,
      event_type: s.event_type,
      xid_code: s.xid_code,
      severity: s.severity,
      sim_time_ms: s.sim_time_ms,
    })),
    telemetry: pickTelemetry(ev).map((t) => ({
      event_id: t.event_id,
      resource_id: t.resource_id,
      metric: t.metric,
      value: t.value,
      quality: t.quality,
      sim_time_ms: t.sim_time_ms,
    })),
  };
  const counts: Record<ListName, number> = {
    incidents: Math.min(full.incidents.length, LIST_CAPS.incidents),
    links: Math.min(full.links.length, LIST_CAPS.links),
    symptoms: Math.min(full.symptoms.length, LIST_CAPS.symptoms),
    signals: Math.min(full.signals.length, LIST_CAPS.signals),
    telemetry: Math.min(full.telemetry.length, LIST_CAPS.telemetry),
  };

  const assemble = (): Bounded => {
    const signals = full.signals.slice(0, counts.signals);
    const telemetry = full.telemetry.slice(0, counts.telemetry);
    const symptoms = full.symptoms.slice(0, counts.symptoms);
    const evidence_ids = [
      ...signals.map((s) => s.event_id),
      ...symptoms.map((s) => s.symptom_id),
      ...telemetry.map((t) => t.event_id),
    ].slice(0, 40);
    const omitted: Record<string, number> = {};
    for (const name of Object.keys(LIST_CAPS) as ListName[]) {
      const dropped = full[name].length - counts[name];
      if (dropped > 0) omitted[name] = dropped;
    }
    return {
      run_id: ev.run_id,
      as_of_sim_time_ms: ev.as_of_sim_time_ms,
      window_sim_ms: ev.window_sim_ms,
      incidents: full.incidents.slice(0, counts.incidents),
      links: full.links.slice(0, counts.links),
      symptoms,
      signals,
      telemetry,
      evidence_ids,
      omitted,
    };
  };

  let out = assemble();
  for (let guard = 0; guard < 200 && JSON.stringify(out).length > maxBytes; guard++) {
    const name = SHRINK_ORDER.find((n) => counts[n] > 0);
    if (!name) break;
    // Shrink the first non-empty list in priority order by ~25% (at least 1) until the payload fits.
    counts[name] = Math.max(0, counts[name] - Math.max(1, Math.ceil(counts[name] * 0.25)));
    out = assemble();
  }
  return out;
}

export const getIncidentEvidenceTool: ToolSpec<z.infer<typeof argsSchema>> = {
  name: 'get_incident_evidence',
  description:
    'Fetch bounded, evidence-ID-tagged incident evidence (incidents, links, symptoms, signals such as Xid events, and recent telemetry) ' +
    'for the given incidents over a simulated-time window. Use the returned IDs as evidence_ids when citing. Read-only.',
  schema: argsSchema,
  async run(args, { db }) {
    const window = args.window_sim_ms ?? DEFAULT_WINDOW_MS;
    const ev = await db.getEvidence(args.incident_ids, window);
    const data = boundEvidence(ev);
    const omitted = Object.values(data.omitted).reduce((a, b) => a + b, 0);
    const summary = clipSummary(
      `get_incident_evidence(${args.incident_ids.join(',') || 'run-wide'}, ${window / 1000}s): ` +
        `${data.incidents.length} incidents, ${data.signals.length} signals, ${data.telemetry.length} telemetry, ` +
        `${data.symptoms.length} symptoms${omitted > 0 ? ` (+${omitted} omitted)` : ''}`,
    );
    return { data, summary };
  },
};
