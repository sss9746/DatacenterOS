// Gate 4 rehearsal: P1's runScenario harness with reactive / threshold (P1) and nemotronPolicy (P3, llm = null by
// default) on the SAME scenarios + seeds. Prints EvaluationResults side by side and writes them as JSON.
//
//   pnpm --filter agent exec tsx scripts/eval-side-by-side.ts [--out <file>] [--only sc03,sc17] [--policies reactive,threshold,nemotron]
//
// Deterministic: the nemotron policy is created with llm = null (no NIM key is read).
//
// --every-tick: call nemotronPolicy on every harness tick (CONTRACTS 0.6 literal). Measured ~4 s per call while an
//   incident is open (triage + planner + ~30 simulatePlan runs), i.e. ~40 min per scenario.
// default (event-driven): nemotronPolicy is re-invoked only when decision_epoch or the observation_event_ids change,
//   and returns [] otherwise -- the same "act on change" cadence P3's agent loop uses. Rows are labelled in the log.
import { writeFileSync } from 'node:fs';
import type { EvaluationResult } from '@dcos/contracts';
import { loadScenarios, reactivePolicy, runScenario, summarizeResults, thresholdPolicy } from '@dcos/physics';
import { createPhysicsPort } from '../src/adapters/physics.js';
import { createNemotronPolicy } from '../src/policy.js';
import type { Policy } from '../src/ports.js';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<void> {
  const only = arg('only')?.split(',');
  const names = (arg('policies') ?? 'reactive,threshold,nemotron').split(',') as EvaluationResult['policy'][];
  const scenarios = loadScenarios().filter((s) => !only || only.some((p) => s.scenario_id.startsWith(p)));
  const physics = await createPhysicsPort();
  const nemotron = createNemotronPolicy({ llm: null, physics, cache: false });
  const everyTick = process.argv.includes('--every-tick');
  let lastKey: string | null = null;
  const eventDriven: Policy = async (obs, ctx) => {
    const key = `${obs.run_id}|${obs.clock.decision_epoch}|${obs.observation_event_ids.join(',')}`;
    if (key === lastKey) return [];
    lastKey = key;
    return nemotron(obs, ctx);
  };
  const policies: Record<EvaluationResult['policy'], Policy> = {
    reactive: reactivePolicy,
    threshold: thresholdPolicy,
    nemotron: everyTick ? nemotron : eventDriven,
  };
  console.log(`nemotron cadence: ${everyTick ? 'every tick' : 'event-driven (decision_epoch / observation ids change)'}`);

  const rows: EvaluationResult[] = [];
  for (const s of scenarios) {
    for (const name of names) {
      lastKey = null;
      const t0 = Date.now();
      const r = await runScenario(s, policies[name], { policy_name: name });
      rows.push(r);
      console.log(
        [s.scenario_id.padEnd(38), name.padEnd(9), `lost=${r.lost_work_units}`, `delay=${r.job_completion_delay_s}`, `waste=${r.gpu_busy_waste_s}`,
          `unnec=${r.unnecessary_preemptions}`, `unsafeX=${r.unsafe_actions_executed}`, `unsafeB=${r.unsafe_actions_blocked}`,
          `ok=${r.successful_recoveries}`, `fail=${r.failed_recoveries}`, `${((Date.now() - t0) / 1000).toFixed(1)}s`].join(' '),
      );
    }
  }
  console.log('\nSUMMARY');
  for (const p of summarizeResults(rows)) console.log(JSON.stringify(p));
  const out = arg('out');
  if (out) writeFileSync(out, JSON.stringify(rows, null, 2));
  console.log(`nemotron stats: ${JSON.stringify(nemotron.stats())}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
