import { describe, expect, it } from 'vitest';
import { validatePayload, type ObservedSnapshot } from '@dcos/contracts';
import type { LlmChatRequest } from '../src/ports.js';
import { diagnoseEvent } from '../src/triage.js';
import {
  DETERMINISTIC_CONFIDENCE,
  LLM_PAYLOAD_MAX_BYTES,
  LLM_UNAVAILABLE_HYPOTHESIS,
  extractSymptoms,
  groupSymptoms,
  runTriage,
  type TriageResult,
} from '../src/triage.js';
import { TRIAGE_TOOL_NAME } from '../src/prompts/triage.js';
import { FakeDb, FakeLlm } from './fakes/index.js';
import { THERMAL_THROTTLE_BIT, loadPumpDegradedSnapshot, loadSignalXid79Dest, loadSignalXid79R7 } from './fixtures/index.js';

const PUMP_INC = 'inc-thermal-pump-a-b1';
const R7_INC = 'inc-compute-gpu-r7-n1-3-b1';
const R8_INC = 'inc-compute-gpu-r8-n1-0-b1';

const rackOf = (gpu: string) => gpu.replace(/^gpu-(r\d)-n1-\d$/, 'rack-$1');
const now = () => 1_794_091_200_000;

interface PayloadCandidate {
  candidate_id: string;
  symptoms: { id: string; evidence_ids?: string[] }[];
}
const payloadOf = (req: LlmChatRequest): { candidates: PayloadCandidate[] } => {
  const user = req.messages.find((m) => m.role === 'user');
  const text = user && 'content' in user && typeof user.content === 'string' ? user.content : '';
  return JSON.parse(text.slice(text.indexOf('\n') + 1));
};

/** FakeLlm step that confirms every candidate, citing its first symptom id. */
const confirmAll = (overrides: Record<string, Record<string, unknown>> = {}) => (req: LlmChatRequest) =>
  FakeLlm.toolCall(TRIAGE_TOOL_NAME, {
    incidents: payloadOf(req).candidates.map((c) => ({
      candidate_id: c.candidate_id,
      decision: 'confirm',
      hypothesis: `LLM: ${c.candidate_id}`,
      confidence: 0.9,
      evidence_ids: [c.symptoms[0]!.id],
      ...overrides[c.candidate_id],
    })),
  });

function setup(signals: ('r7' | 'r8')[] = []) {
  const db = new FakeDb({ snapshot: loadPumpDegradedSnapshot() });
  for (const s of signals) db.injectSignal(s === 'r7' ? loadSignalXid79R7() : loadSignalXid79Dest());
  return db;
}

const linksOf = (r: TriageResult, id: string) => r.links.filter((l) => l.incident_id === id);
const ids = (r: TriageResult) => r.incidents.map((i) => i.incident_id).sort();

function expectWireValid(r: TriageResult) {
  for (const i of r.incidents) expect(validatePayload('Incident', i)).toEqual({ ok: true });
  for (const l of r.links) expect(validatePayload('IncidentLink', l)).toEqual({ ok: true });
}

describe('extractSymptoms', () => {
  it('finds throttle, near-throttle and cooling symptoms on the pump-degraded fixture', () => {
    const s = extractSymptoms(loadPumpDegradedSnapshot(), []);
    const kinds = (k: string) => s.filter((x) => x.kind === k).map((x) => x.resource_id);
    expect(kinds('thermal_throttle')).toHaveLength(21);
    expect(new Set(kinds('thermal_throttle').map(rackOf))).toEqual(new Set(['rack-r2', 'rack-r3', 'rack-r4']));
    // 3x 84.2 °C on r2–r4 + the 83.0 °C GPU on r6 (job-c heat).
    expect(kinds('near_throttle').map(rackOf).sort()).toEqual(['rack-r2', 'rack-r3', 'rack-r4', 'rack-r6']);
    expect(kinds('cooling_degraded').sort()).toEqual(['loop-a', 'pump-a']);
    expect(s.find((x) => x.resource_id === 'pump-a')!.evidence_event_ids).toContain('sig-pump-a-alarm-1');
  });

  it('uses the clocks_event_reasons thermal bit even below 85 °C, and flags stale telemetry', () => {
    const obs: ObservedSnapshot = loadPumpDegradedSnapshot();
    const g = obs.gpus.find((x) => x.resource_id === 'gpu-r1-n1-0')!;
    g.clocks_event_reasons = THERMAL_THROTTLE_BIT;
    const stale = obs.gpus.find((x) => x.resource_id === 'gpu-r5-n1-0')!;
    stale.last_seen_sim_ms = obs.clock.sim_time_ms - 120_000;
    const s = extractSymptoms(obs, []);
    expect(s.some((x) => x.kind === 'thermal_throttle' && x.resource_id === 'gpu-r1-n1-0')).toBe(true);
    expect(s.some((x) => x.kind === 'stale_telemetry' && x.resource_id === 'gpu-r5-n1-0')).toBe(true);
  });

  it('XID from a signal and from the snapshot produce the same stable symptom id', async () => {
    const obs = await setup(['r7']).getObservedSnapshot();
    const fromSnap = extractSymptoms(obs, []).find((x) => x.kind === 'gpu_xid')!;
    const fromSig = extractSymptoms(obs, [loadSignalXid79R7()]).find((x) => x.kind === 'gpu_xid')!;
    expect(fromSnap.symptom_id).toBe('sym-gpu_xid-gpu-r7-n1-3-b1');
    expect(fromSig.symptom_id).toBe(fromSnap.symptom_id);
    expect(fromSig.evidence_event_ids).toContain('sig-xid79-gpu-r7-n1-3-560000');
    expect(extractSymptoms(obs, []).some((x) => x.kind === 'gpu_unavailable')).toBe(false);
  });
});

describe('groupSymptoms', () => {
  it('groups r2–r4 GPUs + pump-a + loop-a under pump-a; r6 near-throttle stays unassigned', () => {
    const obs = loadPumpDegradedSnapshot();
    const { candidates, unassigned } = groupSymptoms(obs, extractSymptoms(obs, []));
    expect(candidates.map((c) => c.candidate_id)).toEqual([PUMP_INC]);
    expect(candidates[0]!.cause_id).toBe('pump-a');
    expect(candidates[0]!.paths['sym-thermal_throttle-gpu-r2-n1-0-b1']).toEqual(['gpu-r2-n1-0', 'node-r2-n1', 'rack-r2', 'loop-a', 'pump-a']);
    expect(unassigned.map((s) => s.resource_id)).toEqual([expect.stringMatching(/^gpu-r6-/)]);
  });

  it('does not merge symptoms on the same provider when they are outside the time window', () => {
    const obs = loadPumpDegradedSnapshot();
    const symptoms = extractSymptoms(obs, []).map((s) =>
      s.resource_id.startsWith('gpu-r4-') ? { ...s, first_seen_sim_ms: s.first_seen_sim_ms + 900_000 } : s,
    );
    const { candidates } = groupSymptoms(obs, symptoms, { windowSimMs: 600_000 });
    expect(candidates).toHaveLength(2);
  });
});

describe('runTriage', () => {
  it('pump_degraded -> exactly 1 incident hypothesizing pump-a/loop-a with the r2–r4 GPUs linked', async () => {
    const db = setup();
    const llm = new FakeLlm([confirmAll()]);
    const r = await runTriage({ db, llm, now });

    expect(ids(r)).toEqual([PUMP_INC]);
    expect(r.usedLlm).toBe(true);
    const inc = r.incidents[0]!;
    expect(inc.state).toBe('open');
    expect(inc.hypothesis).toBe(`LLM: ${PUMP_INC}`);
    expect(inc.title).toContain('pump-a');
    const l = linksOf(r, PUMP_INC);
    const res = (id: string) => l.find((x) => x.link_kind === 'resource' && x.linked_id === id);
    expect(res('pump-a')!.reason).toMatch(/hypothesized cause/);
    expect(res('loop-a')).toBeDefined();
    const throttledGpus = loadPumpDegradedSnapshot().gpus.filter((g) => (g.clocks_event_reasons & THERMAL_THROTTLE_BIT) !== 0);
    expect(throttledGpus).toHaveLength(21);
    for (const g of throttledGpus) expect(res(g.resource_id)).toBeDefined();
    const linkedGpus = l.filter((x) => x.link_kind === 'resource' && x.linked_id.startsWith('gpu-')).map((x) => x.linked_id);
    expect(linkedGpus).toHaveLength(24);
    expect(new Set(linkedGpus.map(rackOf))).toEqual(new Set(['rack-r2', 'rack-r3', 'rack-r4']));
    expect(res('job-a')).toBeDefined();
    expect(res('job-b')).toBeDefined();
    expectWireValid(r);
    expect(db.incidents.size).toBe(1);

    const req = llm.requests[0]!;
    expect(req.toolChoice).toBe('required');
    expect(req.tools?.map((t) => t.name)).toEqual([TRIAGE_TOOL_NAME]);
    const sys = req.messages[0]!;
    expect(sys.role).toBe('system');
    expect('content' in sys && sys.content).toMatch(/evidence_ids/);
    expect('content' in sys && sys.content).toMatch(/needs_approval/);
    expect(Buffer.byteLength(JSON.stringify(payloadOf(req)), 'utf8')).toBeLessThanOrEqual(LLM_PAYLOAD_MAX_BYTES);
    expect(r.toolCalls.map((t) => t.tool)).toEqual(['get_incident_evidence', 'group_symptoms', TRIAGE_TOOL_NAME, 'upsert_symptoms', 'upsert_incident']);
    expect(r.evidenceIdsByIncident[PUMP_INC]).toEqual(['sym-cooling_degraded-loop-a-b1']);
  });

  it('+ XID 79 on r7 -> exactly 2 incidents, the XID one separate from the cooling incident', async () => {
    const db = setup(['r7']);
    const r = await runTriage({ db, llm: new FakeLlm([confirmAll()]), now });
    expect(ids(r)).toEqual([R7_INC, PUMP_INC].sort());
    const xid = r.incidents.find((i) => i.incident_id === R7_INC)!;
    expect(xid.severity).toBe('critical');
    expect(xid.title).toBe('XID 79 on gpu-r7-n1-3');
    const xl = linksOf(r, R7_INC);
    expect(xl.some((l) => l.linked_id === 'gpu-r7-n1-3')).toBe(true);
    expect(xl.some((l) => l.linked_id === 'pump-a' || l.linked_id === 'loop-a')).toBe(false);
    expect(linksOf(r, PUMP_INC).some((l) => l.linked_id === 'gpu-r7-n1-3')).toBe(false);
    expectWireValid(r);
  });

  it('+ XID 79 on r8 (destination) too -> a third, separate incident; signals passed via opts are used', async () => {
    const db = setup(['r7', 'r8']);
    const r = await runTriage({ db, llm: new FakeLlm([confirmAll()]), now }, { signals: [loadSignalXid79R7(), loadSignalXid79Dest()] });
    expect(ids(r)).toEqual([R7_INC, R8_INC, PUMP_INC].sort());
    const r8sym = r.symptoms.find((s) => s.kind === 'gpu_xid' && s.resource_id === 'gpu-r8-n1-0')!;
    expect(r8sym.evidence_event_ids).toContain('sig-xid79-gpu-r8-n1-0-555000');
    expectWireValid(r);
  });

  it('persists all extracted symptoms before incidents and stays idempotent on rerun', async () => {
    const db = setup(['r7']);
    const first = await runTriage({ db, llm: null, now });
    expect(first.symptoms.length).toBeGreaterThan(0);
    expect(db.symptoms.size).toBe(first.symptoms.length);
    expect([...db.symptoms.keys()].sort()).toEqual(first.symptoms.map((s) => s.symptom_id).sort());
    expect(first.toolCalls.map((t) => t.tool)).toContain('upsert_symptoms');
    const calls = db.calls.map((c) => c.method);
    expect(calls.indexOf('upsertSymptoms')).toBeLessThan(calls.indexOf('upsertIncident'));
    await runTriage({ db, llm: null, now });
    expect(db.symptoms.size).toBe(first.symptoms.length);
  });

  it('is idempotent: a rerun keeps the same incident ids, versions and links', async () => {
    const db = setup(['r7']);
    const first = await runTriage({ db, llm: null, now });
    const linkCount = db.links.length;
    const second = await runTriage({ db, llm: null, now });
    expect(ids(second)).toEqual(ids(first));
    expect(db.incidents.size).toBe(2);
    expect(db.links.length).toBe(linkCount);
    expect(second.incidents.map((i) => i.version)).toEqual(first.incidents.map((i) => i.version));

    // A later rerun (sim time advanced, new LLM hypothesis) updates in place.
    db.tick(20_000); // < STALE_TELEMETRY_MS: FakeDb.tick does not refresh gpu last_seen_sim_ms
    const third = await runTriage({ db, llm: new FakeLlm([confirmAll()]), now });
    expect(ids(third)).toEqual(ids(first));
    expect(db.incidents.size).toBe(2);
    const pump = third.incidents.find((i) => i.incident_id === PUMP_INC)!;
    expect(pump.version).toBe(2);
    expect(pump.opened_sim_time_ms).toBe(first.incidents.find((i) => i.incident_id === PUMP_INC)!.opened_sim_time_ms);
    expect(third.symptoms.map((s) => s.symptom_id)).toEqual(first.symptoms.map((s) => s.symptom_id));
  });

  it('overrides an LLM merge of candidates with no shared provider (r7 XID into the pump incident)', async () => {
    const db = setup(['r7']);
    const log: string[] = [];
    const llm = new FakeLlm([confirmAll({ [R7_INC]: { decision: 'merge_into', target: PUMP_INC } })]);
    const r = await runTriage({ db, llm, now }, { log: (m) => log.push(m) });
    expect(ids(r)).toEqual([R7_INC, PUMP_INC].sort());
    expect(r.overrides).toEqual([expect.stringMatching(new RegExp(`${R7_INC}: merge_into ${PUMP_INC} overridden, no shared provider`))]);
    expect(log.some((m) => m.includes('overridden'))).toBe(true);
    expect(r.incidents.find((i) => i.incident_id === R7_INC)!.hypothesis).toBe(`LLM: ${R7_INC}`);
  });

  it('accepts a merge of candidates that share a provider (r7 + r8 share loop-b/pump-b)', async () => {
    const db = setup(['r7', 'r8']);
    const llm = new FakeLlm([confirmAll({ [R7_INC]: { decision: 'merge_into', target: R8_INC } })]);
    const r = await runTriage({ db, llm, now });
    expect(ids(r)).toEqual([R8_INC, PUMP_INC].sort());
    const r8links = linksOf(r, R8_INC).map((l) => l.linked_id);
    expect(r8links).toEqual(expect.arrayContaining(['gpu-r7-n1-3', 'gpu-r8-n1-0']));
    expect(r.overrides).toEqual([]);
  });

  it('applies a valid split and overrides an invalid one', async () => {
    const db = setup();
    const split = ['sym-near_throttle-gpu-r2-n1-6-b1'];
    const llm = new FakeLlm([confirmAll({ [PUMP_INC]: { decision: 'split', split_symptom_ids: split } })]);
    const r = await runTriage({ db, llm, now });
    expect(r.incidents).toHaveLength(2);
    const part = r.incidents.find((i) => i.incident_id.startsWith(`${PUMP_INC}-split-`))!;
    expect(linksOf(r, part.incident_id).filter((l) => l.link_kind === 'symptom').map((l) => l.linked_id)).toEqual(split);
    expect(linksOf(r, PUMP_INC).some((l) => l.linked_id === split[0])).toBe(false);
    expectWireValid(r);

    const db2 = setup();
    const bad = new FakeLlm([confirmAll({ [PUMP_INC]: { decision: 'split', split_symptom_ids: ['sym-nope'] } })]);
    const r2 = await runTriage({ db: db2, llm: bad, now });
    expect(ids(r2)).toEqual([PUMP_INC]);
    expect(r2.overrides[0]).toMatch(/split overridden/);
  });

  it('falls back to deterministic candidates when the LLM is down', async () => {
    const db = setup(['r7']);
    const r = await runTriage({ db, llm: new FakeLlm([new Error('503 upstream')]), now });
    expect(r.usedLlm).toBe(false);
    expect(ids(r)).toEqual([R7_INC, PUMP_INC].sort());
    for (const i of r.incidents) {
      expect(i.confidence).toBe(DETERMINISTIC_CONFIDENCE);
      expect(i.hypothesis).toContain(LLM_UNAVAILABLE_HYPOTHESIS);
    }
    const t = r.toolCalls.find((x) => x.tool === TRIAGE_TOOL_NAME)!;
    expect(t.result_summary).toMatch(/fallback.*503 upstream/);
    expectWireValid(r);

    const none = await runTriage({ db: setup(), llm: null, now });
    expect(none.usedLlm).toBe(false);
    expect(none.incidents[0]!.hypothesis).toContain(LLM_UNAVAILABLE_HYPOTHESIS);
  });

  it('falls back on invalid tool arguments (bad JSON, out-of-range confidence, wrong tool)', async () => {
    for (const step of [
      FakeLlm.toolCall(TRIAGE_TOOL_NAME, '{not json'),
      FakeLlm.toolCall(TRIAGE_TOOL_NAME, { incidents: [{ candidate_id: PUMP_INC, decision: 'confirm', hypothesis: 'x', confidence: 7, evidence_ids: ['a'] }] }),
      FakeLlm.toolCall('get_job_state', { job_ids: ['job-a'] }),
      FakeLlm.text('I think it is the pump.'),
    ]) {
      const r = await runTriage({ db: setup(), llm: new FakeLlm([step]), now });
      expect(r.usedLlm).toBe(false);
      expect(r.incidents[0]!.hypothesis).toContain(LLM_UNAVAILABLE_HYPOTHESIS);
    }
  });

  it('rejects an assessment that cites a hallucinated evidence id', async () => {
    const db = setup(['r7']);
    const llm = new FakeLlm([confirmAll({ [PUMP_INC]: { evidence_ids: ['sym-cooling_degraded-loop-a-b1', 'sig-made-up-9'] } })]);
    const r = await runTriage({ db, llm, now });
    expect(r.usedLlm).toBe(true);
    expect(r.overrides).toEqual([expect.stringMatching(/sig-made-up-9/)]);
    const pump = r.incidents.find((i) => i.incident_id === PUMP_INC)!;
    expect(pump.confidence).toBe(DETERMINISTIC_CONFIDENCE);
    expect(pump.hypothesis).not.toContain('LLM:');
    expect(r.evidenceIdsByIncident[PUMP_INC]).not.toContain('sig-made-up-9');
    // The other candidate's valid assessment is still used.
    expect(r.incidents.find((i) => i.incident_id === R7_INC)!.hypothesis).toBe(`LLM: ${R7_INC}`);
  });
});

describe('F-NV1 actor tags (triage)', () => {
  const actorOf = (r: TriageResult, tool: string) => r.toolCalls.find((t) => t.tool === tool)?.actor;

  it('tags the assessment nemotron and evidence/grouping/upserts code when the LLM answers', async () => {
    const llm = new FakeLlm([
      confirmAll({ [PUMP_INC]: { hypothesis: '24 GPUs on racks r2-r4 + pump-a degraded -> one cooling incident' } }),
    ]);
    const r = await runTriage({ db: setup(), llm, now });
    expect(actorOf(r, TRIAGE_TOOL_NAME)).toBe('nemotron');
    for (const t of ['get_incident_evidence', 'group_symptoms', 'upsert_symptoms', 'upsert_incident']) expect(actorOf(r, t)).toBe('code');
    const ev = diagnoseEvent(r);
    expect(ev.actor).toBe('nemotron');
    expect(ev.summary).toContain('pump-a degraded -> one cooling incident');
    expect(ev.summary.length).toBeLessThanOrEqual(200);
  });

  it('truncates an over-long hypothesis to 200 chars', async () => {
    const r = await runTriage({ db: setup(), llm: new FakeLlm([confirmAll({ [PUMP_INC]: { hypothesis: 'x'.repeat(500) } })]), now });
    for (const i of r.incidents) expect((i.hypothesis ?? '').length).toBeLessThanOrEqual(200);
    expect(diagnoseEvent(r).summary.length).toBeLessThanOrEqual(200);
  });

  it('never tags nemotron when the LLM is null or failed', async () => {
    for (const llm of [null, new FakeLlm([new Error('503')])]) {
      const r = await runTriage({ db: setup(), llm, now });
      expect(r.toolCalls.some((t) => t.actor === 'nemotron')).toBe(false);
      expect(actorOf(r, TRIAGE_TOOL_NAME)).toBe('code');
      const ev = diagnoseEvent(r);
      expect(ev.actor).toBe('code');
      expect(ev.summary.startsWith('deterministic:')).toBe(true);
      expect(ev.summary.length).toBeLessThanOrEqual(200);
    }
  });
});
