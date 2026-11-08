// P1-9b: writes packages/physics/fixtures/evaluation/ (the hand-off to P4's scoreboard).
//
//   pnpm --filter @dcos/physics build && node packages/physics/scripts/make-baseline-results.ts
//
// The script runs the BUILT harness (dist/), because Node's type stripping cannot resolve the `.js` import specifiers
// inside src/. test/gpu-run.test.ts calls buildBaselineFiles() with the src harness and fails if the files on disk
// differ, so a stale dist cannot slip through. Deterministic: no clock or randomness; writes happen only in main().
// (This is a Node script, not package source, so it may use node:fs.)
//
// Files:
//   do_nothing_reference.json  20 rows, one per scenario, of the inline do-nothing policy (never acts). NOT a contract
//                              policy: `policy` is "do_nothing", which EvaluationResult's enum does not allow, so these
//                              rows can never be published to evaluation_result by mistake. Every other field is
//                              EvaluationResult-valid (the test checks that with the policy swapped).
//   reactive.json              20 contract EvaluationResults: runAllScenarios(reactivePolicy, { policy_name: 'reactive' })
//   threshold.json             20 contract EvaluationResults: runAllScenarios(thresholdPolicy, { policy_name: 'threshold' })
//   README.md                  what the files are, the metric definitions, the three-way comparison and totals.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { EvaluationResult } from '../../contracts/src/index.js';
import type { Policy, PolicySummary, RunScenarioOptions } from '../src/gpu/run.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const EVALUATION_DIR = join(HERE, '..', 'fixtures', 'evaluation');
export const DO_NOTHING_FILE = 'do_nothing_reference.json';
export const DO_NOTHING_LABEL = 'do_nothing';
export const REACTIVE_FILE = 'reactive.json';
export const THRESHOLD_FILE = 'threshold.json';

export interface HarnessApi {
  runAllScenarios: (policy: Policy, opts: RunScenarioOptions) => Promise<EvaluationResult[]>;
  summarizeResults: (rows: readonly (Omit<EvaluationResult, 'policy'> & { policy: string })[]) => PolicySummary[];
  DO_NOTHING_POLICY: Policy;
  reactivePolicy: Policy;
  thresholdPolicy: Policy;
}

export interface BaselineRows {
  do_nothing: ReferenceRow[];
  reactive: EvaluationResult[];
  threshold: EvaluationResult[];
}

export type ReferenceRow = Omit<EvaluationResult, 'policy'> & { policy: typeof DO_NOTHING_LABEL };

export const serialize = (x: unknown): string => `${JSON.stringify(x, null, 2)}\n`;

/** The do-nothing rows: runAllScenarios with the reference policy, relabelled. */
export async function buildReferenceRows(api: HarnessApi): Promise<ReferenceRow[]> {
  // policy_name is only a label; it is replaced below (the harness itself is policy-agnostic)
  const rows = await api.runAllScenarios(api.DO_NOTHING_POLICY, { policy_name: 'reactive' });
  return rows.map((r) => ({ ...r, run_id: `eval-${DO_NOTHING_LABEL}-${r.scenario_id}`, policy: DO_NOTHING_LABEL }));
}

/** All three row sets (sequential, deterministic). */
export async function buildBaselineRows(api: HarnessApi): Promise<BaselineRows> {
  return {
    do_nothing: await buildReferenceRows(api),
    reactive: await api.runAllScenarios(api.reactivePolicy, { policy_name: 'reactive' }),
    threshold: await api.runAllScenarios(api.thresholdPolicy, { policy_name: 'threshold' }),
  };
}

type Row = Omit<EvaluationResult, 'policy'> & { policy: string };
const recov = (r: Row) => `${r.successful_recoveries}/${r.failed_recoveries}`;

/** One line per scenario, the three policies side by side (do-nothing / reactive / threshold). */
function comparison(b: BaselineRows): string {
  const head = '| scenario | lost work units (none / reactive / threshold) | completion delay s | GPU-busy waste s | unnecessary preemptions (r / t) | unsafe executed (r / t) | unsafe blocked (r / t) | recoveries ok/failed (r / t) |';
  const sep = '|---|---:|---:|---:|---:|---:|---:|---:|';
  const body = b.do_nothing.map((n, i) => {
    const r = b.reactive[i]!;
    const t = b.threshold[i]!;
    const tri = (k: 'lost_work_units' | 'job_completion_delay_s' | 'gpu_busy_waste_s') => `${n[k]} / ${r[k]} / ${t[k]}`;
    const duo = (k: 'unnecessary_preemptions' | 'unsafe_actions_executed' | 'unsafe_actions_blocked') => `${r[k]} / ${t[k]}`;
    return `| ${n.scenario_id} | ${tri('lost_work_units')} | ${tri('job_completion_delay_s')} | ${tri('gpu_busy_waste_s')} | ${duo('unnecessary_preemptions')} | ${duo('unsafe_actions_executed')} | ${duo('unsafe_actions_blocked')} | ${recov(r)} / ${recov(t)} |`;
  });
  return [head, sep, ...body].join('\n');
}

function totals(api: HarnessApi, b: BaselineRows): string {
  const sums = api.summarizeResults([...b.do_nothing, ...b.reactive, ...b.threshold]);
  const head = '| policy | scenarios | lost work units | completion delay s | GPU-busy waste s | unnecessary preemptions | unsafe executed | unsafe blocked | recoveries ok / failed |';
  const sep = '|---|---:|---:|---:|---:|---:|---:|---:|---:|';
  const body = sums.map((s) => `| ${s.policy} | ${s.scenarios} | ${s.lost_work_units} | ${s.job_completion_delay_s} | ${s.gpu_busy_waste_s} | ${s.unnecessary_preemptions} | ${s.unsafe_actions_executed} | ${s.unsafe_actions_blocked} | ${s.successful_recoveries} / ${s.failed_recoveries} |`);
  return [head, sep, ...body].join('\n');
}

function table(rows: ReferenceRow[]): string {
  const head = '| scenario | lost work units | completion delay s | GPU-busy waste s | unnecessary preemptions | unsafe executed | unsafe blocked | recoveries ok / failed |';
  const sep = '|---|---:|---:|---:|---:|---:|---:|---:|';
  const body = rows.map((r) => `| ${r.scenario_id} | ${r.lost_work_units} | ${r.job_completion_delay_s} | ${r.gpu_busy_waste_s} | ${r.unnecessary_preemptions} | ${r.unsafe_actions_executed} | ${r.unsafe_actions_blocked} | ${r.successful_recoveries} / ${r.failed_recoveries} |`);
  return [head, sep, ...body].join('\n');
}

function readme(api: HarnessApi, b: BaselineRows): string {
  const rows = b.do_nothing;
  return `# Evaluation baselines (P1-9b)

GENERATED by \`packages/physics/scripts/make-baseline-results.ts\`; do not edit by hand. \`test/gpu-run.test.ts\` fails if
these files differ from the generator. Regenerate with:

\`\`\`
pnpm --filter @dcos/physics build && node packages/physics/scripts/make-baseline-results.ts
\`\`\`

Every row comes from \`runScenario(scenario, policy, opts)\` in \`@dcos/physics\` (\`src/gpu/run.ts\`) over the 20 seeded
scenarios of \`loadScenarios()\` (\`fixtures/scenarios/\`), gate \`safety\`. Everything is simulated and deterministic: the
same scenario and policy always give the same row.

## Files

- \`${DO_NOTHING_FILE}\`: the inline **do-nothing** reference (a policy that never acts), one row per scenario. It is
  **not a contract policy**: \`policy\` is \`"${DO_NOTHING_LABEL}"\`, which the \`EvaluationResult\` enum
  (\`reactive | threshold | nemotron\`) does not allow, so these rows cannot be published to \`evaluation_result\` by mistake.
  Use it as the "no action" line on the scoreboard. Every other field is \`EvaluationResult\`-valid.
- \`${REACTIVE_FILE}\`: \`runAllScenarios(reactivePolicy, { policy_name: 'reactive' })\`, 20 contract \`EvaluationResult\`
  rows (publishable to \`evaluation_result\`). The reactive baseline acts only on XID 48 / 79: cordon the GPU, restart a
  failed job from its checkpoint on free ready GPUs, or escalate.
- \`${THRESHOLD_FILE}\`: \`runAllScenarios(thresholdPolicy, { policy_name: 'threshold' })\`, 20 contract rows. Reactive's
  XID handling plus a preventive trigger: a job GPU over 83 °C → checkpoint + move to a destination \`evaluateSafety\`
  allows (escalate if the job is not preemptible or cannot checkpoint).
- Nemotron rows (\`policy: "nemotron"\`) come from P3's \`nemotronPolicy\` through the same \`runScenario\`.

## Metric definitions (full text in \`src/gpu/run.ts\`)

- **lost_work_units**: work rolled back on the true world (a job failure back to its durable checkpoint, or a restart
  from an older checkpoint). Same definition as \`PlanMetrics.expected_lost_work_units\`.
- **job_completion_delay_s**: Σ over jobs of (ideal nominal-rate work − actual work) / ideal rate over the horizon. A
  lower bound truncated at the horizon; a job that never finishes is never counted as zero delay. Same as
  \`PlanMetrics.expected_completion_delay_sim_s\`.
- **gpu_busy_waste_s**: GPU-seconds allocated without full progress (throttle and power cap fractionally;
  checkpointing, restarting and paused fully). Same as \`PlanMetrics.expected_gpu_busy_waste_s\`.
- **unnecessary_preemptions**: executed checkpoint / migrate_restart / pause_job / power_cap on jobs that, in the
  do-nothing run of the same scenario, never failed and never throttled.
- **unsafe_actions_blocked**: commands the safety gate refused (deny or needs_approval; there is no human offline).
- **unsafe_actions_executed**: executed commands that safety denied at request time (only with gate \`none\`), or
  migrations whose destination GPUs reached 85 °C before 120 s after the job ran on them.
- **successful_recoveries / failed_recoveries**: migrate_restart of a failed or at-risk job that completed and whose
  job did not fail afterwards / that failed, was rejected, lost its dependency, or whose job failed afterwards.
- **agent_crash_resumes**: always 0 offline.

## Totals (\`summarizeResults\`)

${totals(api, b)}

## Per scenario: do-nothing vs reactive vs threshold

${comparison(b)}

## Do-nothing reference

${table(rows)}
`;
}

/** Every file in fixtures/evaluation/, as exact text. */
export async function buildBaselineFiles(api: HarnessApi, rows?: BaselineRows): Promise<Record<string, string>> {
  const b = rows ?? await buildBaselineRows(api);
  return {
    [DO_NOTHING_FILE]: serialize(b.do_nothing),
    [REACTIVE_FILE]: serialize(b.reactive),
    [THRESHOLD_FILE]: serialize(b.threshold),
    'README.md': readme(api, b),
  };
}

async function main(): Promise<void> {
  const dist = (p: string) => import(pathToFileURL(join(HERE, '..', 'dist', ...p.split('/'))).href);
  const api = { ...(await dist('gpu/run.js')), ...(await dist('gpu/policies.js')) } as HarnessApi;
  const files = await buildBaselineFiles(api);
  mkdirSync(EVALUATION_DIR, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(EVALUATION_DIR, name), text);
  console.log(`wrote ${Object.keys(files).length} files to ${EVALUATION_DIR}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
