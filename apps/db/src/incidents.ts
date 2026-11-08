// Incidents, symptoms, plans and the F-NV1 agent feed (P2-6). All agent role.
//
//   upsert_incident(incident_json, links_json)   Incident + IncidentLink[] (validatePayload);
//                                                links merged, never duplicated
//   upsert_symptoms(symptoms_json)               SymptomRecord[] (§0.11 #10); first_seen preserved
//   submit_plan(plan_json)                       PlanCandidate; a proposal only, never executes
//   publish_agent_event(agent_event_json)        AgentEventInput (F-NV1, §0.8): one-line summary +
//                                                tool-call summaries; strict fields, no raw reasoning
//
// SymptomRecord and AgentEventInput aren't wire types (they're db-client types matching P3's
// ports.ts), so they're checked by hand here.
import { t } from 'spacetimedb/server';
import { validatePayload, type Incident, type IncidentLink, type PlanCandidate } from '@dcos/contracts';
import spacetimedb, { type Ctx } from './schema';
import { reject, requireRole } from './auth';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const AGENT_STAGES = ['triage', 'diagnose', 'plan', 'safety', 'execute', 'replan', 'verify'] as const;
const ACTORS = ['nemotron', 'code'] as const;
const SYMPTOM_SEVERITIES = ['info', 'warning', 'critical'] as const;
const MAX_SUMMARY = 1000;
const MAX_TOOL_FIELD = 500;
const MAX_TOOL_CALLS = 50;

function parseJson(field: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    reject('INVALID_PAYLOAD', `${field} is not valid JSON`);
  }
}

function requireRun(ctx: Ctx, runId: string): void {
  if (!ctx.db.run.run_id.find(runId)) reject('NOT_FOUND', `run ${runId} does not exist`);
}

// --- tiny hand checks for the two non-wire types ------------------------------------------------

type Shape = Record<string, (v: unknown) => boolean>;
const isId = (v: unknown) => typeof v === 'string' && v.length <= 128 && ID_RE.test(v);
const isIdOrNull = (v: unknown) => v === null || isId(v);
const isNat = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isStr = (max: number) => (v: unknown) => typeof v === 'string' && v.length <= max;
const isOneOf = (xs: readonly string[]) => (v: unknown) => typeof v === 'string' && xs.includes(v);
const isIdList = (v: unknown) => Array.isArray(v) && v.length <= 500 && v.every(isId);

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Every required key valid, optional keys valid when present, no other keys. Own properties only
 * (`in` would accept inherited names like `constructor` / `__proto__`). Returns a fresh object with
 * exactly the validated keys, so nothing unchecked can be stored.
 */
function checkShape(what: string, v: unknown, required: Shape, optional: Shape = {}): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) reject('INVALID_PAYLOAD', `${what} must be an object`);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!own(required, k) && !own(optional, k)) reject('INVALID_PAYLOAD', `${what}: unknown field ${k}`);
  }
  const out: Record<string, unknown> = {};
  for (const [k, ok] of Object.entries(required)) {
    if (!own(o, k) || !ok(o[k])) reject('INVALID_PAYLOAD', `${what}: ${k} is missing or invalid`);
    out[k] = o[k];
  }
  for (const [k, ok] of Object.entries(optional)) {
    if (!own(o, k) || o[k] === undefined) continue;
    if (!ok(o[k])) reject('INVALID_PAYLOAD', `${what}: ${k} is invalid`);
    out[k] = o[k];
  }
  return out;
}

// --- reducers ----------------------------------------------------------------------------------

export const upsert_incident = spacetimedb.reducer(
  { incident_json: t.string(), links_json: t.string() },
  (ctx, { incident_json, links_json }) => {
    requireRole(ctx, 'agent');
    const incident = parseJson('incident_json', incident_json);
    const vi = validatePayload('Incident', incident);
    if (!vi.ok) reject('INVALID_PAYLOAD', `Incident: ${vi.errors.slice(0, 5).join('; ')}`);
    const inc = incident as Incident;
    const links = parseJson('links_json', links_json);
    if (!Array.isArray(links)) reject('INVALID_PAYLOAD', 'links_json must be a JSON array');
    for (const [i, l] of links.entries()) {
      const vl = validatePayload('IncidentLink', l);
      if (!vl.ok) reject('INVALID_PAYLOAD', `links[${i}]: ${vl.errors.slice(0, 3).join('; ')}`);
      const link = l as IncidentLink;
      if (link.incident_id !== inc.incident_id || link.run_id !== inc.run_id) {
        reject('INVALID_PAYLOAD', `links[${i}] belongs to ${link.run_id}/${link.incident_id}, not ${inc.run_id}/${inc.incident_id}`);
      }
    }
    requireRun(ctx, inc.run_id);

    const row = {
      incident_id: inc.incident_id,
      run_id: inc.run_id,
      state: inc.state,
      severity: inc.severity,
      title: inc.title,
      hypothesis: inc.hypothesis ?? undefined,
      confidence: inc.confidence,
      opened_sim_time_ms: inc.opened_sim_time_ms,
      updated_sim_time_ms: inc.updated_sim_time_ms,
      version: inc.version,
    };
    if (ctx.db.incident.incident_id.find(inc.incident_id)) ctx.db.incident.incident_id.update(row);
    else ctx.db.incident.insert(row);

    // Links merge; an existing (incident, linked_id, kind) keeps its first row (same as the mock).
    for (const l of links as IncidentLink[]) {
      if (l.link_kind === 'symptom') {
        const link_id = `${l.incident_id}/${l.linked_id}`;
        if (!ctx.db.incident_symptom.link_id.find(link_id)) {
          ctx.db.incident_symptom.insert({ link_id, run_id: l.run_id, incident_id: l.incident_id, symptom_id: l.linked_id, reason: l.reason });
        }
      } else if (l.link_kind === 'resource') {
        const link_id = `${l.incident_id}/${l.linked_id}`;
        if (!ctx.db.incident_resource.link_id.find(link_id)) {
          ctx.db.incident_resource.insert({ link_id, run_id: l.run_id, incident_id: l.incident_id, resource_id: l.linked_id, reason: l.reason });
        }
      } else {
        const link_id = `${l.linked_id}/${l.incident_id}`; // workflow_incident key: workflow/incident
        if (!ctx.db.workflow_incident.link_id.find(link_id)) {
          ctx.db.workflow_incident.insert({ link_id, run_id: l.run_id, workflow_id: l.linked_id, incident_id: l.incident_id });
        }
      }
    }
  }
);

/** upsert_symptoms(symptoms_json): idempotent by symptom_id; first_seen_sim_ms is preserved. */
export const upsert_symptoms = spacetimedb.reducer({ symptoms_json: t.string() }, (ctx, { symptoms_json }) => {
  requireRole(ctx, 'agent');
  const list = parseJson('symptoms_json', symptoms_json);
  if (!Array.isArray(list) || list.length > 500) reject('INVALID_PAYLOAD', 'symptoms_json must be an array (≤ 500)');
  const rows = list.map((s, i) =>
    checkShape(`symptoms[${i}]`, s, {
      symptom_id: isId,
      run_id: isId,
      resource_id: isId,
      first_seen_sim_ms: isNat,
      last_seen_sim_ms: isNat,
      kind: isStr(64),
      severity: isOneOf(SYMPTOM_SEVERITIES),
      evidence_event_ids: isIdList,
      status: isStr(32),
    })
  );
  for (const s of rows) {
    requireRun(ctx, s.run_id as string);
    const prev = ctx.db.symptom.symptom_id.find(s.symptom_id as string);
    const row = {
      symptom_id: s.symptom_id as string,
      run_id: s.run_id as string,
      resource_id: s.resource_id as string,
      first_seen_sim_ms: prev?.first_seen_sim_ms ?? (s.first_seen_sim_ms as number),
      last_seen_sim_ms: s.last_seen_sim_ms as number,
      kind: s.kind as string,
      severity: s.severity as string,
      evidence_event_ids_json: JSON.stringify(s.evidence_event_ids),
      status: s.status as string,
    };
    if (prev) ctx.db.symptom.symptom_id.update(row);
    else ctx.db.symptom.insert(row);
  }
});

/** submit_plan(plan_json): stores the proposal (status `proposed`); never executes anything. */
export const submit_plan = spacetimedb.reducer({ plan_json: t.string() }, (ctx, { plan_json }) => {
  requireRole(ctx, 'agent');
  const plan = parseJson('plan_json', plan_json);
  const v = validatePayload('PlanCandidate', plan);
  if (!v.ok) reject('INVALID_PAYLOAD', `PlanCandidate: ${v.errors.slice(0, 5).join('; ')}`);
  const p = plan as PlanCandidate;
  requireRun(ctx, p.run_id);
  const row = {
    plan_id: p.plan_id,
    run_id: p.run_id,
    workflow_id: p.workflow_id,
    based_on_decision_epoch: p.based_on_decision_epoch,
    incident_ids_json: JSON.stringify(p.incident_ids),
    command_keys_json: JSON.stringify(p.command_keys),
    assumptions_json: JSON.stringify(p.assumptions),
    expected_metrics_json: JSON.stringify({
      expected_completion_delay_sim_s: p.expected_completion_delay_sim_s,
      expected_lost_work_units: p.expected_lost_work_units,
      expected_gpu_busy_waste_s: p.expected_gpu_busy_waste_s,
      failure_risk_estimate: p.failure_risk_estimate,
    }),
    status: 'proposed',
    explanation: p.explanation,
  };
  if (ctx.db.plan.plan_id.find(p.plan_id)) ctx.db.plan.plan_id.update(row);
  else ctx.db.plan.insert(row);
});

/**
 * publish_agent_event(agent_event_json): one F-NV1 feed row. Idempotent by agent_event_id (a repeat
 * is a no-op). `actor` defaults to `code` so nothing is mislabelled as model output.
 */
export const publish_agent_event = spacetimedb.reducer({ agent_event_json: t.string() }, (ctx, { agent_event_json }) => {
  requireRole(ctx, 'agent');
  const ev = checkShape(
    'agent_event',
    parseJson('agent_event_json', agent_event_json),
    {
      agent_event_id: isId,
      run_id: isId,
      workflow_id: isIdOrNull,
      incident_id: isIdOrNull,
      stage: isOneOf(AGENT_STAGES),
      summary: isStr(MAX_SUMMARY),
      evidence_ids: isIdList,
      tool_calls: (v) => Array.isArray(v) && v.length <= MAX_TOOL_CALLS,
      sim_time_ms: isNat,
      observed_unix_ms: isNat,
    },
    { actor: isOneOf(ACTORS) }
  );
  const toolCalls = (ev.tool_calls as unknown[]).map((tc, i) =>
    checkShape(
      `tool_calls[${i}]`,
      tc,
      { tool: isStr(64), args_summary: isStr(MAX_TOOL_FIELD), result_summary: isStr(MAX_TOOL_FIELD) },
      { actor: isOneOf(ACTORS) }
    )
  );
  requireRun(ctx, ev.run_id as string);
  if (ctx.db.agent_event.agent_event_id.find(ev.agent_event_id as string)) return;
  ctx.db.agent_event.insert({
    agent_event_id: ev.agent_event_id as string,
    run_id: ev.run_id as string,
    workflow_id: (ev.workflow_id as string | null) ?? undefined,
    incident_id: (ev.incident_id as string | null) ?? undefined,
    stage: ev.stage as string,
    summary: ev.summary as string,
    evidence_ids_json: JSON.stringify(ev.evidence_ids),
    tool_calls_json: JSON.stringify(toolCalls),
    actor: (ev.actor as string | undefined) ?? 'code',
    sim_time_ms: ev.sim_time_ms as number,
    observed_unix_ms: ev.observed_unix_ms as number,
  });
});
