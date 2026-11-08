// Gate 4 rehearsal: P1's runScenario harness (REAL physics) with reactive / threshold (P1) and nemotronPolicy (P3) on
// the SAME scenarios + seeds. Every policy gets the identical ObservedSnapshot on every tick (ARCHITECTURE §9).
// Prints one row per scenario x policy, then a totals table, and optionally writes the rows as JSON.
//
//   pnpm --filter agent exec tsx scripts/eval-side-by-side.ts [--out [<file>]] [--only sc03,sc17]
//        [--policies reactive,threshold,nemotron] [--live] [--max-live-calls 30] [--every-tick]
//
// --out: write { results: EvaluationResult[] (each checked with validatePayload), totals, provenance } to <file>,
//   default apps/agent/eval-results/<deterministic|live>-<YYYY-MM-DD>.json (P4's scoreboard loads `results`). All
//   policies of one scenario share one run_id (eval-<date>-<scenario>). Any schema-invalid row aborts the write.
// Key check: every command Nemotron returns is recorded; one logical step (operation, job, attempt) must map to ONE
//   command_key per scenario (a second key for the same step would be a duplicate effect). Violations exit 1.
//
// default: deterministic Nemotron path (llm = null; no NIM key is read).
// --live: Nemotron via NIM (NIM_API_KEY + NIM_MODEL from env / repo-root .env.local; the key is never printed).
//   Responses are disk-cached (apps/agent/.cache/llm); at most --max-live-calls requests reach the LLM port, after that
//   the policy falls back to the deterministic path (counted in llmFailures).
// cadence: event-driven (built into createNemotronPolicy, see EVENT_DRIVEN_CADENCE); --every-tick re-plans on every
//   harness tick (CONTRACTS §0.6 literal; ~4 s per call while an incident is open, ~40 min per scenario).
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validatePayload, type ActionCommand, type EvaluationResult } from '@dcos/contracts';
import { loadScenarios, reactivePolicy, runScenario, summarizeResults, thresholdPolicy } from '@dcos/physics';
import { createPhysicsPort } from '../src/adapters/physics.js';
import { loadConfig } from '../src/config.js';
import { createNimLlm } from '../src/llm.js';
import { EVENT_DRIVEN_CADENCE, createNemotronPolicy } from '../src/policy.js';
import type { LlmPort, Policy } from '../src/ports.js';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v !== undefined && !v.startsWith('--') ? v : undefined;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

export const EVAL_RESULTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'eval-results');

/**
 * One logical step = `<operation>:<job or target>:<attempt>` (the command_key without its workflow id). Returns the
 * steps that were issued under more than one command_key: the same step with two keys would take effect twice.
 */
export function logicalKeyConflicts(commands: readonly ActionCommand[]): [string, string[]][] {
  const byStep = new Map<string, Set<string>>();
  for (const c of commands) {
    const step = c.command_key.split(':').slice(1).join(':');
    byStep.set(step, new Set([...(byStep.get(step) ?? []), c.command_key]));
  }
  return [...byStep].filter(([, keys]) => keys.size > 1).map(([step, keys]) => [step, [...keys].sort()]);
}

/** Validate every row (validatePayload) and write the scoreboard payload atomically. Throws on any invalid row. */
export function writeEvaluationResults(file: string, payload: { results: EvaluationResult[] } & Record<string, unknown>): void {
  const bad = payload.results.flatMap((r, i) => {
    const v = validatePayload('EvaluationResult', r);
    return v.ok ? [] : [`row ${i} (${r.scenario_id}/${r.policy}): ${v.errors.join('; ')}`];
  });
  if (bad.length > 0) throw new Error(`refusing to write ${file}: schema-invalid EvaluationResult rows:\n${bad.join('\n')}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/** Hard cap on LIVE requests (it sits under the disk cache, so cache hits are free); beyond it every call fails -> deterministic. */
function capped(inner: LlmPort, max: number): LlmPort & { used: () => number } {
  let used = 0;
  return {
    used: () => used,
    async chat(req) {
      if (used >= max) throw new Error('live LLM call budget exhausted');
      used += 1;
      return inner.chat(req);
    },
  };
}

const COLS = ['lost_work_units', 'job_completion_delay_s', 'gpu_busy_waste_s', 'unnecessary_preemptions', 'unsafe_actions_executed',
  'unsafe_actions_blocked', 'successful_recoveries', 'failed_recoveries'] as const;
const SHORT: Record<(typeof COLS)[number], string> = {
  lost_work_units: 'lost_wu', job_completion_delay_s: 'delay_s', gpu_busy_waste_s: 'waste_s', unnecessary_preemptions: 'unnec',
  unsafe_actions_executed: 'unsafeX', unsafe_actions_blocked: 'unsafeB', successful_recoveries: 'rec_ok', failed_recoveries: 'rec_fail',
};
const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

async function main(): Promise<void> {
  const only = arg('only')?.split(',');
  const names = (arg('policies') ?? 'reactive,threshold,nemotron').split(',') as EvaluationResult['policy'][];
  const scenarios = loadScenarios().filter((s) => !only || only.some((p) => s.scenario_id.startsWith(p)));
  const physics = await createPhysicsPort();
  const live = flag('live');
  const everyTick = flag('every-tick');
  const maxLive = Number(arg('max-live-calls') ?? 30);

  let llm: (LlmPort & { used: () => number }) | null = null;
  let model = 'none';
  if (live) {
    const cfg = loadConfig();
    if (!cfg.NIM_API_KEY || !cfg.NIM_MODEL) throw new Error('--live needs NIM_API_KEY and NIM_MODEL');
    model = cfg.NIM_MODEL;
    llm = capped(createNimLlm(cfg), maxLive);
  }
  const nemotronPolicy = createNemotronPolicy({
    llm,
    physics,
    model,
    cache: live,
    cadence: everyTick ? 'every-tick' : 'event-driven',
  });
  let issued: ActionCommand[] = [];
  const nemotron: Policy = async (obs, ctx) => {
    const out = await nemotronPolicy(obs, ctx);
    issued = [...issued, ...out];
    return out;
  };
  const policies: Record<EvaluationResult['policy'], Policy> = { reactive: reactivePolicy, threshold: thresholdPolicy, nemotron };
  const date = new Date().toISOString().slice(0, 10);
  const conflicts: string[] = [];
  const label = `real physics; Nemotron ${live ? `live (${model}, <= ${maxLive} LLM requests)` : 'deterministic (llm = null)'}; ${everyTick ? 'every-tick cadence' : 'event-driven cadence'}`;
  console.log(`# ${label}`);
  if (!everyTick) console.log(`# ${EVENT_DRIVEN_CADENCE}`);
  console.log(`# ${scenarios.length} scenario(s) x ${names.join(', ')}`);
  console.log(['scenario'.padEnd(38), 'policy'.padEnd(9), ...COLS.map((c) => SHORT[c].padStart(9)), 'secs'.padStart(7)].join(' '));

  const rows: EvaluationResult[] = [];
  for (const s of scenarios) {
    for (const name of names) {
      nemotronPolicy.reset();
      issued = [];
      const t0 = Date.now();
      const r = await runScenario(s, policies[name], { policy_name: name, run_id: `eval-${date}-${s.scenario_id}` });
      rows.push(r);
      if (name === 'nemotron') {
        for (const [step, keys] of logicalKeyConflicts(issued)) conflicts.push(`${s.scenario_id}: ${step} issued as ${keys.join(' AND ')}`);
      }
      console.log(
        [s.scenario_id.padEnd(38), name.padEnd(9), ...COLS.map((c) => fmt(r[c]).padStart(9)), ((Date.now() - t0) / 1000).toFixed(1).padStart(7)].join(' '),
      );
    }
  }

  console.log(`\nTOTALS (${label})`);
  console.log(['policy'.padEnd(9), 'scen'.padStart(5), ...COLS.map((c) => SHORT[c].padStart(10))].join(' '));
  const totals = summarizeResults(rows);
  for (const p of totals) {
    console.log([p.policy.padEnd(9), String(p.scenarios).padStart(5), ...COLS.map((c) => fmt(p[c]).padStart(10))].join(' '));
  }
  const stats = { ...nemotronPolicy.stats(), liveRequestsUsed: llm?.used() ?? 0 };
  console.log(`nemotron stats: ${JSON.stringify(stats)}`);
  if (names.includes('nemotron')) {
    console.log(`nemotron logical-step key conflicts: ${conflicts.length}`);
    for (const c of conflicts) console.log(`  ${c}`);
  }
  if (flag('out')) {
    const file = resolve(arg('out') ?? resolve(EVAL_RESULTS_DIR, `${live ? 'live' : 'deterministic'}-${date}.json`));
    writeEvaluationResults(file, {
      kind: 'dcos-evaluation-results',
      generated_at: new Date().toISOString(),
      label,
      cadence: everyTick ? 'every-tick' : EVENT_DRIVEN_CADENCE,
      nemotron: live ? `live NIM (${model}), <= ${maxLive} LLM requests, disk-cached` : 'deterministic (llm = null)',
      nemotron_stats: stats,
      totals,
      results: rows,
    });
    console.log(`wrote ${rows.length} schema-valid EvaluationResult row(s) to ${file}`);
  }
  if (conflicts.length > 0) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
