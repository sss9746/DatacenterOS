// P3-8 crash test (ARCHITECTURE §6 kill points a–e).
//
//   SIMULATED CRASH TEST ON IN-MEMORY FAKES (test/fakes FakeDb + FakePhysics).
//   The live version runs against SpacetimeDB later.
//
// For each kill point, worker-1 runs coordinator.execute on a "checkpoint job-a -> migrate job-a" plan
// until the kill point, then "dies" (every further DB call it makes hangs forever; no cleanup, no lease
// release). Wall time advances past the lease, a fresh worker-2 boots and runs resumeOpenWorkflows,
// and we assert exactly one completed checkpoint, no duplicate ledger submissions and no double GPU
// allocation. Run: `pnpm --filter agent exec tsx scripts/crash-test.ts` (exits 1 on any FAIL).

import { pathToFileURL } from 'node:url';
import type { ActionCommand, ObservedSnapshot, PlanCandidate } from '@dcos/contracts';
import { createCoordinator, type ExecutablePlan } from '../src/coordinator.js';
import { createEventPublisher } from '../src/events.js';
import type { DbPort } from '../src/ports.js';
import { CLAIM_LEASE_MS, resumeOpenWorkflows, type ReconcileDecision, type ResumeReport } from '../src/resume.js';
import { buildCommand } from '../src/tools/command.js';
import { FakeDb, FakePhysics } from '../test/fakes/index.js';
import { RUN_ID, gpuId, loadPumpDegradedSnapshot } from '../test/fixtures/index.js';

export const WF = 'wf-crash';
const rack = (r: number) => Array.from({ length: 8 }, (_, g) => gpuId(r, g));
export const COOL_DEST = [...rack(7), ...rack(8)];

export type KillPoint = 'a' | 'b' | 'c' | 'd' | 'e';
export const KILL_POINTS: Record<KillPoint, string> = {
  a: 'before request',
  b: 'after request (ack lost)',
  c: 'after claim',
  d: 'during checkpoint (running)',
  e: 'after checkpoint complete, before next step',
};
/** What the resumed worker should decide for [checkpoint, migrate]. */
export const EXPECTED_DECISIONS: Record<KillPoint, [ReconcileDecision, ReconcileDecision]> = {
  a: ['resubmit_same_key', 'resubmit_same_key'],
  b: ['claim_start', 'resubmit_same_key'],
  c: ['reclaim_after_timeout', 'resubmit_same_key'],
  d: ['wait', 'resubmit_same_key'],
  e: ['skip', 'resubmit_same_key'],
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export function makePlan(snap: ObservedSnapshot): ExecutablePlan {
  const ctx = { runId: RUN_ID, workflowId: WF, incidentIds: ['inc-1'] as [string], planId: 'plan-crash' };
  const ck = buildCommand({ operation: 'checkpoint', target_resource_id: 'job-a', job_id: 'job-a' }, snap, ctx);
  const mv = buildCommand(
    {
      operation: 'migrate_restart',
      target_resource_id: 'job-a',
      job_id: 'job-a',
      arguments: { destination_gpu_ids: COOL_DEST },
      depends_on_command_keys: [ck.command_key],
    },
    snap,
    ctx,
  );
  const commands = [ck, mv];
  const plan: PlanCandidate = {
    schema_version: '1.1.0',
    plan_id: 'plan-crash',
    run_id: RUN_ID,
    workflow_id: WF,
    incident_ids: ['inc-1'],
    based_on_decision_epoch: snap.clock.decision_epoch,
    assumptions: [],
    command_keys: commands.map((c) => c.command_key) as [string, ...string[]],
    expected_completion_delay_sim_s: 150,
    expected_lost_work_units: 0,
    expected_gpu_busy_waste_s: 0,
    failure_risk_estimate: 0.02,
    explanation: 'checkpoint then move job-a off the hot loop',
  };
  return { plan, commands };
}

export interface WorldOptions {
  /** FakeDb claim lease on a claimed-but-never-started action (default 15 000 wall ms). */
  claimLeaseMs?: number;
}

export function makeWorld(opts: WorldOptions = {}) {
  const physics = new FakePhysics();
  const snap = loadPumpDegradedSnapshot();
  const claimLeaseMs = opts.claimLeaseMs ?? CLAIM_LEASE_MS;
  const db = new FakeDb({ snapshot: snap, physics, claimLeaseMs });
  let sim = snap.clock.sim_time_ms;
  const clock = { unixMs: () => 0, simTimeMs: () => sim };
  /** Advance sim time; running jobs make progress (FakeDb doesn't model progress itself). */
  const tick = (ms: number) => {
    db.tick(ms);
    sim += ms;
    db.mutateSnapshot((s) => {
      for (const j of s.job_states) if (j.status === 'running') j.progress_work_units += (16 * ms) / 1000;
    });
  };
  const sleep = async () => tick(1000);
  return { physics, snap, db, clock, tick, sleep, claimLeaseMs };
}

type Phase = 'before' | 'after';
/** A DbPort view for a worker that "dies" at a kill point: from then on every call hangs forever. */
export function killable(db: DbPort, shouldKill: (method: string, args: unknown[], phase: Phase) => boolean) {
  let dead = false;
  let markKilled!: () => void;
  const killed = new Promise<void>((r) => (markKilled = r));
  const hang = () => new Promise<never>(() => undefined);
  const die = () => {
    dead = true;
    markKilled();
    return hang();
  };
  const proxy = new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== 'function') return v;
      const fn = v as (...a: unknown[]) => unknown;
      if (prop === 'onChange') return (cb: Parameters<DbPort['onChange']>[0]) => target.onChange((c) => !dead && cb(c));
      return async (...args: unknown[]) => {
        if (dead) return hang();
        if (shouldKill(String(prop), args, 'before')) return die();
        const res = await fn.apply(target, args);
        if (shouldKill(String(prop), args, 'after')) return die();
        return res;
      };
    },
  });
  return { db: proxy as DbPort, killed, isDead: () => dead };
}

function killRule(point: KillPoint, ck: string, mv: string): (m: string, a: unknown[], p: Phase) => boolean {
  const keyOf = (a: unknown[]) => (typeof a[0] === 'string' ? a[0] : (a[0] as ActionCommand | undefined)?.command_key);
  return (m, a, p) => {
    const k = keyOf(a);
    switch (point) {
      case 'a':
        return m === 'requestAction' && k === ck && p === 'before';
      case 'b':
        return m === 'requestAction' && k === ck && p === 'after';
      case 'c':
        return m === 'claimAction' && k === ck && p === 'after';
      case 'd':
        return m === 'startAction' && k === ck && p === 'after';
      case 'e':
        return m === 'getActionStatus' && k === mv && p === 'before';
    }
  };
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
export interface KillResult {
  point: KillPoint;
  label: string;
  passed: boolean;
  checks: Check[];
  report: ResumeReport | null;
  world: ReturnType<typeof makeWorld>;
  plan: ExecutablePlan;
}

/** Run worker-1 to the kill point, let the lease lapse, resume with worker-2 and check invariants. */
export async function runKillPoint(point: KillPoint, opts: WorldOptions = {}): Promise<KillResult> {
  const world = makeWorld(opts);
  const { db, physics, clock, sleep } = world;
  const plan = makePlan(world.snap);
  const [ck, mv] = plan.commands.map((c) => c.command_key) as [string, string];
  const ckptsBefore = (await db.getObservedSnapshot()).checkpoints.filter((c) => c.job_id === 'job-a' && c.status === 'complete').length;

  // ---- worker-1: run until the kill point, then abandon (no cleanup, no lease release)
  const w1 = killable(db, killRule(point, ck, mv));
  const ev1 = createEventPublisher({ db: w1.db, runId: RUN_ID, clock, redact: (s) => s });
  const c1 = createCoordinator({ db: w1.db, physics, events: ev1, workerId: 'worker-1', clock, pollMs: 1, sleep });
  await c1.ensureWorkflow(WF, ['inc-1']);
  const finished = c1.execute(WF, plan).then(() => 'finished' as const);
  const how = await Promise.race([w1.killed.then(() => 'killed' as const), finished]);
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail });
  check('worker-1 reached kill point', how === 'killed', how);

  // ---- the agent is dead: the DB keeps ticking; wall time passes the workflow lease and the
  // (default 15 s) claim lease, so a claimed-never-started action is re-claimable.
  world.tick(5_000);
  db.advanceWallMs(Math.min(world.claimLeaseMs, CLAIM_LEASE_MS) + 1_000);

  // ---- worker-2 boots and resumes
  const ev2 = createEventPublisher({ db, runId: RUN_ID, clock, redact: (s) => s, startSeq: 1000 });
  const report = await resumeOpenWorkflows({ db, physics, events: ev2, workerId: 'worker-2', clock, sleep });

  const item = report.items.find((i) => i.workflow_id === WF);
  check('resumed_execute', item?.action === 'resumed_execute', `${item?.action}${item?.note ? ` (${item.note})` : ''}`);
  const decisions = item?.reconciled.map((r) => r.decision) ?? [];
  const expected = EXPECTED_DECISIONS[point];
  check('reconcile decisions', decisions.join(',') === expected.join(','), decisions.join(','));

  const after = await db.getObservedSnapshot();
  const ckpts = after.checkpoints.filter((c) => c.job_id === 'job-a' && c.status === 'complete');
  const forKey = ckpts.filter((c) => c.command_key === ck).length;
  check('exactly one new completed checkpoint', ckpts.length - ckptsBefore === 1 && forKey === 1, `new=${ckpts.length - ckptsBefore} for_key=${forKey}`);

  const requests = (k: string) => db.calls.filter((c) => c.method === 'requestAction' && (c.args[0] as ActionCommand).command_key === k).length;
  check('each key submitted once', requests(ck) === 1 && requests(mv) === 1, `ckpt=${requests(ck)} migrate=${requests(mv)}`);

  const gpuIds = after.allocations.map((a) => a.gpu_id);
  const doubled = gpuIds.filter((g, i) => gpuIds.indexOf(g) !== i);
  const jobA = after.job_states.find((j) => j.job_id === 'job-a');
  const onDest = [...(jobA?.allocated_gpu_ids ?? [])].sort().join() === [...COOL_DEST].sort().join();
  check('no double GPU allocation', doubled.length === 0 && onDest, doubled.length ? `doubled ${doubled.join(',')}` : onDest ? 'job-a on 16 cool GPUs' : 'job-a not on planned GPUs');

  check('migrate succeeded', (await db.getActionStatus(mv))?.status === 'succeeded', String((await db.getActionStatus(mv))?.status));
  check('duplicates_detected 0', report.duplicates_detected === 0, String(report.duplicates_detected));
  const resumeEv = db.agentEvents.find((e) => e.stage === 'execute' && e.summary.startsWith('resumed after agent restart'));
  check('resume event emitted', !!resumeEv, resumeEv?.summary ?? 'none');
  const wf = await db.getWorkflow(WF);
  check('workflow done + owned by worker-2', wf?.stage === 'done' && wf.lease_owner === 'worker-2', `${wf?.stage} / ${wf?.lease_owner}`);

  return { point, label: KILL_POINTS[point], passed: checks.every((c) => c.ok), checks, report, world, plan };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('P3-8 crash test: SIMULATED crash test on in-memory fakes (the live version runs against SpacetimeDB later)\n');
  const rows: KillResult[] = [];
  for (const p of Object.keys(KILL_POINTS) as KillPoint[]) rows.push(await runKillPoint(p));
  const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  console.log(`${pad('kill point', 48)} ${pad('result', 6)} reconcile -> notes`);
  console.log('-'.repeat(110));
  for (const r of rows) {
    const item = r.report?.items[0];
    const dec = item?.reconciled.map((x) => x.decision).join(', ') ?? '-';
    const failed = r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    console.log(`${pad(`(${r.point}) ${r.label}`, 48)} ${pad(r.passed ? 'PASS' : 'FAIL', 6)} ${dec}${failed.length ? `  !! ${failed.join(' | ')}` : ''}`);
  }
  const allOk = rows.every((r) => r.passed);
  console.log(`\n${allOk ? 'ALL PASS' : 'FAILURES'}: ${rows.filter((r) => r.passed).length}/${rows.length} kill points; checks per point: ${rows[0]?.checks.map((c) => c.name).join(', ')}`);
  process.exit(allOk ? 0 : 1);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
