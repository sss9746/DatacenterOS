import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect } from '@dcos/db-client';
import { runMatrix, type EvaluationAdapter } from './runner.js';

const flagValue = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v !== undefined && !v.startsWith('--') ? v : undefined;
};

/** Exact tested commit, read once here and passed into the adapter (the adapter never shells out). */
function gitHead(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

async function loadAdapter(args: string[], out: string, batchId: string) {
  const adapterPath = flagValue(args, '--adapter') ?? process.env.DCOS_EVAL_ADAPTER;
  if (adapterPath) {
    const module = await import(pathToFileURL(resolve(adapterPath)).href) as { default?: EvaluationAdapter };
    if (!module.default || typeof module.default.runScenario !== 'function') throw new Error('The adapter must default-export EvaluationAdapter.');
    return { adapter: module.default, manifest: null as null | (() => Record<string, unknown>) };
  }
  // Default: the checked-in team adapter (P1 runner + real baseline policies + fresh P3 Nemotron policy per case).
  const cases = flagValue(args, '--cases') ?? 'fixed12';
  if (cases !== 'fixed12' && cases !== 'all') throw new Error('--cases must be fixed12 or all.');
  const { createTeamAdapter, selectCases } = await import('./team-adapter.js');
  const { loadScenarios } = await import('../../../packages/physics/src/gpu/index.js');
  const caseIds = selectCases(loadScenarios(), cases).map((s) => s.scenario_id);
  const maxLive = flagValue(args, '--max-live-calls');
  const team = createTeamAdapter({
    batchId, codeRevision: gitHead(), outDir: out, caseIds, noLlm: args.includes('--no-llm'),
    ...(maxLive ? { maxLiveCalls: Number(maxLive) } : {}),
  });
  return { adapter: team, manifest: () => team.manifest() };
}

async function writeJson(path: string, value: unknown) {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`); await rename(`${path}.tmp`, path);
}

async function main() {
  const args = process.argv.slice(2);
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const output = resolve(flagValue(args, '--out') ?? `results/${stamp}`);
  const batchId = flagValue(args, '--batch-id') ?? `batch-${stamp}`;
  await mkdir(output, { recursive: true });
  const { adapter, manifest } = await loadAdapter(args, output, batchId);
  const publish = args.includes('--publish');
  if (publish && !process.env.STDB_ADMIN_TOKEN) throw new Error('--publish requires STDB_ADMIN_TOKEN in the environment.');
  const results = await runMatrix(adapter, async (row) => {
    await writeJson(resolve(output, 'rows', `${encodeURIComponent(row.scenario_id)}-${row.seed}-${row.policy}.json`), row);
  });
  await writeJson(resolve(output, 'summary.json'), results);
  if (manifest) await writeJson(resolve(output, 'manifest.json'), manifest());
  if (publish) {
    const client = await connect({ uri: process.env.STDB_URI || 'ws://localhost:3000', db: process.env.STDB_DB || 'dcos-eval', token: process.env.STDB_ADMIN_TOKEN });
    try { for (const row of results.results) await client.publishEvaluationResult(row); } finally { client.close(); }
  }
  const noModel = results.results.some((r) => r.policy === 'nemotron' && r.provenance && !r.provenance.model_enabled);
  console.log(`Wrote ${results.results.length} validated policy rows (batch ${batchId}) to ${output}.${noModel ? ' DETERMINISTIC-ONLY: Nemotron rows ran without a model (model_enabled=false); not a Nemotron performance claim.' : ''} Delay is a finite-horizon work deficit.`);
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
