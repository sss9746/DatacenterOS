#!/usr/bin/env tsx
// K2 + K3b live proof over the real @dcos/db-client connect(): evaluation provenance round-trip,
// plan read-back, and a finished workflow staying visible.
//
//   STDB_URI=ws://127.0.0.1:3000 STDB_SERVER=local pnpm --filter db exec tsx scripts/provenance-roundtrip.ts <db>
//
// The database argument is required and prod is refused. RESETS run-demo-1 at the start and end, so
// the test rows are gone afterwards. Test rows use zz-* scenario IDs because the table upserts on
// (scenario_id, policy, seed) and a real ID would overwrite a measured result.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import type { EvaluationResult, PlanCandidate } from '@dcos/contracts';
import { connect, isDbError, type DbClient } from '@dcos/db-client';

const DB = process.argv[2];
if (!DB || DB === 'dcos') {
  console.error('usage: provenance-roundtrip.ts <db>  (a dev or local database; prod dcos is refused)');
  process.exit(2);
}
const URI = process.env.STDB_URI ?? 'wss://maincloud.spacetimedb.com';
const SERVER = process.env.STDB_SERVER ?? 'maincloud';
const RUN = 'run-demo-1';

function adminToken(): string {
  if (process.env.STDB_ADMIN_TOKEN) return process.env.STDB_ADMIN_TOKEN;
  const toml = readFileSync(join(homedir(), '.config', 'spacetime', 'cli.toml'), 'utf8');
  const m = /^spacetimedb_token\s*=\s*"([^"]+)"/m.exec(toml);
  if (!m) throw new Error('no STDB_ADMIN_TOKEN and no spacetime CLI login token');
  return m[1]!;
}

function column(resultId: string, name: string): string {
  const r = spawnSync('spacetime', ['sql', '-s', SERVER, '--format', 'json', DB!, `SELECT ${name} FROM evaluation_result WHERE result_id = '${resultId}'`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sql failed: ${r.stderr}`);
  const [res] = JSON.parse(r.stdout) as Array<{ rows: unknown[][] }>;
  return String(res!.rows[0]?.[0]);
}

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
async function expectInvalid(name: string, c: DbClient, row: unknown): Promise<void> {
  try {
    await c.publishEvaluationResult(row as EvaluationResult);
    check(name, false, 'accepted');
  } catch (e) {
    check(name, isDbError(e, 'INVALID_PAYLOAD'), String(e));
  }
}
const until = <T>(what: string, sub: (cb: (v: T) => void) => () => void, ok: (v: T) => boolean): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 15_000);
    let stop: (() => void) | undefined;
    let done = false;
    stop = sub((v) => {
      if (done || !ok(v)) return;
      done = true;
      clearTimeout(timer);
      queueMicrotask(() => stop?.());
      resolve(v);
    });
  });

const examples = createRequire(import.meta.url)('@dcos/contracts/schema/example-payloads.json') as { evaluation_result_provenance: EvaluationResult };

async function main(): Promise<void> {
  console.log(`read-back round-trip on ${DB} (resets ${RUN})`);
  const c = await connect({ uri: URI, db: DB!, token: adminToken() });
  await c.createRun(RUN, 42, 'gpu_demo_8');

  const newRow: EvaluationResult = { ...structuredClone(examples.evaluation_result_provenance), run_id: RUN, scenario_id: 'zz-provenance-new', seed: 1 };
  const { provenance, ...legacy } = newRow;
  const oldRow: EvaluationResult = { ...legacy, scenario_id: 'zz-provenance-old' };
  await c.publishEvaluationResult(newRow);
  await c.publishEvaluationResult(oldRow);

  const rows = await until<EvaluationResult[]>('both rows', (cb) => c.onEvaluation(cb), (v) => ['zz-provenance-new', 'zz-provenance-old'].every((id) => v.some((r) => r.scenario_id === id)));
  const gotNew = rows.find((r) => r.scenario_id === 'zz-provenance-new');
  const gotOld = rows.find((r) => r.scenario_id === 'zz-provenance-old');
  check('new row reads back unchanged', isDeepStrictEqual(gotNew, newRow));
  check('old row reads back unchanged, provenance absent', isDeepStrictEqual(gotOld, oldRow) && gotOld?.provenance === undefined);

  const idNew = `zz-provenance-new/${newRow.policy}/1`;
  const idOld = `zz-provenance-old/${oldRow.policy}/1`;
  check('new row fills policy_version from provenance', column(idNew, 'policy_version') === provenance!.policy_version, column(idNew, 'policy_version'));
  check('new row fills physics_profile_version from provenance', column(idNew, 'physics_profile_version') === provenance!.physics_profile_version, column(idNew, 'physics_profile_version'));
  check('old row keeps both version columns empty', column(idOld, 'policy_version') === '' && column(idOld, 'physics_profile_version') === '');

  const bad = (patch: Record<string, unknown>, drop?: string) => {
    const p: Record<string, unknown> = { ...provenance, ...patch };
    if (drop) delete p[drop];
    return { ...newRow, scenario_id: 'zz-provenance-bad', provenance: p };
  };
  await expectInvalid('extra provenance field → INVALID_PAYLOAD', c, bad({ extra: 1 }));
  await expectInvalid('missing provenance field → INVALID_PAYLOAD', c, bad({}, 'batch_id'));
  await expectInvalid('negative count → INVALID_PAYLOAD', c, bad({ model_requests: -1 }));
  await expectInvalid('bad trace hash → INVALID_PAYLOAD', c, bad({ trace_sha256: 'nope' }));

  const plan: PlanCandidate = {
    schema_version: '1.1.0', plan_id: 'zz-plan', run_id: RUN, workflow_id: 'zz-wf', incident_ids: ['zz-inc'],
    based_on_decision_epoch: 3, assumptions: ['pump degradation persists'], command_keys: ['zz-cmd'],
    expected_completion_delay_sim_s: 150, expected_lost_work_units: 12, expected_gpu_busy_waste_s: 4, failure_risk_estimate: 0.02,
    explanation: 'round-trip test',
  };
  await c.submitPlan(plan);
  const plans = await until('plan', (cb) => c.onPlans(cb), (v) => v.some((p) => p.plan_id === 'zz-plan'));
  check('onPlans returns the submitted plan', isDeepStrictEqual(plans.find((p) => p.plan_id === 'zz-plan'), { ...plan, status: 'proposed' }));

  const lease = await c.claimWorkflow('zz-wf', 'zz-worker', 0, 5_000);
  const handoff = { verification: { verified: true, handoff: 'round-trip handoff' } };
  await c.updateWorkflow('zz-wf', lease.workflow.version, lease.fencing_token, 'done', handoff);
  const wfs = await until('finished workflow', (cb) => c.onWorkflows(cb), (v) => v.some((w) => w.workflow_id === 'zz-wf' && w.stage === 'done'));
  check('onWorkflows keeps a done workflow and its handoff', isDeepStrictEqual(wfs.find((w) => w.workflow_id === 'zz-wf')?.state, handoff));
  check('listOpenWorkflows still drops it', !(await c.listOpenWorkflows()).some((w) => w.workflow_id === 'zz-wf'));

  await c.createRun(RUN, 42, 'gpu_demo_8');
  c.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL ', e instanceof Error ? e.message : e);
  process.exit(1);
});
