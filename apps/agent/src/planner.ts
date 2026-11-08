// Planner (LANE-P3 P3-4). "How the agent decides":
//   1. deterministic code enumerates concrete options per affected job
//   2. every option is scored with physics.simulatePlan and every command checked with physics.evaluateSafety
//   3. options are ranked per ARCHITECTURE §5 (no unsafe -> least irreversible work loss -> lower failure-risk
//      tier -> least completion delay -> least GPU-busy waste -> fewest preemptions; ties -> fewer commands ->
//      option_id). The risk tier is the job's own risk (job-scoped simulatePlan), so a power cap that leaves a
//      job on a degraded cooling loop does not beat a move to a healthy loop just because it is quicker.
//   4. Nemotron chooses among the top eligible options and explains (one choose_options call for all jobs);
//      code rejects any choice that is not an eligible option and falls back to rank 1
//   5. the result is persisted as a PlanCandidate proposal (db.submitPlan). Nothing is executed here.

import { validatePayload, type ActionCommand, type Checkpoint, type Incident, type PlanCandidate, type SafetyDecision } from '@dcos/contracts';
import { z } from 'zod';
import { summarizeToolCall } from './events.js';
import type { AgentActor, DbPort, Evidence, LlmChatResponse, LlmPort, PhysicsPort, PlanMetrics, ToolCallSummary } from './ports.js';
import { CHOOSE_OPTIONS_TOOL, CHOOSE_OPTIONS_TOOL_NAME, PLANNER_MAX_TOKENS, PLANNER_SYSTEM_PROMPT, buildPlannerUserMessage } from './prompts/planner.js';
import { buildCommand, commandKey, type PartialCommand } from './tools/command.js';
import { placementCandidates } from './tools/placement-tool.js';
import { GPU_THROTTLE_TEMP_C, indexSnapshot, type SnapshotIndex } from './tools/snapshot-index.js';
import { CLOCKS_EVENT_SW_THERMAL } from './ports.js';

// ---------------------------------------------------------------------------------------------- public API

export interface RankedOption {
  option_id: string;
  label: string;
  job_id: string;
  commands: ActionCommand[];
  metrics: PlanMetrics;
  safety: SafetyDecision[];
  rank: number;
  /** Failure risk attributable to this option's job (job-scoped simulatePlan), 0..1. Drives the risk tier. */
  job_risk: number;
  excluded_reason?: string;
}

export interface JobPlan {
  job_id: string;
  chosen: RankedOption;
  alternatives: RankedOption[];
  decided_by: 'nemotron' | 'deterministic';
  needs_approval: boolean;
  explanation: string;
}

export interface PlanResult {
  plan: PlanCandidate;
  commands: ActionCommand[];
  job_plans: JobPlan[];
  tool_calls: ToolCallSummary[];
  used_llm: boolean;
  /** F-NV1: the one-sentence plan-stage event summary (Nemotron's own conclusion, or `deterministic: ...`). */
  summary?: string;
  /** F-NV1: `nemotron` only when at least one final job decision came from the LLM. */
  actor?: AgentActor;
}

export interface PlannerDeps {
  db: DbPort;
  physics: PhysicsPort;
  llm: LlmPort;
  workflowId: string;
  runId: string;
  attempt?: number;
  /** GPUs held by still-running actions: treated as occupied, so no option may target them. */
  reservedGpuIds?: string[];
  /** A completed checkpoint younger than this (sim seconds) is reused instead of taking a new one. Default 60. */
  freshCheckpointMaxAgeS?: number;
}

export const FRESH_CHECKPOINT_MAX_AGE_S = 60;
export const PLANNER_HORIZON_S = 600;
export const PLANNER_HORIZON_ASSUMPTION = `planner horizon ${PLANNER_HORIZON_S} s`;
/** Migrate options per job (best placement candidates first). */
export const TOP_PLACEMENTS = 3;
/** Eligible options per job shown to Nemotron. */
export const LLM_TOP_OPTIONS = 3;
export const LLM_PAYLOAD_MAX_BYTES = 6_000;
export const POWER_CAP_W = 500;
/** A GPU this close to the throttle temperature makes power_cap worth enumerating. */
export const NEAR_THROTTLE_MARGIN_C = 5;
/** Loss differences below this share of the avoidable loss are ties (estimates aren't that precise). */
export const LOSS_TIE_FRACTION = 0.05;
/** Failure-risk tier width: risks within the same 0.1 bucket tie (estimates are coarse). */
export const RISK_TIER_WIDTH = 0.1;
/**
 * Residual failure risk a job tolerates without paying for a move: (100 - priority) / 100. A priority-80 job
 * tolerates 0.2 (so a power cap that leaves it at ~0.25 on a degraded loop loses to a move to a healthy loop);
 * a priority-60 job tolerates 0.4 (a cap is good enough, no restart).
 */
export const riskTolerance = (priority: number): number => Math.min(1, Math.max(0, (100 - priority) / 100));
export const EVIDENCE_WINDOW_MS = 600_000;
export const DETERMINISTIC_EXPLANATION = 'deterministic ranking (LLM unavailable)';
export const RANKING_ASSUMPTION =
  'ranking: unsafe excluded; lost work within max(one restart of the job, 5% of avoidable loss) of the best counts as a tie; ' +
  `then the job's own failure risk in ${RISK_TIER_WIDTH} tiers, risk up to (100 - priority)% tolerated (staying on a degraded ` +
  'cooling loop or hot GPUs is riskier than moving to a healthy one), then completion delay, GPU-busy waste, preemptions, command count';

const MAX_EXPLANATION_CHARS = 200;
const PLAN_EXPLANATION_MAX = 2_000;
const MAX_ASSUMPTIONS = 50;

// ---------------------------------------------------------------------------------------------- affected jobs

interface AffectedJob {
  job_id: string;
  incident_ids: [string, ...string[]];
  priority: number;
}

/** All providers reachable from `id` along dependency edges (consumer -> provider), plus `id` itself. */
function providerClosure(ix: SnapshotIndex, id: string, maxDepth = 6): Set<string> {
  const seen = new Set<string>([id]);
  let frontier = [id];
  for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const e of ix.snap.dependencies) {
      if (frontier.includes(e.consumer_id) && !seen.has(e.provider_id)) {
        seen.add(e.provider_id);
        next.push(e.provider_id);
      }
    }
    frontier = next;
  }
  return seen;
}

function linkedResourcesByIncident(incidents: Incident[], evidence: Evidence | null): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>(incidents.map((i) => [i.incident_id, new Set<string>()]));
  if (!evidence) return out;
  const symptomResource = new Map(evidence.symptoms.map((s) => [s.symptom_id, s.resource_id]));
  for (const l of evidence.links) {
    const set = out.get(l.incident_id);
    if (!set) continue;
    if (l.link_kind === 'resource') set.add(l.linked_id);
    if (l.link_kind === 'symptom') {
      const r = symptomResource.get(l.linked_id);
      if (r) set.add(r);
    }
  }
  return out;
}

function degradedLoopUnder(ix: SnapshotIndex, gpuId: string): boolean {
  const nodeId = ix.gpu.get(gpuId)?.node_id;
  const rackId = nodeId ? ix.node.get(nodeId)?.rack_id : undefined;
  const loop = rackId ? ix.loopOfRack.get(rackId) : undefined;
  const state = loop ? ix.cooling.get(loop)?.operating_state : undefined;
  return state !== undefined && state !== 'normal';
}

/** Jobs with an allocated GPU linked to an incident (directly or via its dependency path) or under a degraded loop. */
export function findAffectedJobs(ix: SnapshotIndex, incidents: Incident[], evidence: Evidence | null): AffectedJob[] {
  const linked = linkedResourcesByIncident(incidents, evidence);
  const allIds = incidents.map((i) => i.incident_id) as [string, ...string[]];
  const out: AffectedJob[] = [];
  for (const state of ix.snap.job_states) {
    if (state.status === 'completed' || state.allocated_gpu_ids.length === 0) continue;
    const reach = new Set<string>([state.job_id]);
    for (const g of state.allocated_gpu_ids) for (const p of providerClosure(ix, g)) reach.add(p);
    const hits = [...linked].filter(([, res]) => [...res].some((r) => reach.has(r))).map(([id]) => id);
    const degraded = state.allocated_gpu_ids.some((g) => degradedLoopUnder(ix, g));
    if (hits.length === 0 && !degraded) continue;
    out.push({
      job_id: state.job_id,
      incident_ids: (hits.length > 0 ? hits.sort() : allIds) as [string, ...string[]],
      priority: ix.jobSpec.get(state.job_id)?.priority ?? 0,
    });
  }
  return out.sort((a, b) => b.priority - a.priority || a.job_id.localeCompare(b.job_id));
}

// ---------------------------------------------------------------------------------------------- enumerate

interface DraftOption {
  option_id: string;
  label: string;
  job_id: string;
  commands: ActionCommand[];
}

const rackShort = (ix: SnapshotIndex, gpuId: string): string => {
  const node = ix.gpu.get(gpuId)?.node_id;
  return (node && ix.node.get(node)?.rack_id.replace('rack-', '')) || gpuId;
};

function jobRunsHot(ix: SnapshotIndex, gpuIds: string[]): boolean {
  return gpuIds.some((id) => {
    const g = ix.gpu.get(id);
    return g !== undefined && (g.temp_c >= GPU_THROTTLE_TEMP_C - NEAR_THROTTLE_MARGIN_C || (g.clocks_event_reasons & CLOCKS_EVENT_SW_THERMAL) !== 0);
  });
}

/** Latest complete, accessible checkpoint of the job if it is younger than `maxAgeS` sim seconds. */
export function freshCheckpointOf(ix: SnapshotIndex, jobId: string, maxAgeS: number): Checkpoint | null {
  let best: Checkpoint | null = null;
  for (const c of ix.snap.checkpoints) {
    if (c.job_id !== jobId || c.status !== 'complete' || !c.accessible || c.complete_sim_time_ms === null) continue;
    const newer = best === null || c.complete_sim_time_ms > best.complete_sim_time_ms!;
    const tieWins = best !== null && c.complete_sim_time_ms === best.complete_sim_time_ms && c.checkpoint_id > best.checkpoint_id;
    if (newer || tieWins) best = c;
  }
  return best !== null && (ix.snap.clock.sim_time_ms - best.complete_sim_time_ms!) / 1000 < maxAgeS ? best : null;
}

export function enumerateOptions(
  ix: SnapshotIndex,
  job: AffectedJob,
  ctx: { runId: string; workflowId: string; attempt: number; planId: string; freshCheckpointMaxAgeS?: number },
): DraftOption[] {
  const spec = ix.jobSpec.get(job.job_id);
  const state = ix.jobState.get(job.job_id);
  if (!spec || !state) return [];
  const cmdCtx = { runId: ctx.runId, workflowId: ctx.workflowId, n: ctx.attempt, incidentIds: job.incident_ids, planId: ctx.planId };
  const build = (p: Omit<PartialCommand, 'target_resource_id' | 'job_id'>) =>
    buildCommand({ ...p, target_resource_id: job.job_id, job_id: job.job_id }, ix.snap, cmdCtx);
  const id = (suffix: string) => `${job.job_id}:${suffix}`;
  const out: DraftOption[] = [{ option_id: id('keep'), label: `${job.job_id} keep running`, job_id: job.job_id, commands: [] }];

  if (jobRunsHot(ix, state.allocated_gpu_ids)) {
    out.push({
      option_id: id('cap'),
      label: `${job.job_id} power cap ${POWER_CAP_W} W`,
      job_id: job.job_id,
      commands: [build({ operation: 'power_cap', arguments: { power_limit_w: POWER_CAP_W } })],
    });
  }
  const fresh = spec.checkpoint_supported ? freshCheckpointOf(ix, job.job_id, ctx.freshCheckpointMaxAgeS ?? FRESH_CHECKPOINT_MAX_AGE_S) : null;
  const ckpt = spec.checkpoint_supported && !fresh ? build({ operation: 'checkpoint' }) : null;
  const reuse = fresh ? ` (reusing fresh checkpoint ${fresh.checkpoint_id})` : '';
  if (ckpt) out.push({ option_id: id('ckpt'), label: `${job.job_id} checkpoint`, job_id: job.job_id, commands: [ckpt] });

  if (spec.preemptible) {
    for (const cand of placementCandidates(ix, job.job_id).slice(0, TOP_PLACEMENTS)) {
      const racks = [...new Set(cand.destination_gpu_ids.map((g) => rackShort(ix, g)))].join('+');
      const move = build({
        operation: 'migrate_restart',
        arguments: { destination_gpu_ids: cand.destination_gpu_ids },
        depends_on_command_keys: ckpt ? [ckpt.command_key] : [],
      });
      out.push({
        option_id: id(`${ckpt ? 'ckpt+' : fresh ? 'ckpt-reuse+' : ''}move:${racks}`),
        label: `${job.job_id} ${ckpt ? 'checkpoint then ' : ''}move to ${racks}${reuse}`,
        job_id: job.job_id,
        commands: ckpt ? [ckpt, move] : [move],
      });
    }
  }
  const pause = build({ operation: 'pause_job', depends_on_command_keys: ckpt ? [ckpt.command_key] : [] });
  out.push({
    option_id: id(ckpt ? 'ckpt+pause' : fresh ? 'ckpt-reuse+pause' : 'pause'),
    label: `${job.job_id} ${ckpt ? 'checkpoint then ' : ''}pause${reuse}`,
    job_id: job.job_id,
    commands: ckpt ? [ckpt, pause] : [pause],
  });
  out.push({
    option_id: id('escalate'),
    label: `${job.job_id} escalate to operator`,
    job_id: job.job_id,
    commands: [build({ operation: 'escalate', arguments: { reason: `no automatic mitigation chosen for ${job.job_id}` } })],
  });
  return out;
}

// ---------------------------------------------------------------------------------------------- score + rank

interface Scored extends DraftOption {
  metrics: PlanMetrics;
  safety: SafetyDecision[];
  violations: string[];
  job_risk: number;
}

/**
 * The cluster-wide failure_risk_estimate is dominated by the riskiest job anywhere, so it cannot tell two
 * options of ONE job apart. Score the same commands on a job-scoped view (only this job's spec/state) to get
 * the risk this option leaves on its own job. Approximation: other jobs' load is still in the observed telemetry.
 */
function jobScopedRisk(physics: PhysicsPort, ix: SnapshotIndex, d: DraftOption): number {
  const snap = ix.snap;
  const view = {
    ...snap,
    job_states: snap.job_states.filter((j) => j.job_id === d.job_id),
    job_specs: snap.job_specs.filter((j) => j.job_id === d.job_id),
  };
  try {
    const r = physics.simulatePlan(view, { commands: d.commands }, { horizon_s: PLANNER_HORIZON_S }).failure_risk_estimate;
    return Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0;
  } catch {
    return 0; // no job-scoped estimate: the risk tier then ties and delay decides
  }
}

function scoreOption(physics: PhysicsPort, ix: SnapshotIndex, d: DraftOption, calls: ToolCallSummary[]): Scored {
  const snap = ix.snap;
  const metrics = physics.simulatePlan(snap, { commands: d.commands }, { horizon_s: PLANNER_HORIZON_S });
  const job_risk = jobScopedRisk(physics, ix, d);
  const safety = d.commands.map((c) =>
    physics.evaluateSafety(snap, c, { decision_epoch: snap.clock.decision_epoch, leased_resource_ids: [] }),
  );
  const violations = [
    ...new Set([...safety.filter((s) => s.decision === 'deny').flatMap((s) => (s.violations.length ? s.violations : ['SAFETY_DENIED'])), ...metrics.violations]),
  ];
  const argsSummary = {
    commands: d.commands.length
      ? d.commands.map((c) => ({
          operation: c.operation,
          job_id: c.job_id,
          dest_rack_id:
            c.operation === 'migrate_restart'
              ? [...new Set((c.arguments.destination_gpu_ids as string[]).map((g) => rackShort(ix, g)))].join('+')
              : '',
        }))
      : [{ operation: 'keep_running', job_id: d.job_id }],
  };
  calls.push(summarizeToolCall('simulate_plan', argsSummary, metrics, 'code'));
  calls.push(summarizeToolCall('evaluate_safety', { option_id: d.option_id }, { allowed: violations.length === 0, violations }, 'code'));
  return { ...d, metrics, safety, violations, job_risk };
}

/** Coarse risk bucket (0.1 wide), 0 when within the job's tolerance; the epsilon absorbs float error. */
export const riskTier = (risk: number, tolerance = 0): number => (risk <= tolerance + 1e-9 ? 0 : Math.floor(risk / RISK_TIER_WIDTH + 1e-9));

const preemptions = (o: Scored): number =>
  o.commands.filter((c) => c.operation === 'migrate_restart' || c.operation === 'pause_job').length;

/** Rank per ARCHITECTURE §5. Eligible options get ranks 1..k, excluded ones k+1.. with `excluded_reason`. */
export function rankOptions(ix: SnapshotIndex, jobId: string, scored: Scored[]): RankedOption[] {
  const eligible = scored.filter((o) => o.violations.length === 0);
  const excluded = scored.filter((o) => o.violations.length > 0);
  const spec = ix.jobSpec.get(jobId);
  const restartCost = spec ? spec.gpus_required * spec.work_rate_per_gpu_per_sim_s * (spec.restart_duration_ms / 1000) : 0;
  const keepLost = scored.find((o) => o.commands.length === 0)?.metrics.expected_lost_work_units;
  const bestLost = Math.min(...eligible.map((o) => o.metrics.expected_lost_work_units));
  const avoidable = keepLost !== undefined ? Math.max(0, keepLost - bestLost) : 0;
  const tol = Math.max(restartCost, LOSS_TIE_FRACTION * avoidable);
  const tolerance = riskTolerance(spec?.priority ?? 0);
  const lossTier = (o: Scored) => (o.metrics.expected_lost_work_units <= bestLost + tol ? -1 : o.metrics.expected_lost_work_units);
  eligible.sort(
    (a, b) =>
      lossTier(a) - lossTier(b) ||
      riskTier(a.job_risk, tolerance) - riskTier(b.job_risk, tolerance) ||
      a.metrics.expected_completion_delay_sim_s - b.metrics.expected_completion_delay_sim_s ||
      a.metrics.expected_gpu_busy_waste_s - b.metrics.expected_gpu_busy_waste_s ||
      preemptions(a) - preemptions(b) ||
      a.commands.length - b.commands.length ||
      a.option_id.localeCompare(b.option_id),
  );
  excluded.sort((a, b) => a.option_id.localeCompare(b.option_id));
  const strip = ({ violations: _v, ...o }: Scored) => o;
  return [
    ...eligible.map((o, i) => ({ ...strip(o), rank: i + 1 })),
    ...excluded.map((o, i) => ({ ...strip(o), rank: eligible.length + i + 1, excluded_reason: o.violations.join(',') })),
  ];
}

// ---------------------------------------------------------------------------------------------- Nemotron choice

const choiceItemSchema = z.object({
  job_id: z.string().min(1),
  option_id: z.string().min(1),
  needs_approval: z.boolean(),
  explanation: z.string().min(1),
});
const choiceSchema = z.object({ choices: z.array(z.unknown()).min(1) });
type Choice = z.infer<typeof choiceItemSchema>;

/**
 * Collapse every choose_options call into one choice list (Nemotron sometimes repeats the call): each call is
 * parsed, invalid calls / items are dropped individually, and per job_id the first valid choice wins. Same rule
 * as triage's collectAssessmentItems.
 */
export function collectChoices(calls: readonly { name: string; argumentsJson: string }[]): Choice[] {
  const byJob = new Map<string, Choice>();
  for (const call of calls) {
    if (call.name !== CHOOSE_OPTIONS_TOOL_NAME) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(call.argumentsJson);
    } catch {
      continue;
    }
    const parsed = choiceSchema.safeParse(raw);
    if (!parsed.success) continue;
    for (const item of parsed.data.choices) {
      const c = choiceItemSchema.safeParse(item);
      if (c.success && !byJob.has(c.data.job_id)) byJob.set(c.data.job_id, c.data);
    }
  }
  return [...byJob.values()];
}

const round = (n: number) => Math.round(n * 10) / 10;
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

function buildLlmPayload(ix: SnapshotIndex, incidents: Incident[], ranked: Map<string, RankedOption[]>, topN: number): string {
  const jobs = [...ranked].map(([jobId, opts]) => {
    const spec = ix.jobSpec.get(jobId);
    const st = ix.jobState.get(jobId);
    return {
      job_id: jobId,
      priority: spec?.priority,
      risk_tolerance: spec ? riskTolerance(spec.priority) : undefined,
      preemptible: spec?.preemptible,
      checkpoint_supported: spec?.checkpoint_supported,
      unsaved_work_units: st ? st.progress_work_units - st.durable_work_units : undefined,
      options: opts
        .filter((o) => !o.excluded_reason)
        .slice(0, topN)
        .map((o) => ({
          option_id: o.option_id,
          rank: o.rank,
          label: o.label,
          lost_wu: round(o.metrics.expected_lost_work_units),
          delay_s: round(o.metrics.expected_completion_delay_sim_s),
          waste_s: round(o.metrics.expected_gpu_busy_waste_s),
          risk: Math.round(o.job_risk * 100) / 100,
        })),
      excluded: opts.filter((o) => o.excluded_reason).slice(0, 4).map((o) => ({ option_id: o.option_id, reason: o.excluded_reason })),
    };
  });
  return JSON.stringify({
    decision_epoch: ix.snap.clock.decision_epoch,
    sim_time_ms: ix.snap.clock.sim_time_ms,
    horizon_s: PLANNER_HORIZON_S,
    incidents: incidents.map((i) => ({ incident_id: i.incident_id, title: i.title, hypothesis: i.hypothesis, evidence_ids: ix.snap.observation_event_ids.slice(0, 8) })),
    jobs,
  });
}

async function askNemotron(
  llm: LlmPort,
  ix: SnapshotIndex,
  incidents: Incident[],
  ranked: Map<string, RankedOption[]>,
  calls: ToolCallSummary[],
): Promise<Choice[] | null> {
  let payload = buildLlmPayload(ix, incidents, ranked, LLM_TOP_OPTIONS);
  if (payload.length > LLM_PAYLOAD_MAX_BYTES) payload = buildLlmPayload(ix, incidents, ranked, 2);
  let res: LlmChatResponse;
  try {
    res = await llm.chat({
      messages: [
        { role: 'system', content: PLANNER_SYSTEM_PROMPT },
        { role: 'user', content: buildPlannerUserMessage(payload) },
      ],
      tools: [CHOOSE_OPTIONS_TOOL],
      toolChoice: 'required',
      maxTokens: PLANNER_MAX_TOKENS,
    });
  } catch (e) {
    calls.push(summarizeToolCall(CHOOSE_OPTIONS_TOOL_NAME, { jobs: ranked.size }, `LLM unavailable: ${e instanceof Error ? e.name : 'error'}`, 'code'));
    return null;
  }
  const choices = collectChoices(res.toolCalls);
  if (choices.length === 0) {
    calls.push(summarizeToolCall(CHOOSE_OPTIONS_TOOL_NAME, { jobs: ranked.size }, 'invalid or missing choose_options call', 'code'));
    return null;
  }
  calls.push(
    summarizeToolCall(
      CHOOSE_OPTIONS_TOOL_NAME,
      { jobs: ranked.size },
      choices.map((c) => `${c.option_id}${c.needs_approval ? ' (approval)' : ''}`).join(', '),
      'nemotron',
    ),
  );
  return choices;
}

// ---------------------------------------------------------------------------------------------- decide

const destinations = (o: RankedOption): string[] =>
  o.commands.flatMap((c) => (c.operation === 'migrate_restart' ? (c.arguments.destination_gpu_ids as string[]) : []));

const requiresApproval = (o: RankedOption): boolean =>
  o.commands.some((c) => c.operation === 'escalate') || o.safety.some((s) => s.decision === 'needs_approval');

function decideJob(opts: RankedOption[], choice: Choice | undefined, llmUp: boolean): Omit<JobPlan, 'alternatives'> & { chosen: RankedOption } {
  const eligible = opts.filter((o) => !o.excluded_reason);
  // keep_running has no commands, so it can never execute an unsafe action; it is the floor when nothing is eligible.
  const top = eligible[0] ?? opts.find((o) => o.commands.length === 0) ?? opts[0]!;
  const jobId = top.job_id;
  if (eligible.length === 0) {
    return { job_id: jobId, chosen: top, decided_by: 'deterministic', needs_approval: true, explanation: 'no safe option; keep running and escalate to an operator' };
  }
  if (!llmUp) {
    return {
      job_id: jobId,
      chosen: top,
      decided_by: 'deterministic',
      needs_approval: top.commands.length > 0,
      explanation: `${DETERMINISTIC_EXPLANATION}: ${top.label}`,
    };
  }
  const picked = choice ? eligible.find((o) => o.option_id === choice.option_id) : undefined;
  if (!choice || !picked) {
    const why = !choice
      ? 'Nemotron gave no choice for this job'
      : `Nemotron chose ${clip(choice.option_id, 60)}, which is ${opts.some((o) => o.option_id === choice.option_id) ? 'excluded by safety' : 'not a listed option'}`;
    return {
      job_id: jobId,
      chosen: top,
      decided_by: 'deterministic',
      needs_approval: (choice?.needs_approval ?? false) || requiresApproval(top),
      explanation: `${why}; overridden to rank-1 ${top.label}`,
    };
  }
  return {
    job_id: jobId,
    chosen: picked,
    decided_by: 'nemotron',
    needs_approval: choice.needs_approval || requiresApproval(picked) || eligible.length === 0,
    explanation: clip(choice.explanation.replace(/\s+/g, ' ').trim(), MAX_EXPLANATION_CHARS),
  };
}

const isOp = (o: RankedOption, op: ActionCommand['operation']): boolean => o.commands.some((c) => c.operation === op);

/**
 * No two jobs may move onto the same GPUs: lower-priority jobs fall back to their next non-conflicting safe
 * option. If none is left, the job never takes a clashing choice: it falls back to keep_running (no commands),
 * else pause, else escalate, flagged needs_approval with the reason in the explanation.
 */
export function resolveConflicts(plans: JobPlan[], ranked: Map<string, RankedOption[]>): JobPlan[] {
  const claimed = new Set<string>();
  return plans.map((p) => {
    const clash = (o: RankedOption) => destinations(o).some((g) => claimed.has(g));
    const opts = ranked.get(p.job_id) ?? [p.chosen, ...p.alternatives];
    let jp = p;
    if (clash(p.chosen)) {
      const alt = opts.find((o) => !o.excluded_reason && !clash(o));
      if (alt) {
        jp = {
          ...p,
          chosen: alt,
          decided_by: 'deterministic',
          needs_approval: p.needs_approval || requiresApproval(alt),
          explanation: `${p.chosen.label} conflicts with a higher-priority job's destination; using ${alt.label}`,
        };
      } else {
        const floor =
          opts.find((o) => o.commands.length === 0) ??
          opts.find((o) => isOp(o, 'pause_job') && !clash(o)) ??
          opts.find((o) => isOp(o, 'escalate') && !clash(o));
        const chosen: RankedOption = floor ?? { ...p.chosen, option_id: `${p.job_id}:keep`, label: `${p.job_id} keep running`, commands: [] };
        jp = {
          ...p,
          chosen,
          decided_by: 'deterministic',
          needs_approval: true,
          explanation: `${p.chosen.label} conflicts with a higher-priority job's destination and no safe non-conflicting option is left; ${chosen.label}, operator approval needed`,
        };
      }
    }
    for (const g of destinations(jp.chosen)) claimed.add(g);
    return { ...jp, alternatives: (ranked.get(p.job_id) ?? []).filter((o) => o.option_id !== jp.chosen.option_id) };
  });
}

// ---------------------------------------------------------------------------------------------- entry point

export async function planIncidents(deps: PlannerDeps, input: { incidents: Incident[] }): Promise<PlanResult> {
  const { db, physics, llm, workflowId, runId } = deps;
  const attempt = deps.attempt ?? 1;
  if (input.incidents.length === 0) throw new Error('planIncidents: at least one incident is required');
  const incidents = [...input.incidents].sort((a, b) => a.incident_id.localeCompare(b.incident_id));
  const incidentIds = incidents.map((i) => i.incident_id) as [string, ...string[]];

  const snap = await db.getObservedSnapshot();
  const base = indexSnapshot(snap);
  const reserved = deps.reservedGpuIds ?? [];
  const ix: SnapshotIndex = reserved.length > 0 ? { ...base, allocatedGpus: new Set([...base.allocatedGpus, ...reserved]) } : base;
  const epoch = snap.clock.decision_epoch;
  const planId = `plan-${workflowId}-a${attempt}-e${epoch}`;
  let evidence: Evidence | null = null;
  try {
    evidence = await db.getEvidence(incidentIds, EVIDENCE_WINDOW_MS);
  } catch {
    evidence = null; // affected jobs then come from degraded cooling only
  }

  const toolCalls: ToolCallSummary[] = [];
  const ranked = new Map<string, RankedOption[]>();
  for (const job of findAffectedJobs(ix, incidents, evidence)) {
    const drafts = enumerateOptions(ix, job, { runId, workflowId, attempt, planId, freshCheckpointMaxAgeS: deps.freshCheckpointMaxAgeS });
    ranked.set(job.job_id, rankOptions(ix, job.job_id, drafts.map((d) => scoreOption(physics, ix, d, toolCalls))));
  }

  const choices = ranked.size > 0 ? await askNemotron(llm, ix, incidents, ranked, toolCalls) : null;
  const llmUp = choices !== null;
  const byJob = new Map((choices ?? []).map((c) => [c.job_id, c]));
  const decided = [...ranked].map(([jobId, opts]) => ({ ...decideJob(opts, byJob.get(jobId), llmUp), alternatives: [] }));
  const jobPlans = resolveConflicts(decided, ranked);

  const commands = jobPlans.flatMap((p) => p.chosen.commands);
  const plan = await buildPlan({ physics, ix, planId, runId, workflowId, attempt, incidentIds, jobPlans, commands, llmUp, toolCalls });
  await db.submitPlan(plan);
  return { plan, commands, job_plans: jobPlans, tool_calls: toolCalls, used_llm: llmUp, ...planNarrative(jobPlans, llmUp) };
}

interface BuildPlanArgs {
  physics: PhysicsPort;
  ix: SnapshotIndex;
  planId: string;
  runId: string;
  workflowId: string;
  attempt: number;
  incidentIds: [string, ...string[]];
  jobPlans: JobPlan[];
  commands: ActionCommand[];
  llmUp: boolean;
  toolCalls: ToolCallSummary[];
}

async function buildPlan(a: BuildPlanArgs): Promise<PlanCandidate> {
  // Score the combined plan once: per-option metrics are whole-cluster, so summing them would double count.
  const combined = a.physics.simulatePlan(a.ix.snap, { commands: a.commands }, { horizon_s: PLANNER_HORIZON_S });
  a.toolCalls.push(summarizeToolCall('simulate_plan', { commands: a.commands.map((c) => ({ operation: c.operation, job_id: c.job_id })) }, combined, 'code'));

  // PlanCandidate needs >= 1 command key; an all-keep plan records its (never executed) keep_running keys.
  const keepKeys =
    a.jobPlans.length > 0
      ? a.jobPlans.map((p) => commandKey(a.workflowId, 'keep_running', p.job_id, a.attempt))
      : [commandKey(a.workflowId, 'keep_running', a.incidentIds[0], a.attempt)];
  const keys = (a.commands.length > 0 ? a.commands.map((c) => c.command_key) : keepKeys) as [string, ...string[]];

  const assumptions = [
    ...new Set([
      PLANNER_HORIZON_ASSUMPTION,
      `based on decision_epoch ${a.ix.snap.clock.decision_epoch}`,
      RANKING_ASSUMPTION,
      ...combined.assumptions,
      ...a.jobPlans.flatMap((p) => p.chosen.metrics.assumptions),
      a.llmUp ? 'options chosen by Nemotron among safety-checked candidates' : DETERMINISTIC_EXPLANATION,
    ]),
  ].slice(0, MAX_ASSUMPTIONS);

  const explanation =
    a.jobPlans.length > 0
      ? clip(a.jobPlans.map((p) => `${p.job_id}: ${p.chosen.label}. ${p.explanation}`).join(' '), PLAN_EXPLANATION_MAX)
      : 'no running job is affected by these incidents; keep running';

  const plan: PlanCandidate = {
    schema_version: '1.1.0',
    plan_id: a.planId,
    run_id: a.runId,
    workflow_id: a.workflowId,
    incident_ids: a.incidentIds,
    based_on_decision_epoch: a.ix.snap.clock.decision_epoch,
    assumptions,
    command_keys: keys,
    expected_completion_delay_sim_s: combined.expected_completion_delay_sim_s,
    expected_lost_work_units: combined.expected_lost_work_units,
    expected_gpu_busy_waste_s: combined.expected_gpu_busy_waste_s,
    failure_risk_estimate: Math.min(1, Math.max(0, combined.failure_risk_estimate)),
    explanation,
  };
  const v = validatePayload('PlanCandidate', plan);
  if (!v.ok) throw new Error(`planIncidents: invalid PlanCandidate: ${v.errors.join('; ')}`);
  return plan;
}

/**
 * F-NV1 plan/replan event narrative. Nemotron's own one-sentence explanations when the LLM made at least one final
 * decision (`actor: 'nemotron'`); otherwise a clearly labelled deterministic sentence (`actor: 'code'`).
 */
export function planNarrative(jobPlans: JobPlan[], usedLlm: boolean): { summary: string; actor: AgentActor } {
  const nem = usedLlm ? jobPlans.filter((p) => p.decided_by === 'nemotron') : [];
  if (nem.length > 0) return { summary: clip(nem.map((p) => p.explanation).join(' | '), 200), actor: 'nemotron' };
  const text = jobPlans.length > 0 ? jobPlans.map((p) => `${p.job_id}: ${p.chosen.label}`).join('; ') : 'no running job affected, keep running';
  return { summary: clip(`deterministic: ${text}`, 200), actor: 'code' };
}
