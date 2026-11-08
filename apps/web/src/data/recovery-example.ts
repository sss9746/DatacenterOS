import type { MockDbClient } from '@dcos/db-client';
import type { Incident } from '@dcos/contracts';

/** Scripted UI examples only. No model ran; never used by the live client or evaluation. */
export async function loadRecoveryExample(client: MockDbClient) {
  client.loadSnapshot('pump_degraded');
  const snapshot = await client.getObservedSnapshot();
  const time = snapshot.clock.sim_time_ms;
  const base = { schema_version: '1.1.0' as const, run_id: snapshot.run_id, confidence: 0.85, opened_sim_time_ms: time, updated_sim_time_ms: time, version: 1 };
  const incidents: Incident[] = [
    { ...base, incident_id: 'example-cooling', state: 'investigating', severity: 'high', title: 'Cooling degradation on loop A', hypothesis: 'Correlated heat across racks r2–r4 suggests a shared cooling problem.' },
    { ...base, incident_id: 'example-xid', state: 'open', severity: 'critical', title: 'Independent GPU fault on rack r7', hypothesis: 'XID 79 on a candidate destination requires a separate incident and a new placement.' },
  ];
  for (const incident of incidents) {
    const ids = incident.incident_id === 'example-cooling' ? ['pump-a', 'rack-r2', 'rack-r3', 'rack-r4'] : ['gpu-r7-n1-0'];
    await client.upsertIncident(incident, ids.map((id) => ({ schema_version: '1.1.0', run_id: snapshot.run_id, incident_id: incident.incident_id, linked_id: id, link_kind: 'resource', reason: 'Scripted recovery example' })));
  }
  await client.injectFault({ schema_version: '1.1.0', run_id: snapshot.run_id, fault_id: 'example-fault-xid', target_resource_id: 'gpu-r7-n1-0', kind: 'gpu_xid_79', start_sim_time_ms: time, duration_sim_ms: null, severity: 1, parameters: {}, seed_offset: 0 });
  const events = [
    { stage: 'diagnose' as const, actor: 'nemotron' as const, incident_id: 'example-cooling', summary: 'Example: group the cooling symptoms on racks r2–r4 into one incident.', tool: 'get_incident_evidence', args_summary: 'incident_ids: [example-cooling]', result_summary: 'Example evidence: shared loop A and reduced pump capacity.' },
    { stage: 'safety' as const, actor: 'code' as const, incident_id: 'example-cooling', summary: 'Example: a proposed placement must pass a fresh thermal-headroom check.', tool: 'evaluate_safety', args_summary: 'destination: rack-r6', result_summary: 'Illustrative denial: DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT. No safety engine ran in this preview.' },
    { stage: 'replan' as const, actor: 'nemotron' as const, incident_id: 'example-xid', summary: 'Example: keep the XID incident separate and reconsider the destination.', tool: 'list_placement_candidates', args_summary: 'job_id: job-a', result_summary: 'Example: exclude gpu-r7-n1-0 from the next placement.' },
  ];
  for (const [index, ev] of events.entries()) {
    await client.publishAgentEvent({ agent_event_id: `example-event-${index}`, run_id: snapshot.run_id, workflow_id: 'example-workflow', incident_id: ev.incident_id, stage: ev.stage, actor: ev.actor, summary: ev.summary, evidence_ids: [], tool_calls: [{ tool: ev.tool, args_summary: ev.args_summary, result_summary: ev.result_summary, actor: ev.actor }], sim_time_ms: time, observed_unix_ms: Date.now() });
  }
}
