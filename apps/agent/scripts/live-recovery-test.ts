// R5 live recovery harness (TASKS R5, SCOPE §5-6, SUVAN.md S5).
//
//   pnpm --filter agent live-recovery --db dcos-dev --case L1            one case
//   pnpm --filter agent live-recovery --db dcos-dev --case all --speed 2  all six
//   pnpm --filter agent live-recovery --db dcos-dev --case L3 --no-llm    DETERMINISTIC rehearsal (labeled)
//   pnpm --filter agent live-recovery --db dcos-dev --case L2 --hold-s 45 hold the Verified state 45 s for recording
//   pnpm --filter agent live-recovery --db dcos-dev --case L7            TWO agents (agent-alpha@loop-a, agent-beta@loop-b)
//                                                                       coordinate via the DB; the pump owner is killed
//   pnpm --filter agent live-recovery --db dcos-dev --case L8            3 incidents, 2 agents: third claimed when one frees up
//
// What it does, per case: controlled reset with the agent stopped (never on prod) -> spawn the REAL agent as
// a child process (same entry as `pnpm --filter agent start`) -> inject faults through the admin reducer ->
// wait on observed DB state with bounded wall-time waits (no fixed sleeps) -> SIGKILL / probe -> assert from
// public ledger + snapshot rows -> write <out>/<case>.json, run.json and report.md (all redacted).
//
// Env (process.env wins over repo-root .env.local): STDB_URI, STDB_ADMIN_TOKEN (harness only; never passed to
// the agent, never logged), STDB_AGENT_TOKEN (passed to the agent child), NIM_* (passed through).
// Exit: 0 all selected cases passed, 1 any failed, 2 usage/config refusal.

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect, type DbClient } from '@dcos/db-client';
import { readEnvLocal, repoRoot } from '../src/config.js';
import { ArgsError, parseArgs, resolveTarget, USAGE, type HarnessArgs } from './live/args.js';
import { runCase, type CaseEnv } from './live/cases.js';
import { createRedactor, describeEnv, secretsFromEnv, type Redactor } from './live/redact.js';
import { writeArtifacts, type CaseArtifact, type RunArtifact, type RunMeta } from './live/report.js';
import { pace } from './live/wait.js';

const DEFAULT_URI = 'wss://maincloud.spacetimedb.com';

function gitInfo(): { commit: string; branch: string | null } {
  const git = (args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: repoRoot(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  const commit = git(['rev-parse', 'HEAD']) ?? 'unknown';
  const dirty = git(['status', '--porcelain']);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  return { commit: dirty ? `${commit}-dirty` : commit, branch };
}

function defaultOutDir(args: HarnessArgs): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return resolve(repoRoot(), 'apps', 'agent', 'live-results', `${ts}-${args.db}`);
}

function requireEnv(env: Record<string, string | undefined>, keys: string[]): void {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) throw new ArgsError(`missing required env vars: ${missing.join(', ')} (set them in the environment or repo-root .env.local)`);
}

async function main(argv: string[]): Promise<number> {
  let args: HarnessArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`live-recovery-test: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const env: Record<string, string | undefined> = { ...readEnvLocal(), ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) };
  const redact: Redactor = createRedactor(secretsFromEnv(env));
  const log = (m: string) => console.log(redact(`${new Date().toISOString().slice(11, 23)} ${m}`));

  let target;
  try {
    target = resolveTarget(args);
    requireEnv(env, ['STDB_ADMIN_TOKEN', 'STDB_AGENT_TOKEN']);
  } catch (e) {
    console.error(`live-recovery-test: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const uri = env.STDB_URI || DEFAULT_URI;
  const outDir = args.outDir ? resolve(args.outDir) : defaultOutDir(args);
  mkdirSync(outDir, { recursive: true });

  const git = gitInfo();
  const llmMode: RunMeta['llm_mode'] = args.noLlm ? 'deterministic_no_llm' : env.NIM_API_KEY && env.NIM_MODEL ? 'live_nim' : 'deterministic_no_llm';
  const meta: RunMeta = {
    harness: 'live-recovery-test',
    commit: git.commit,
    branch: git.branch,
    db: args.db,
    run_id: args.runId,
    seed: args.seed,
    speed: args.speed,
    preset_id: args.presetId,
    model: args.noLlm ? 'deterministic (no LLM)' : env.NIM_MODEL || 'deterministic (NIM_MODEL unset)',
    llm_mode: llmMode,
    reset_performed: target.willReset,
    started_unix_ms: Date.now(),
    node: process.version,
    platform: `${process.platform} ${hostname()}`,
  };
  log(`target db=${args.db}${target.isProd ? ' (PRODUCTION, acknowledged; no reset)' : ''} run=${args.runId} seed=${args.seed} speed=${args.speed} cases=${args.cases.join(',')} timeout=${args.timeoutS}s${args.holdS > 0 ? ` hold=${args.holdS}s` : ''}`);
  log(`commit ${meta.commit} model=${meta.model} mode=${meta.llm_mode} out=${outDir}`);
  log(`env ${JSON.stringify(describeEnv(env, ['STDB_URI', 'STDB_DB', 'STDB_ADMIN_TOKEN', 'STDB_AGENT_TOKEN', 'NIM_BASE_URL', 'NIM_API_KEY', 'NIM_MODEL']))}`);
  if (!args.noLlm && llmMode !== 'live_nim') log('NOTE: NIM_API_KEY/NIM_MODEL unset -> the agent runs deterministically; evidence is labeled as a rehearsal, not a Nemotron claim');

  log('connecting admin client');
  const admin: DbClient = await connect({ uri, db: args.db, token: env.STDB_ADMIN_TOKEN, runId: args.runId });
  const caseEnv: CaseEnv = { args, target, meta, admin, env, uri, agentToken: env.STDB_AGENT_TOKEN!, redact, log };

  const cases: CaseArtifact[] = [];
  const flush = (): RunArtifact => {
    const run: RunArtifact = { meta, cases, passed: cases.length > 0 && cases.every((c) => c.passed) };
    const paths = writeArtifacts(outDir, run, redact);
    log(`artifacts: ${paths.markdown}`);
    return run;
  };
  let interrupted = false;
  const onSig = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    log('interrupted: writing partial artifacts');
    flush();
    admin.close();
    process.exit(130);
  };
  process.once('SIGINT', onSig);
  process.once('SIGTERM', onSig);

  // --hold-s: pacing only (never correctness). The final DB state of a case stays on the dashboard until the
  // next case's reset, so a presenter/recorder can capture the Verified + handoff state.
  const holdFinalState = async (): Promise<void> => {
    if (args.holdS <= 0) return;
    log(`holding final state for ${args.holdS}s (for recording)`);
    await pace(args.holdS * 1_000);
  };

  for (const id of args.cases) {
    log(`===== ${id} =====`);
    const art = await runCase(id, caseEnv);
    cases.push(art);
    log(`===== ${id} ${art.passed ? 'PASS' : 'FAIL'} (${art.checks.filter((c) => c.ok).length}/${art.checks.length} checks, ${((art.ended_unix_ms - art.started_unix_ms) / 1000).toFixed(0)} s) =====`);
    flush();
    await holdFinalState();
  }
  const run = flush();
  admin.close();
  console.log('');
  console.log(redact(`${run.passed ? 'ALL PASS' : 'FAILURES'}: ${cases.filter((c) => c.passed).length}/${cases.length} cases on ${args.db} @ ${meta.commit} (${meta.llm_mode})`));
  for (const c of cases) if (!c.passed) for (const r of c.failure_reasons) console.log(redact(`  ${c.case}: ${r}`));
  return run.passed ? 0 : 1;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      // Build a fresh redactor: the error may embed a connection URL or token we never printed elsewhere.
      const r = createRedactor(secretsFromEnv({ ...readEnvLocal(), ...process.env }));
      console.error(r(`live-recovery-test: fatal ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`));
      process.exit(1);
    },
  );
}
