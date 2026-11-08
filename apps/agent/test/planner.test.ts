import { validatePayload, type Incident, type IncidentLink } from '@dcos/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DETERMINISTIC_EXPLANATION,
  LLM_PAYLOAD_MAX_BYTES,
  PLANNER_HORIZON_ASSUMPTION,
  RANKING_ASSUMPTION,
  planIncidents,
  resolveConflicts,
  riskTier,
  riskTolerance,
  type JobPlan,
  type PlanResult,
  type RankedOption,
} from '../src/planner.js';
import type { LlmChatRequest } from '../src/ports.js';
import { CHOOSE_OPTIONS_TOOL_NAME, PLANNER_MAX_TOKENS } from '../src/prompts/planner.js';
import { FakeDb, FakeLlm, FakePhysics } from './fakes/index.js';
import { RUN_ID, loadPumpDegradedSnapshot } from './fixtures/index.js';

const WF = 'wf-1';
const COOL_RACKS = new Set(['rack-r1', 'rack-r5', 'rack-r7', 'rack-r8']);

const incident = (id: string, title: string): Incident => ({
  schema_version: '1.1.0',
  run_id: RUN_ID,
  incident_id: id,
  state: 'open',
  severity: 'high',
  title,
  hypothesis: null,
  confidence: 0.7,
  opened_sim_time_ms: 430_000,
  updated_sim_time_ms: 540_000,
  version: 1,
});

const link = (incidentId: string, linked: string): IncidentLink => ({
  schema_version: '1.1.0',
  run_id: RUN_ID,
  incident_id: incidentId,
  linked_id: linked,
  link_kind: 'resource',
  reason: 'test',
});

const PUMP = incident('inc-pump-a', 'pump-a degraded, loop-a racks r2-r4 throttling');
const R6 = incident('inc-r6', 'rack r6 thermal margin low');

interface PlanningInput {
  jobs: { job_id: string; options: { option_id: string }[]; excluded: { option_id: string }[] }[];
}

const parseInput = (req: LlmChatRequest): PlanningInput => {
  const user = req.messages.find((m) => m.role === 'user');
  const text = user && 'content' in user ? String(user.content) : '';
  return JSON.parse(text.slice(text.indexOf('PLANNING_INPUT=') + 'PLANNING_INPUT='.length)) as PlanningInput;
};

/** Nemotron stand-in that picks the listed rank-1 option for every job (overrides by job_id). */
const pickTop = (overrides: Record<string, string> = {}) => (req: LlmChatRequest) =>
  FakeLlm.toolCall(CHOOSE_OPTIONS_TOOL_NAME, {
    choices: parseInput(req).jobs.map((j) => ({
      job_id: j.job_id,
      option_id: overrides[j.job_id] ?? j.options[0]!.option_id,
      needs_approval: false,
      explanation: `picked by test for ${j.job_id}`,
    })),
  });

let physics: FakePhysics;
let db: FakeDb;

const setup = async (incidents: [Incident, string[]][]) => {
  for (const [inc, resources] of incidents) await db.upsertIncident(inc, resources.map((r) => link(inc.incident_id, r)));
};

const run = (llm: FakeLlm, incidents: Incident[] = [PUMP], attempt?: number): Promise<PlanResult> =>
  planIncidents({ db, physics, llm, workflowId: WF, runId: RUN_ID, attempt }, { incidents });

const jobPlan = (r: PlanResult, jobId: string) => {
  const p = r.job_plans.find((j) => j.job_id === jobId);
  if (!p) throw new Error(`no plan for ${jobId}`);
  return p;
};

const destRacks = (r: PlanResult, jobId: string): string[] => {
  const snap = loadPumpDegradedSnapshot();
  const rackOf = (gpu: string) => snap.nodes.find((n) => n.resource_id === snap.gpus.find((g) => g.resource_id === gpu)?.node_id)?.rack_id;
  return jobPlan(r, jobId)
    .chosen.commands.filter((c) => c.operation === 'migrate_restart')
    .flatMap((c) => (c.arguments.destination_gpu_ids as string[]).map((g) => rackOf(g) ?? '?'));
};

beforeEach(async () => {
  physics = new FakePhysics();
  db = new FakeDb({ snapshot: loadPumpDegradedSnapshot(), physics });
  await setup([[PUMP, ['pump-a', 'loop-a', 'rack-r2', 'rack-r3', 'rack-r4']]]);
});

describe('planIncidents on the pump-degraded fixture', () => {
  it('moves job-a (checkpoint then migrate) onto cool loop-b racks, never r6', async () => {
    const r = await run(new FakeLlm([pickTop()]));
    const a = jobPlan(r, 'job-a');
    expect(a.chosen.commands.map((c) => c.operation)).toEqual(['checkpoint', 'migrate_restart']);
    expect(a.chosen.rank).toBe(1);
    expect(a.decided_by).toBe('nemotron');
    const racks = destRacks(r, 'job-a');
    expect(racks).toHaveLength(16);
    for (const rack of racks) expect(COOL_RACKS.has(rack)).toBe(true);
    expect(racks).not.toContain('rack-r6');
    // no option of any job ever targets r6 (job-c holds it)
    for (const o of [a.chosen, ...a.alternatives]) {
      for (const c of o.commands) expect(JSON.stringify(c.arguments)).not.toContain('gpu-r6');
    }
  });

  it('keeps or power-caps job-b, whose checkpoint is fresh', async () => {
    const r = await run(new FakeLlm([pickTop()]));
    const b = jobPlan(r, 'job-b');
    expect(['job-b:keep', 'job-b:cap']).toContain(b.chosen.option_id);
    expect(b.chosen.commands.every((c) => c.operation === 'power_cap')).toBe(true);
  });

  it('does not touch job-c for the pump incident (it is not on loop-a)', async () => {
    const r = await run(new FakeLlm([pickTop()]));
    expect(r.job_plans.map((j) => j.job_id).sort()).toEqual(['job-a', 'job-b']);
  });

  it('gives non-preemptible job-c no eligible migrate or pause option', async () => {
    await setup([[R6, ['rack-r6']]]);
    const r = await run(new FakeLlm([pickTop()]), [PUMP, R6]);
    const c = jobPlan(r, 'job-c');
    const all = [c.chosen, ...c.alternatives];
    const eligible = all.filter((o) => !o.excluded_reason);
    expect(eligible.some((o) => o.commands.some((x) => x.operation === 'migrate_restart' || x.operation === 'pause_job'))).toBe(false);
    expect(all.find((o) => o.option_id === 'job-c:pause')?.excluded_reason).toContain('JOB_NOT_PREEMPTIBLE');
    expect(c.chosen.excluded_reason).toBeUndefined();
    for (const cmd of c.chosen.commands) expect(cmd.incident_ids).toEqual(['inc-r6']);
  });

  it('orders commands so migrate depends on its checkpoint', async () => {
    const r = await run(new FakeLlm([pickTop()]));
    const ck = r.commands.findIndex((c) => c.operation === 'checkpoint' && c.job_id === 'job-a');
    const mv = r.commands.findIndex((c) => c.operation === 'migrate_restart' && c.job_id === 'job-a');
    expect(ck).toBeGreaterThanOrEqual(0);
    expect(mv).toBeGreaterThan(ck);
    expect(r.commands[mv]!.depends_on_command_keys).toEqual([r.commands[ck]!.command_key]);
    expect(r.commands[ck]!.command_key).toBe(`${WF}:checkpoint:job-a:1`);
  });

  it('submits a schema-valid PlanCandidate', async () => {
    const r = await run(new FakeLlm([pickTop()]));
    expect(validatePayload('PlanCandidate', r.plan).ok).toBe(true);
    expect(db.plans.get(r.plan.plan_id)).toEqual(r.plan);
    expect(r.plan.based_on_decision_epoch).toBe(2);
    expect(r.plan.incident_ids).toEqual(['inc-pump-a']);
    expect(r.plan.command_keys).toEqual(r.commands.map((c) => c.command_key));
    expect(r.plan.assumptions).toContain(PLANNER_HORIZON_ASSUMPTION);
    for (const c of r.commands) {
      expect(validatePayload('ActionCommand', c).ok).toBe(true);
      expect(c.plan_id).toBe(r.plan.plan_id);
      expect(c.expected_decision_epoch).toBe(2);
    }
  });

  it('uses new command keys on attempt 2', async () => {
    const first = await run(new FakeLlm([pickTop()]));
    const second = await run(new FakeLlm([pickTop()]), [PUMP], 2);
    const k1 = new Set(first.commands.map((c) => c.command_key));
    expect(second.commands.length).toBeGreaterThan(0);
    for (const c of second.commands) {
      expect(k1.has(c.command_key)).toBe(false);
      expect(c.command_key.endsWith(':2')).toBe(true);
    }
    expect(second.plan.plan_id).not.toBe(first.plan.plan_id);
  });

  it('ranks deterministically', async () => {
    const shape = (r: PlanResult) =>
      r.job_plans.map((j) => ({
        job: j.job_id,
        chosen: j.chosen.option_id,
        options: [j.chosen, ...j.alternatives].sort((a, b) => a.rank - b.rank).map((o) => `${o.rank}:${o.option_id}`),
      }));
    const a = await run(new FakeLlm([new Error('down')]));
    const b = await run(new FakeLlm([new Error('down')]));
    expect(shape(b)).toEqual(shape(a));
    expect(b.commands).toEqual(a.commands);
  });

  it('records simulate_plan, evaluate_safety and choose_options tool calls', async () => {
    const r = await run(new FakeLlm([pickTop()]));
    const tools = new Set(r.tool_calls.map((t) => t.tool));
    expect(tools).toEqual(new Set(['simulate_plan', 'evaluate_safety', CHOOSE_OPTIONS_TOOL_NAME]));
    expect(r.used_llm).toBe(true);
  });

  it('sends Nemotron a bounded payload with only eligible options and requires the tool', async () => {
    const llm = new FakeLlm([pickTop()]);
    await run(llm);
    const req = llm.requests[0]!;
    expect(req.toolChoice).toBe('required');
    expect(req.tools?.map((t) => t.name)).toEqual([CHOOSE_OPTIONS_TOOL_NAME]);
    const user = req.messages.find((m) => m.role === 'user');
    expect(String(user && 'content' in user ? user.content : '').length).toBeLessThanOrEqual(LLM_PAYLOAD_MAX_BYTES + 200);
    for (const j of parseInput(req).jobs) expect(j.options.length).toBeLessThanOrEqual(3);
  });
});

describe('safety enforcement and fallbacks', () => {
  const coolOffLoopB = () =>
    db.mutateSnapshot((s) => {
      for (const n of s.nodes) if (['rack-r1', 'rack-r5', 'rack-r7'].includes(n.rack_id)) n.thermal_headroom_c = 3;
    });

  it('excludes migrations to racks without thermal headroom', async () => {
    coolOffLoopB();
    const r = await run(new FakeLlm([pickTop()]));
    const a = jobPlan(r, 'job-a');
    const moves = [a.chosen, ...a.alternatives].filter((o) => o.option_id.includes('move'));
    expect(moves.length).toBeGreaterThan(0);
    for (const m of moves) expect(m.excluded_reason).toContain('DEST_RACK_THERMAL_HEADROOM_INSUFFICIENT');
    expect(a.chosen.excluded_reason).toBeUndefined();
    expect(a.chosen.commands.some((c) => c.operation === 'migrate_restart')).toBe(false);
  });

  it('overrides a Nemotron choice of an excluded option to rank 1', async () => {
    coolOffLoopB();
    const llm = new FakeLlm([pickTop({ 'job-a': 'job-a:ckpt+move:r1+r5' })]);
    const r = await run(llm);
    const listed = parseInput(llm.requests[0]!).jobs.find((j) => j.job_id === 'job-a')!;
    expect(listed.options.map((o) => o.option_id)).not.toContain('job-a:ckpt+move:r1+r5');
    const a = jobPlan(r, 'job-a');
    expect(a.chosen.option_id).not.toBe('job-a:ckpt+move:r1+r5');
    expect(a.chosen.rank).toBe(1);
    expect(a.decided_by).toBe('deterministic');
    expect(a.explanation).toMatch(/overridden to rank-1/);
    expect(a.explanation).toMatch(/excluded by safety/);
    expect(r.commands.some((c) => c.operation === 'migrate_restart')).toBe(false);
  });

  it('overrides an unknown option id too', async () => {
    const r = await run(new FakeLlm([pickTop({ 'job-b': 'job-b:reboot-everything' })]));
    const b = jobPlan(r, 'job-b');
    expect(b.chosen.rank).toBe(1);
    expect(b.explanation).toMatch(/not a listed option/);
  });

  it('falls back to deterministic rank 1 when the LLM is down', async () => {
    const r = await run(new FakeLlm([new Error('LLM unavailable')]));
    expect(r.used_llm).toBe(false);
    for (const p of r.job_plans) {
      expect(p.decided_by).toBe('deterministic');
      expect(p.chosen.rank).toBe(1);
      expect(p.explanation).toContain(DETERMINISTIC_EXPLANATION);
    }
    expect(jobPlan(r, 'job-a').needs_approval).toBe(true);
    expect(destRacks(r, 'job-a').every((x) => COOL_RACKS.has(x))).toBe(true);
    expect(r.plan.assumptions).toContain(DETERMINISTIC_EXPLANATION);
  });

  it('falls back when the tool-call arguments are invalid', async () => {
    const r = await run(new FakeLlm([FakeLlm.toolCall(CHOOSE_OPTIONS_TOOL_NAME, '{"choices": "nope"')]));
    expect(r.used_llm).toBe(false);
    expect(r.job_plans.every((p) => p.decided_by === 'deterministic')).toBe(true);
  });

  it('passes Nemotron needs_approval through', async () => {
    const llm = new FakeLlm([
      (req: LlmChatRequest) =>
        FakeLlm.toolCall(CHOOSE_OPTIONS_TOOL_NAME, {
          choices: parseInput(req).jobs.map((j) => ({ job_id: j.job_id, option_id: j.options[0]!.option_id, needs_approval: true, explanation: 'unsure' })),
        }),
    ]);
    const r = await run(llm);
    expect(r.job_plans.every((p) => p.needs_approval)).toBe(true);
  });

  it('never lets two jobs move onto the same GPUs', async () => {
    const r = await run(new FakeLlm([pickTop({ 'job-a': 'job-a:ckpt+move:r1+r5', 'job-b': 'job-b:ckpt+move:r1' })]));
    const dests = r.commands.filter((c) => c.operation === 'migrate_restart').flatMap((c) => c.arguments.destination_gpu_ids as string[]);
    expect(new Set(dests).size).toBe(dests.length);
    expect(jobPlan(r, 'job-a').chosen.option_id).toBe('job-a:ckpt+move:r1+r5');
    expect(jobPlan(r, 'job-b').chosen.option_id).not.toBe('job-b:ckpt+move:r1');
  });
});

describe('reservedGpuIds and fresh checkpoint reuse', () => {
  const allOptions = (r: PlanResult, jobId: string) => [jobPlan(r, jobId).chosen, ...jobPlan(r, jobId).alternatives];
  const destsOf = (r: PlanResult, jobId: string): string[] =>
    allOptions(r, jobId).flatMap((o) => o.commands.flatMap((c) => (c.operation === 'migrate_restart' ? (c.arguments.destination_gpu_ids as string[]) : [])));
  const withFreshCheckpoint = async (ageMs: number) => {
    const snap = loadPumpDegradedSnapshot();
    snap.checkpoints.push({ ...snap.checkpoints[0]!, checkpoint_id: 'ckpt-job-a-fresh', job_id: 'job-a', complete_sim_time_ms: snap.clock.sim_time_ms - ageMs });
    db = new FakeDb({ snapshot: snap, physics });
    await setup([[PUMP, ['pump-a', 'loop-a', 'rack-r2', 'rack-r3', 'rack-r4']]]);
  };

  it('never offers a reserved GPU in any option, and still offers moves elsewhere', async () => {
    const base = await run(new FakeLlm([pickTop()]));
    const reserved = [...new Set(destsOf(base, 'job-a').filter((g) => g.startsWith('gpu-r1-')))];
    expect(reserved.length).toBeGreaterThan(0);
    const r = await planIncidents(
      { db, physics, llm: new FakeLlm([pickTop()]), workflowId: WF, runId: RUN_ID, reservedGpuIds: reserved },
      { incidents: [PUMP] },
    );
    const dests = destsOf(r, 'job-a');
    expect(dests.length).toBeGreaterThan(0);
    for (const g of reserved) expect(dests).not.toContain(g);
    expect(JSON.stringify(r.commands)).not.toContain(reserved[0]!);
  });

  it('reuses a fresh checkpoint: no new checkpoint step, label says so, migrate depends on nothing', async () => {
    await withFreshCheckpoint(5_000);
    const r = await run(new FakeLlm([pickTop()]));
    const opts = allOptions(r, 'job-a');
    for (const o of opts) expect(o.commands.map((c) => c.operation)).not.toContain('checkpoint');
    const moves = opts.filter((o) => o.commands.some((c) => c.operation === 'migrate_restart'));
    expect(moves.length).toBeGreaterThan(0);
    for (const o of moves) {
      expect(o.label).toContain('(reusing fresh checkpoint ckpt-job-a-fresh)');
      expect(o.commands[0]!.depends_on_command_keys).toEqual([]);
    }
    expect(opts.some((o) => o.option_id === 'job-a:ckpt-reuse+pause')).toBe(true);
    for (const c of r.commands) expect(validatePayload('ActionCommand', c).ok).toBe(true);
    expect(validatePayload('PlanCandidate', r.plan).ok).toBe(true);
  });

  it('freshCheckpointMaxAgeS controls the threshold', async () => {
    await withFreshCheckpoint(30_000);
    const strict = await planIncidents(
      { db, physics, llm: new FakeLlm([pickTop()]), workflowId: WF, runId: RUN_ID, freshCheckpointMaxAgeS: 10 },
      { incidents: [PUMP] },
    );
    expect(allOptions(strict, 'job-a').some((o) => o.commands.some((c) => c.operation === 'checkpoint'))).toBe(true);
    const dflt = await run(new FakeLlm([pickTop()]));
    expect(allOptions(dflt, 'job-a').some((o) => o.commands.some((c) => c.operation === 'checkpoint'))).toBe(false);
  });

  // Intended behavior change (risk tier): before it, a fresh checkpoint made the power cap tie the move on lost
  // work (within one restart) and the cap won on delay, leaving job-a on degraded loop-a. Now the job's own risk
  // decides first: the move leaves ~0.02, the cap ~0.25, above job-a's tolerance of 0.2.
  /** Like the demo after job-a's checkpoint completed: durable work == progress, checkpoint 5 s old. */
  const justCheckpointed = async () => {
    const snap = loadPumpDegradedSnapshot();
    const a = snap.job_states.find((j) => j.job_id === 'job-a')!;
    a.durable_work_units = a.progress_work_units;
    a.latest_checkpoint_id = 'ckpt-job-a-fresh';
    snap.checkpoints.push({ ...snap.checkpoints[0]!, checkpoint_id: 'ckpt-job-a-fresh', job_id: 'job-a', complete_sim_time_ms: snap.clock.sim_time_ms - 5_000 });
    db = new FakeDb({ snapshot: snap, physics });
    await setup([[PUMP, ['pump-a', 'loop-a', 'rack-r2', 'rack-r3', 'rack-r4']]]);
  };

  it('risk tier: with a fresh checkpoint, job-a moves to a healthy loop instead of a power cap in place', async () => {
    await justCheckpointed();
    const r = await run(new FakeLlm([new Error('down')]));
    const a = jobPlan(r, 'job-a');
    const cap = allOptions(r, 'job-a').find((o) => o.option_id === 'job-a:cap')!;
    expect(a.chosen.commands.map((c) => c.operation)).toEqual(['migrate_restart']);
    expect(destRacks(r, 'job-a').every((x) => COOL_RACKS.has(x))).toBe(true);
    expect(cap.excluded_reason).toBeUndefined();
    expect(cap.rank).toBeGreaterThan(a.chosen.rank);
    expect(a.chosen.job_risk).toBeLessThan(cap.job_risk);
    const restartCost = 16 * 1 * 120; // gpus * rate * restart_s: the lost-work tie tolerance
    expect(Math.abs(cap.metrics.expected_lost_work_units - a.chosen.metrics.expected_lost_work_units)).toBeLessThanOrEqual(restartCost);
    expect(a.chosen.metrics.expected_completion_delay_sim_s).toBeGreaterThan(cap.metrics.expected_completion_delay_sim_s);
    // job-b (priority 60) tolerates the cap's residual risk and still avoids a restart
    expect(jobPlan(r, 'job-b').chosen.option_id).toBe('job-b:cap');
    expect(r.plan.assumptions).toContain(RANKING_ASSUMPTION);
    expect(RANKING_ASSUMPTION).toMatch(/failure risk/);
  });

  it('sends Nemotron the job-scoped risk and the job risk tolerance', async () => {
    await justCheckpointed();
    const llm = new FakeLlm([pickTop()]);
    await run(llm);
    const user = llm.requests[0]!.messages.find((m) => m.role === 'user');
    const text = String(user && 'content' in user ? user.content : '');
    const input = JSON.parse(text.slice(text.indexOf('PLANNING_INPUT=') + 'PLANNING_INPUT='.length)) as {
      jobs: { job_id: string; risk_tolerance: number; options: { option_id: string; risk: number }[] }[];
    };
    const a = input.jobs.find((j) => j.job_id === 'job-a')!;
    expect(a.risk_tolerance).toBeCloseTo(0.2);
    expect(a.options[0]!.option_id).toContain('move');
    expect(a.options[0]!.risk).toBeCloseTo(0.02);
  });

  it('riskTier buckets by 0.1 and treats risk within tolerance as tier 0', () => {
    expect(riskTier(0.02)).toBe(0);
    expect(riskTier(0.25)).toBe(2);
    expect(riskTier(0.3)).toBe(3);
    expect(riskTier(0.25, riskTolerance(60))).toBe(0);
    expect(riskTier(0.25, riskTolerance(80))).toBe(2);
    expect(riskTolerance(80)).toBeCloseTo(0.2);
    expect(riskTolerance(150)).toBe(0);
  });

  it('is unchanged when neither option is given and the checkpoint is stale', async () => {
    const r = await run(new FakeLlm([pickTop()]));
    const ids = allOptions(r, 'job-a').map((o) => o.option_id);
    expect(ids.some((i) => i.startsWith('job-a:ckpt+move:'))).toBe(true);
    expect(ids).toContain('job-a:ckpt+pause');
    expect(ids.some((i) => i.includes('ckpt-reuse'))).toBe(false);
  });
});

describe('F-NV1 actor tags (planner)', () => {
  it('tags choose_options nemotron and simulate/safety code; summary is the Nemotron sentence', async () => {
    const r = await run(new FakeLlm([pickTop()]));
    const actors = (tool: string) => r.tool_calls.filter((t) => t.tool === tool).map((t) => t.actor);
    expect(actors(CHOOSE_OPTIONS_TOOL_NAME)).toEqual(['nemotron']);
    expect(actors('simulate_plan').every((a) => a === 'code')).toBe(true);
    expect(actors('evaluate_safety').every((a) => a === 'code')).toBe(true);
    expect(r.actor).toBe('nemotron');
    expect(r.summary).toContain('picked by test');
    expect(r.summary!.length).toBeLessThanOrEqual(200);
  });

  it('truncates a long Nemotron explanation to 200 chars', async () => {
    const llm = new FakeLlm([
      (req: LlmChatRequest) => {
        const step = pickTop()(req) as ReturnType<typeof FakeLlm.toolCall>;
        const args = JSON.parse(step.toolCalls[0]!.argumentsJson) as { choices: { explanation: string }[] };
        for (const c of args.choices) c.explanation = 'y'.repeat(900);
        return FakeLlm.toolCall(CHOOSE_OPTIONS_TOOL_NAME, args);
      },
    ]);
    const r = await run(llm);
    for (const p of r.job_plans) expect(p.explanation.length).toBeLessThanOrEqual(200);
    expect(r.summary!.length).toBeLessThanOrEqual(200);
  });

  it('never claims nemotron when the LLM failed or returned garbage', async () => {
    for (const llm of [new FakeLlm([new Error('down')]), new FakeLlm([FakeLlm.toolCall(CHOOSE_OPTIONS_TOOL_NAME, '{"choices": "nope"')])]) {
      const r = await run(llm);
      expect(r.tool_calls.some((t) => t.actor === 'nemotron')).toBe(false);
      expect(r.actor).toBe('code');
      expect(r.summary!.startsWith('deterministic:')).toBe(true);
      expect(r.summary!.length).toBeLessThanOrEqual(200);
    }
  });
});

describe('choose_options robustness (review P3 #8)', () => {
  const choice = (job_id: string, option_id: string) => ({ job_id, option_id, needs_approval: false, explanation: `test ${option_id}` });

  it('dedupes duplicate choose_options calls: per job the first valid choice wins', async () => {
    let firstA = '';
    let secondA = '';
    const llm = new FakeLlm([
      (req: LlmChatRequest) => {
        const jobs = parseInput(req).jobs;
        const a = jobs.find((j) => j.job_id === 'job-a')!;
        const b = jobs.find((j) => j.job_id === 'job-b')!;
        firstA = a.options[1]!.option_id;
        secondA = a.options[0]!.option_id;
        return FakeLlm.toolCalls([
          { name: CHOOSE_OPTIONS_TOOL_NAME, args: { choices: [choice('job-a', firstA)] } },
          { name: CHOOSE_OPTIONS_TOOL_NAME, args: { choices: [choice('job-a', secondA), choice('job-b', b.options[0]!.option_id)] } },
        ]);
      },
    ]);
    const r = await run(llm);
    expect(firstA).not.toBe(secondA);
    expect(jobPlan(r, 'job-a').chosen.option_id).toBe(firstA);
    expect(jobPlan(r, 'job-a').decided_by).toBe('nemotron');
    expect(jobPlan(r, 'job-b').decided_by).toBe('nemotron');
  });

  it('an invalid first call does not hide a valid second one', async () => {
    const llm = new FakeLlm([
      (req: LlmChatRequest) =>
        FakeLlm.toolCalls([
          { name: CHOOSE_OPTIONS_TOOL_NAME, args: '{"choices": "nope"' },
          { name: CHOOSE_OPTIONS_TOOL_NAME, args: { choices: parseInput(req).jobs.map((j) => choice(j.job_id, j.options[0]!.option_id)) } },
        ]),
    ]);
    const r = await run(llm);
    expect(r.used_llm).toBe(true);
    expect(r.job_plans.every((p) => p.decided_by === 'nemotron')).toBe(true);
  });

  it('passes maxTokens: PLANNER_MAX_TOKENS to the LLM', async () => {
    const llm = new FakeLlm([pickTop()]);
    await run(llm);
    expect(llm.requests[0]!.maxTokens).toBe(PLANNER_MAX_TOKENS);
  });
});

describe('resolveConflicts never falls back to a clashing choice (review P3 #7)', () => {
  const metrics = { expected_completion_delay_sim_s: 0, expected_lost_work_units: 0, expected_gpu_busy_waste_s: 0, failure_risk_estimate: 0, violations: [], assumptions: [] };
  const opt = (job_id: string, suffix: string, commands: Array<{ operation: string; dest?: string[] }>, extra: Partial<RankedOption> = {}): RankedOption =>
    ({
      option_id: `${job_id}:${suffix}`,
      label: `${job_id} ${suffix}`,
      job_id,
      commands: commands.map((c) => ({ operation: c.operation, job_id, arguments: c.dest ? { destination_gpu_ids: c.dest } : {} })),
      metrics,
      safety: [],
      rank: 1,
      job_risk: 0,
      ...extra,
    }) as unknown as RankedOption;
  const plan = (chosen: RankedOption, needs_approval = false): JobPlan => ({
    job_id: chosen.job_id,
    chosen,
    alternatives: [],
    decided_by: 'nemotron',
    needs_approval,
    explanation: 'x',
  });
  const destsOf = (o: RankedOption) => o.commands.flatMap((c) => (c.arguments.destination_gpu_ids as string[] | undefined) ?? []);

  it('when every safe option clashes and keep_running is excluded, falls back to keep_running with needs_approval', () => {
    const aMove = opt('job-a', 'move', [{ operation: 'migrate_restart', dest: ['g1', 'g2'] }]);
    const bMove = opt('job-b', 'move', [{ operation: 'migrate_restart', dest: ['g2'] }]);
    const bKeep = opt('job-b', 'keep', [], { excluded_reason: 'HORIZON_VIOLATION', rank: 2 });
    const ranked = new Map([
      ['job-a', [aMove]],
      ['job-b', [bMove, bKeep]],
    ]);
    const out = resolveConflicts([plan(aMove), plan(bMove)], ranked);
    const b = out.find((p) => p.job_id === 'job-b')!;
    expect(destsOf(b.chosen).some((g) => destsOf(aMove).includes(g))).toBe(false);
    expect(b.chosen.option_id).toBe('job-b:keep');
    expect(b.needs_approval).toBe(true);
    expect(b.decided_by).toBe('deterministic');
    expect(b.explanation).toMatch(/conflicts with a higher-priority job's destination/);
    expect(b.explanation).toMatch(/approval/);
  });

  it('without a keep option it falls back to pause (never the clashing move)', () => {
    const aMove = opt('job-a', 'move', [{ operation: 'migrate_restart', dest: ['g1'] }]);
    const bMove = opt('job-b', 'move', [{ operation: 'migrate_restart', dest: ['g1'] }]);
    const bPause = opt('job-b', 'pause', [{ operation: 'pause_job' }], { excluded_reason: 'NEEDS_OPERATOR', rank: 2 });
    const out = resolveConflicts([plan(aMove), plan(bMove)], new Map([['job-a', [aMove]], ['job-b', [bMove, bPause]]]));
    const b = out.find((p) => p.job_id === 'job-b')!;
    expect(b.chosen.option_id).toBe('job-b:pause');
    expect(b.needs_approval).toBe(true);
  });
});

// ---------------------------------------------------------------------------------- sequential conditional planning

/**
 * FakePhysics plus a cross-job coupling like real physics' shared cooling loop: while job-a stays on loop-a,
 * job-b inherits its heat (big lost work, risk 1) unless job-b itself moves. Per-job scoring (every other job in
 * place) would therefore move job-b; conditional scoring (job-a's move applied first) must not.
 */
class CoupledPhysics extends FakePhysics {
  override simulatePlan(...args: Parameters<FakePhysics['simulatePlan']>): ReturnType<FakePhysics['simulatePlan']> {
    const [obs, plan] = args;
    const m = super.simulatePlan(...args);
    const moved = (j: string) => plan.commands.some((c) => c.job_id === j && (c.operation === 'migrate_restart' || c.operation === 'pause_job'));
    const inView = (j: string) => obs.job_states.some((s) => s.job_id === j);
    if (inView('job-a') && inView('job-b') && !moved('job-a') && !moved('job-b')) {
      return { ...m, expected_lost_work_units: m.expected_lost_work_units + 50_000, failure_risk_estimate: 1 };
    }
    return m;
  }
}

describe('sequential conditional planning (no needless preemption)', () => {
  const allOpts = (r: PlanResult, jobId: string) => [jobPlan(r, jobId).chosen, ...jobPlan(r, jobId).alternatives];
  const isPreempt = (o: RankedOption) => o.commands.some((c) => c.operation === 'migrate_restart' || c.operation === 'pause_job');

  beforeEach(async () => {
    physics = new CoupledPhysics();
    db = new FakeDb({ snapshot: loadPumpDegradedSnapshot(), physics });
    await setup([[PUMP, ['pump-a', 'loop-a', 'rack-r2', 'rack-r3', 'rack-r4']]]);
  });

  it("scores job-b with job-a's chosen move applied: job-b keeps / caps, its moves rank below keep", async () => {
    const r = await run(new FakeLlm([new Error('down')]));
    expect(jobPlan(r, 'job-a').chosen.commands.map((c) => c.operation)).toEqual(['checkpoint', 'migrate_restart']);
    const b = jobPlan(r, 'job-b');
    expect(['job-b:keep', 'job-b:cap']).toContain(b.chosen.option_id);
    const keep = allOpts(r, 'job-b').find((o) => o.option_id === 'job-b:keep')!;
    expect(keep.metrics.expected_lost_work_units).toBeLessThan(50_000); // not charged job-a's heat
    // (the toy model keeps job-b's own degraded-loop risk at 0.5 > its 0.4 tolerance, so the cap ranks first there)
    expect(isPreempt(b.chosen)).toBe(false);
    for (const o of allOpts(r, 'job-b').filter((x) => isPreempt(x) && !x.excluded_reason)) expect(o.rank).toBeGreaterThan(b.chosen.rank);
    // job-b's options were simulated after job-a's commands (combined list) and the trace says so
    const aKeys = jobPlan(r, 'job-a').chosen.commands.map((c) => c.command_key);
    type SimArg = { commands: { command_key: string; job_id: string }[] };
    const bSims = physics.calls.filter((c) => c.method === 'simulatePlan' && (c.args[0] as SimArg).commands.some((x) => x.job_id === 'job-b'));
    expect(bSims.length).toBeGreaterThan(0);
    for (const s of bSims) expect((s.args[0] as SimArg).commands.map((x) => x.command_key).slice(0, aKeys.length)).toEqual(aKeys);
    const aId = jobPlan(r, 'job-a').chosen.option_id;
    expect(r.tool_calls.some((t) => t.tool === 'simulate_plan' && t.args_summary.includes(aId) && t.args_summary.includes('after'))).toBe(true);
    expect(RANKING_ASSUMPTION).toMatch(/sequentially in priority order/);
    expect(RANKING_ASSUMPTION).toMatch(/needless preemption/);
  });

  it('shows Nemotron the conditional context and vs_keep deltas', async () => {
    const llm = new FakeLlm([pickTop()]);
    await run(llm);
    const input = parseInput(llm.requests[0]!) as unknown as {
      jobs: { job_id: string; after_jobs: string[]; options: { option_id: string; vs_keep?: { lost_wu: number } }[] }[];
    };
    const a = input.jobs.find((j) => j.job_id === 'job-a')!;
    const b = input.jobs.find((j) => j.job_id === 'job-b')!;
    expect(a.after_jobs).toEqual([]);
    expect(b.after_jobs).toEqual(['job-a']);
    expect(a.options[0]!.vs_keep!.lost_wu).toBeLessThan(0); // moving job-a helps
    for (const o of b.options) if (o.option_id !== 'job-b:keep') expect(o.vs_keep).toBeDefined();
  });

  it('re-scores later jobs when Nemotron departs from the rank-1 option they were conditioned on', async () => {
    const r = await run(new FakeLlm([pickTop({ 'job-a': 'job-a:keep' })]));
    const a = jobPlan(r, 'job-a');
    expect(a.chosen.option_id).toBe('job-a:keep');
    expect(a.decided_by).toBe('nemotron');
    // job-b now sees job-a staying in place: its keep carries the coupled loss
    const keep = allOpts(r, 'job-b').find((o) => o.option_id === 'job-b:keep')!;
    expect(keep.metrics.expected_lost_work_units).toBeGreaterThanOrEqual(50_000);
    expect(r.tool_calls.some((t) => t.tool === 'simulate_plan' && t.args_summary.includes('job-a:keep'))).toBe(true);
    // Nemotron's job-b choice is re-validated against the re-scored list (still a listed eligible option)
    const b = jobPlan(r, 'job-b');
    expect(allOpts(r, 'job-b').some((o) => o.option_id === b.chosen.option_id && !o.excluded_reason)).toBe(true);
  });
});

describe('failed job recovery', () => {
  beforeEach(async () => {
    physics = new FakePhysics();
    const snap = loadPumpDegradedSnapshot();
    const a = snap.job_states.find((j) => j.job_id === 'job-a')!;
    a.status = 'failed';
    a.allocated_gpu_ids = [];
    snap.allocations = snap.allocations.filter((x) => x.job_id !== 'job-a');
    db = new FakeDb({ snapshot: snap, physics });
    await setup([[PUMP, ['pump-a', 'loop-a', 'rack-r2', 'rack-r3', 'rack-r4']]]);
  });

  it('plans a restart (no checkpoint, no dependency) for a failed job; a recovery is never a needless preemption', async () => {
    const r = await run(new FakeLlm([new Error('down')]));
    const a = jobPlan(r, 'job-a');
    const opts = [a.chosen, ...a.alternatives];
    expect(opts.map((o) => o.option_id)).toContain('job-a:keep');
    expect(opts.some((o) => o.commands.some((c) => c.operation === 'checkpoint' || c.operation === 'pause_job'))).toBe(false);
    const restarts = opts.filter((o) => o.option_id.startsWith('job-a:restart:'));
    expect(restarts.length).toBeGreaterThan(0);
    for (const o of restarts) expect(o.commands[0]!.depends_on_command_keys).toEqual([]);
    // (ranking vs leave-failed is physics-driven: the toy model charges a failed job no delay; real physics
    // charges the whole horizon, so the restart wins there -- see the sc17 eval row)
  });
});

describe('in-flight checkpoint (job checkpointing right now)', () => {
  const INFLIGHT_KEY = 'wf-0:checkpoint:job-a:1';
  beforeEach(async () => {
    physics = new FakePhysics();
    const snap = loadPumpDegradedSnapshot();
    snap.job_states.find((j) => j.job_id === 'job-a')!.status = 'checkpointing';
    snap.checkpoints.push({
      ...snap.checkpoints[0]!,
      checkpoint_id: 'ckpt-job-a-inflight',
      job_id: 'job-a',
      status: 'writing',
      complete_sim_time_ms: null,
      requested_sim_time_ms: snap.clock.sim_time_ms - 5_000,
      command_key: INFLIGHT_KEY,
    });
    db = new FakeDb({ snapshot: snap, physics });
    await setup([[PUMP, ['pump-a', 'loop-a', 'rack-r2', 'rack-r3', 'rack-r4']]]);
  });

  it('never proposes a second checkpoint; moves and pause depend on the in-flight checkpoint key', async () => {
    const r = await run(new FakeLlm([new Error('down')]), [PUMP], 2);
    const opts = [jobPlan(r, 'job-a').chosen, ...jobPlan(r, 'job-a').alternatives];
    for (const o of opts) expect(o.commands.map((c) => c.operation)).not.toContain('checkpoint');
    const moves = opts.filter((o) => o.commands.some((c) => c.operation === 'migrate_restart'));
    expect(moves.length).toBeGreaterThan(0);
    for (const o of moves) {
      expect(o.option_id).toMatch(/^job-a:ckpt-inflight\+move:/);
      expect(o.label).toContain(`(after in-flight checkpoint ${INFLIGHT_KEY})`);
      expect(o.commands).toHaveLength(1);
      expect(o.commands[0]!.depends_on_command_keys).toEqual([INFLIGHT_KEY]);
    }
    const pause = opts.find((o) => o.option_id === 'job-a:ckpt-inflight+pause')!;
    expect(pause.commands[0]!.depends_on_command_keys).toEqual([INFLIGHT_KEY]);
  });
});

/**
 * FakePhysics with a controllable keep_running outlook: a single-job view with no commands (the keepHold probe) is
 * clean (no loss, no risk) up to `cleanUpToS` of horizon; everything else is FakePhysics (job-a on the degraded loop
 * is risky over the full planner horizon, so without a hold rule it moves).
 */
class OutlookPhysics extends FakePhysics {
  constructor(public cleanUpToS: number) {
    super();
  }
  override simulatePlan(...args: Parameters<FakePhysics['simulatePlan']>) {
    const [obs, plan, opts] = args;
    const m = super.simulatePlan(obs, plan, opts);
    const h = opts?.horizon_s ?? 600;
    if (plan.commands.length === 0 && obs.job_states.length === 1 && h <= this.cleanUpToS) {
      return { ...m, expected_lost_work_units: 0, failure_risk_estimate: 0 };
    }
    return m;
  }
}

describe('keep_running holds (RANKING_ASSUMPTION rules (a) near-complete and (b) deferral)', () => {
  const runWith = (p: FakePhysics, recheckAfterS?: number) =>
    planIncidents({ db, physics: p, llm: new FakeLlm([]), workflowId: WF, runId: RUN_ID, recheckAfterS }, { incidents: [PUMP] });

  it('documents both rules in RANKING_ASSUMPTION', () => {
    expect(RANKING_ASSUMPTION).toMatch(/until \(a\) it completes/);
    expect(RANKING_ASSUMPTION).toMatch(/\(b\) the last moment a mitigation can still be started/);
  });

  it('(b) defers job-a only when the caller re-plans on a schedule and the outlook is clean for the whole lead time', async () => {
    // job-a: checkpoint 30 s + restart 120 s + re-check 30 s = 180 s lead time
    const p = new OutlookPhysics(200);
    const now = await runWith(p);
    expect(jobPlan(now, 'job-a').chosen.commands.map((c) => c.operation)).toEqual(['checkpoint', 'migrate_restart']);
    expect(now.recheck_after_s).toBeUndefined();

    const later = await runWith(p, 30);
    const a = jobPlan(later, 'job-a');
    expect(a.chosen.option_id).toBe('job-a:keep');
    expect(a.chosen.hold).toEqual({ kind: 'deferred', window_s: 180, recheck_s: 30 });
    expect(a.chosen.label).toMatch(/deferred/);
    expect(later.recheck_after_s).toBe(30);
    // clean for the whole planner horizon: the next re-check can wait until (600 - checkpoint - restart) = 450 s
    const calm = await runWith(new OutlookPhysics(600), 30);
    expect(jobPlan(calm, 'job-a').chosen.hold).toEqual({ kind: 'deferred', window_s: 180, recheck_s: 450 });
    expect(calm.recheck_after_s).toBe(450);
    // the alternatives are still scored and ranked (the re-check finds the same move once it is needed)
    expect(a.alternatives.some((o) => o.commands.some((c) => c.operation === 'migrate_restart'))).toBe(true);
  });

  it('(b) does not defer when trouble starts inside the lead time', async () => {
    const r = await runWith(new OutlookPhysics(120), 30);
    expect(jobPlan(r, 'job-a').chosen.commands.map((c) => c.operation)).toEqual(['checkpoint', 'migrate_restart']);
    expect(r.recheck_after_s).toBeUndefined();
  });

  it('(a) a job that completes before it can fail keeps running, even without a re-check', async () => {
    db.mutateSnapshot((s) => {
      const st = s.job_states.find((j) => j.job_id === 'job-a')!;
      const spec = s.job_specs.find((j) => j.job_id === 'job-a')!;
      st.progress_work_units = spec.total_work_units - spec.gpus_required * spec.work_rate_per_gpu_per_sim_s * 100; // 100 s left
    });
    const base = await runWith(new OutlookPhysics(0)); // outlook never clean: the ranking without rule (a) moves it
    expect(jobPlan(base, 'job-a').chosen.commands.length).toBeGreaterThan(0);
    const r = await runWith(new OutlookPhysics(600));
    const a = jobPlan(r, 'job-a');
    expect(a.chosen.option_id).toBe('job-a:keep');
    expect(a.chosen.hold?.kind).toBe('completes_first');
    expect(a.chosen.hold?.window_s).toBeCloseTo(100, 5);
    expect(r.recheck_after_s).toBeUndefined();
  });
});
