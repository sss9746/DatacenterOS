import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect } from '@dcos/db-client';
import { runMatrix, type EvaluationAdapter } from './runner.js';

async function main() {
  const args = process.argv.slice(2);
  const adapterIndex = args.indexOf('--adapter');
  const adapterPath = adapterIndex >= 0 ? args[adapterIndex + 1] : process.env.DCOS_EVAL_ADAPTER;
  if (!adapterPath) throw new Error('Evaluation is not ready: P1 has not shipped loadScenarios/runScenario/baseline policies on main. Supply --adapter <team adapter.ts> once those exports and P3 nemotronPolicy are available. See apps/evaluation/README.md. No results were generated.');
  const module = await import(pathToFileURL(resolve(adapterPath)).href) as { default?: EvaluationAdapter };
  if (!module.default || typeof module.default.runScenario !== 'function') throw new Error('The adapter must default-export EvaluationAdapter.');
  const outputIndex = args.indexOf('--out');
  const output = resolve(outputIndex >= 0 ? args[outputIndex + 1] : `results/${new Date().toISOString().replaceAll(':', '-')}`);
  await mkdir(output, { recursive: true });
  const publish = args.includes('--publish');
  if (publish && !process.env.STDB_ADMIN_TOKEN) throw new Error('--publish requires STDB_ADMIN_TOKEN in the environment.');
  const results = await runMatrix(module.default, async (row) => {
    const name = `${encodeURIComponent(row.scenario_id)}-${row.seed}-${row.policy}.json`;
    const path = resolve(output, name);
    await writeFile(`${path}.tmp`, JSON.stringify(row, null, 2)); await rename(`${path}.tmp`, path);
  });
  await writeFile(resolve(output, 'summary.json'), JSON.stringify(results, null, 2));
  if (publish) {
    const client = await connect({ uri: process.env.STDB_URI || 'ws://localhost:3000', db: process.env.STDB_DB || 'dcos-eval', token: process.env.STDB_ADMIN_TOKEN });
    try { for (const row of results.results) await client.publishEvaluationResult(row); } finally { client.close(); }
  }
  console.log(`Wrote ${results.results.length} evaluated policy runs to ${output}. Unfinished-job counts are unavailable in EvaluationResult; Gate 4 is not fully certified.`);
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
