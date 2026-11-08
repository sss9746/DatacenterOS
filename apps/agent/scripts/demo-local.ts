// `pnpm --filter agent demo`: the ARCHITECTURE §11 minimum demo end to end on the agent's main loop.
//
//   LOCAL DEMO on in-memory fakes (test/fakes FakeDb + FakePhysics toy model); the live version runs on
//   SpacetimeDB with P1's @dcos/physics. Nemotron is REAL when NIM_API_KEY is set (repo-root .env.local),
//   otherwise everything runs deterministically. The API key is never printed.
//
// Steps: (1) healthy gpu_demo_8 cluster, (2) pump-a degrades (+ rack r1 runs hot), (3) the loop triages one
// incident and plans per job (hot r1 destinations BLOCKED by safety), (4) XID 79 hits job-a's planned
// destination mid-checkpoint -> second incident -> replan -> job-a moves to ANOTHER SAFE placement (healthy
// loop, not the XID GPU, not hot r1; a power cap in place on the degraded loop loses on failure risk),
// (5) the agent is killed during the replanned migrate; the DB keeps going; a NEW worker resumes by command
// key with no duplicate, (6) verify + handoff, (7) summary table. Exit 0 only if every check passes.

import type { ActionCommand, SignalEvent } from '@dcos/contracts';
import { createAgentLoop, type AgentLoop } from '../src/agent-loop.js';
import { loadConfig, redactString, type AgentConfig } from '../src/config.js';
import { createEventPublisher } from '../src/events.js';
import { createLoggingLlm, createNimLlm, LlmUnavailableError, type LlmCallLog } from '../src/llm.js';
import type { AgentEventInput, DbPort, LlmPort } from '../src/ports.js';
import { CLAIM_LEASE_MS } from '../src/resume.js';
import { DEFAULT_LEASE_MS } from '../src/coordinator.js';
import { FakeDb, FakePhysics } from '../test/fakes/index.js';
import { RUN_ID, loadDemoSnapshot, loadPumpDegradedSnapshot, loadSignalXid79Dest } from '../test/fixtures/index.js';
import { killable } from './crash-test.js';

const LLM_CALL_BUDGET = 12;
const HOT_RACK = 'rack-r1';
const DEGRADED_LOOP = 'loop-a';
const TTY = process.stdout.isTTY === true;
const color = (code: number, s: string) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => color(1, s);
const dim = (s: string) => color(2, s);
const STAGE_COLOR: Record<string, number> = { triage: 36, diagnose: 35, plan: 34, safety: 31, execute: 33, replan: 95, verify: 32 };

// ------------------------------------------------------------------------------------------- LLM

interface LlmSetup {
  llm: LlmPort | null;
  mode: string;
  calls: LlmCallLog[];
}

function setupLlm(cfg: AgentConfig): LlmSetup {
  const calls: LlmCallLog[] = [];
  if (!cfg.NIM_API_KEY || !cfg.NIM_MODEL) return { llm: null, mode: 'DETERMINISTIC (no NIM_API_KEY)', calls };
  const logged = createLoggingLlm(createNimLlm(cfg), (e) => {
    calls.push(e);
    const what = e.ok ? `${e.toolNames.join(',') || 'text'} via ${e.model}` : `failed (${e.errorName}) -> deterministic fallback`;
    console.log(`            ${color(92, '[NEMOTRON]')} call #${calls.length}: ${e.latencyMs} ms, ${what}`);
  });
  let used = 0;
  const capped: LlmPort = {
    chat: async (req) => {
      if (used >= LLM_CALL_BUDGET) throw new LlmUnavailableError('demo LLM call budget reached', []);
      used += 1;
      return logged.chat(req);
    },
  };
  return { llm: capped, mode: `LIVE Nemotron (${cfg.NIM_MODEL})`, calls };
}

// ------------------------------------------------------------------------------------------- feed

function printEvent(ev: AgentEventInput, redact: (s: string) => string): void {
  const actor = ev.actor === 'nemotron' ? color(92, '[NEMOTRON]') : dim('[CODE]    ');
  const chip = color(STAGE_COLOR[ev.stage] ?? 37, `[${ev.stage.toUpperCase().padEnd(8)}]`);
  console.log(`  ${dim(`t=${(ev.sim_time_ms / 1000).toFixed(1).padStart(6)}s`)} ${chip} ${actor} ${redact(ev.summary)}`);
  const shown = ev.tool_calls.slice(0, 4);
  for (const t of shown) {
    const who = t.actor === 'nemotron' ? color(92, 'N') : dim('c');
    console.log(dim(`            ${who} ${t.tool}(${redact(t.args_summary).slice(0, 70)}) -> ${redact(t.result_summary).slice(0, 90)}`));
  }
  if (ev.tool_calls.length > shown.length) console.log(dim(`            ... +${ev.tool_calls.length - shown.length} more tool call(s)`));
}

/** DbPort view that prints every F-NV1 event as it is published. */
function withFeed(db: DbPort, redact: (s: string) => string): DbPort {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== 'function') return v;
      const fn = (v as (...a: unknown[]) => unknown).bind(target);
      if (prop !== 'publishAgentEvent') return fn;
      return async (ev: AgentEventInput) => {
        printEvent(ev, redact);
        return fn(ev);
      };
    },
  });
}

const step = (n: number | string, title: string) => console.log(`\n${bold(`STEP ${n}`)}  ${bold(title)}`);

// ------------------------------------------------------------------------------------------- world

function makeWorld() {
  const physics = new FakePhysics();
  // Non-checkpoint/migrate actions (power cap, cordon) take 15 sim-s, so a crash can land while one runs.
  const db = new FakeDb({ snapshot: loadDemoSnapshot(), physics, defaultOpDurationMs: 15_000 });
  const simNow = (): number => {
    let t = 0;
    db.mutateSnapshot((s) => (t = s.clock.sim_time_ms));
    return t;
  };
  const clock = { unixMs: () => Date.now(), simTimeMs: simNow };
  const hooks: Array<() => Promise<void>> = [];
  /** Every agent wait advances the simulated DB by 1 s (the real DB ticks on its own schedule). */
  const sleep = async () => {
    db.tick(1000);
    for (const h of hooks) await h();
  };
  return { physics, db, clock, sleep, hooks, simNow };
}

type World = ReturnType<typeof makeWorld>;

function degradePump(w: World): void {
  const degraded = loadPumpDegradedSnapshot();
  w.db.mutateSnapshot((s) => {
    const sim = Math.max(s.clock.sim_time_ms, degraded.clock.sim_time_ms);
    const epoch = Math.max(s.clock.decision_epoch, degraded.clock.decision_epoch);
    Object.assign(s, structuredClone(degraded));
    s.clock = { ...degraded.clock, sim_time_ms: sim, decision_epoch: epoch };
    // Rack r1 (on the healthy loop-b) also runs hot, so a "cool-looking" destination must be rejected by safety.
    for (const n of s.nodes) if (n.rack_id === HOT_RACK) n.thermal_headroom_c = 3;
  });
  w.db.bumpDecisionEpoch();
}

const destOf = (c: ActionCommand): string[] =>
  c.operation === 'migrate_restart' && Array.isArray(c.arguments.destination_gpu_ids) ? (c.arguments.destination_gpu_ids as string[]) : [];

/** Inject XID 79 on job-a's planned destination once its checkpoint is running. */
function armXidInjection(w: World, onInject: (gpu: string) => void): () => string | null {
  let injected: string | null = null;
  w.hooks.push(async () => {
    if (injected) return;
    const running = w.db.listActions().find((a) => a.status === 'running' && a.command_key.includes(':checkpoint:job-a:'));
    if (!running) return;
    const wf = (await w.db.listOpenWorkflows())[0];
    const cmds = (wf?.state.commands ?? []) as ActionCommand[];
    const dest = cmds.filter((c) => c.job_id === 'job-a').flatMap(destOf)[0];
    if (!dest) return;
    const base = loadSignalXid79Dest();
    const node = dest.replace(/-\d+$/, '');
    const sim = w.simNow();
    const sig: SignalEvent = {
      ...base,
      event_id: `sig-xid79-${dest}-${sim}`,
      resource_id: dest,
      sim_time_ms: sim,
      observed_unix_ms: Date.now(),
      message: `XID 79: GPU has fallen off the bus (${dest})`,
      evidence: { xid_code: 79, gpu_id: dest, node_id: node },
    };
    injected = dest;
    onInject(dest);
    w.db.injectSignal(sig);
  });
  return () => injected;
}

// ------------------------------------------------------------------------------------------- checks

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function collectChecks(w: World, xidGpu: string | null, killedKey: string | null, resume: ReturnType<AgentLoop['lastResume']>): Promise<Check[]> {
  const snap = await w.db.getObservedSnapshot();
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  add('two separate incidents (pump + XID)', w.db.incidents.size >= 2, `${w.db.incidents.size} incident(s)`);
  // loop1 is killed mid-run (no tick report), so count replans from the published F-NV1 events.
  const replans = w.db.agentEvents.filter((e) => e.stage === 'replan' && !e.summary.startsWith('deterministic: replanning')).length;
  add('replanned after XID 79', replans >= 1, `${replans} replan(s)`);
  const jobA = snap.job_states.find((j) => j.job_id === 'job-a');
  const gpus = jobA?.allocated_gpu_ids ?? [];
  const rackOf = (g: string) => snap.nodes.find((n) => n.resource_id === snap.gpus.find((x) => x.resource_id === g)?.node_id)?.rack_id;
  const racks = [...new Set(gpus.map(rackOf))];
  const short = (rs: (string | undefined)[]) => rs.map((r) => r?.replace('rack-', '') ?? '?').join('+');
  const loopARacks = new Set(snap.dependencies.filter((d) => d.relation === 'cooled_by' && d.provider_id === DEGRADED_LOOP).map((d) => d.consumer_id));
  const movedOk = w.db.listActions().some((a) => a.status === 'succeeded' && a.command_key.includes(':migrate_restart:job-a:'));
  const safePlacement =
    movedOk && gpus.length === 16 && !!xidGpu && !gpus.includes(xidGpu) && !racks.some((r) => r === HOT_RACK || (r !== undefined && loopARacks.has(r)));
  add(
    'job-a moved to a safe placement (not loop-a, not XID GPU)',
    safePlacement,
    `${movedOk ? 'moved to' : 'still on'} ${short(racks)}; loop-a cools ${short([...loopARacks].sort())}; XID on ${xidGpu ?? '-'}`,
  );
  const perKey = new Map<string, number>();
  for (const c of snap.checkpoints) if (c.status === 'complete' && c.command_key) perKey.set(c.command_key, (perKey.get(c.command_key) ?? 0) + 1);
  const dupCkpt = [...perKey.values()].filter((n) => n > 1).length;
  const reqs = new Map<string, number>();
  for (const c of w.db.calls) if (c.method === 'requestAction') {
    const k = (c.args[0] as ActionCommand).command_key;
    reqs.set(k, (reqs.get(k) ?? 0) + 1);
  }
  const dupReq = [...reqs.values()].filter((n) => n > 1).length;
  const owners = new Map<string, string>();
  let doubleAlloc = 0;
  for (const a of snap.allocations) {
    const prev = owners.get(a.gpu_id);
    if (prev && prev !== a.job_id) doubleAlloc += 1;
    owners.set(a.gpu_id, a.job_id);
  }
  add('no duplicates', dupCkpt === 0 && dupReq === 0 && doubleAlloc === 0 && (resume?.duplicates_detected ?? 0) === 0, `checkpoints ${dupCkpt}, resubmits ${dupReq}, double-alloc ${doubleAlloc}`);
  const item = resume?.items[0];
  const killed = item?.reconciled.find((r) => r.command_key === killedKey);
  add('crash resumed by command key', !!killedKey && item?.action === 'resumed_execute' && killed?.decision === 'wait', `${item?.action ?? 'no resume'}; ${killedKey?.split(':').slice(1).join(':') ?? '-'} running -> ${killed?.decision ?? '-'}`);
  const wf = [...(await w.db.listOpenWorkflows())];
  add('workflow closed (no open workflows)', wf.length === 0, wf.map((x) => `${x.workflow_id}:${x.stage}`).join(',') || 'none open');
  return checks;
}

// ------------------------------------------------------------------------------------------- main

async function main(): Promise<number> {
  console.log(bold('DataCenterOS agent: LOCAL DEMO on in-memory fakes; live version runs on SpacetimeDB'));
  console.log(dim('(FakeDb + FakePhysics toy model stand in for P2 SpacetimeDB and P1 @dcos/physics)'));
  const cfg = loadConfig();
  const redact = (s: string) => redactString(s, cfg);
  const llm = setupLlm(cfg);
  console.log(`LLM: ${bold(llm.mode)}  (budget ${LLM_CALL_BUDGET} calls)`);

  const w = makeWorld();
  const feedDb = withFeed(w.db, redact);

  // ---- (1)
  step(1, 'gpu_demo_8: 8 racks, 64 GPUs, 3 jobs with initial checkpoints (healthy)');
  let replanned = false;
  let killedKey: string | null = null;
  const w1 = killable(feedDb, (method, args, phase) => {
    if (method === 'publishAgentEvent' && (args[0] as AgentEventInput).stage === 'replan') replanned = true;
    if (!replanned || method !== 'startAction' || phase !== 'after') return false;
    const key = String(args[0]);
    if (!key.endsWith(':2')) return false;
    killedKey = key;
    return true;
  });
  const ev1 = createEventPublisher({ db: w1.db, runId: RUN_ID, clock: w.clock, redact });
  const loop1 = createAgentLoop({ db: w1.db, physics: w.physics, llm: llm.llm, events: ev1, workerId: 'agent-demo-1', runId: RUN_ID, clock: w.clock, sleep: w.sleep, log: (m) => console.log(dim(`            agent-demo-1: ${m}`)) });
  const healthy = await loop1.runOnce();
  console.log(`  runOnce -> ${healthy.status}: ${healthy.incidents.length} incident(s), cluster healthy`);

  // ---- (2)
  step(2, 'inject pump-a degradation (loop-a cools r2-r4); rack r1 also runs hot');
  degradePump(w);
  const snap = await w.db.getObservedSnapshot();
  const hot = snap.gpus.filter((g) => g.temp_c >= 85).length;
  console.log(`  pump-a ${snap.cooling.find((c) => c.resource_id === 'pump-a')?.operating_state}; ${hot} GPUs >= 85 C; ${HOT_RACK} headroom 3 C`);

  // ---- (3) + (4)
  step(3, 'agent loop: triage -> diagnose -> plan (keep / cap / checkpoint+relocate, safety-checked)');
  const xidGpu = armXidInjection(w, (gpu) => {
    step(4, `XID 79 on ${gpu} = job-a's planned destination, mid-checkpoint -> second incident -> replan to another safe placement`);
  });
  const run1 = loop1.runOnce();
  const outcome = await Promise.race([w1.killed.then(() => 'killed' as const), run1.then(() => 'finished' as const)]);

  // ---- (5)
  const killedOp = (killedKey as string | null)?.split(':')[1] ?? '(nothing)';
  step(5, `agent process killed during the replanned ${killedOp} (${killedKey ?? '-'}); SpacetimeDB (fake) keeps ticking`);
  if (outcome !== 'killed') console.log('  !! the kill point was never reached');
  w.db.tick(5_000);
  const during = killedKey ? await w.db.getActionStatus(killedKey) : null;
  console.log(`  ledger: ${killedKey} is ${during?.status ?? 'absent'} under DB supervision; leases lapse`);
  w.db.advanceWallMs(Math.max(CLAIM_LEASE_MS, DEFAULT_LEASE_MS) + 1_000);
  console.log('  relaunch: NEW worker agent-demo-2 boots -> resumeOpenWorkflows reconciles every command_key');
  const ev2 = createEventPublisher({ db: feedDb, runId: RUN_ID, clock: w.clock, redact, startSeq: ev1.nextSeq() + 1000 });
  const loop2 = createAgentLoop({ db: feedDb, physics: w.physics, llm: llm.llm, events: ev2, workerId: 'agent-demo-2', runId: RUN_ID, clock: w.clock, sleep: w.sleep, log: (m) => console.log(dim(`            agent-demo-2: ${m}`)) });
  await loop2.start();
  await loop2.stop();
  const resume = loop2.lastResume();
  for (const it of resume?.items ?? []) {
    console.log(`  resume ${it.workflow_id}: ${it.action}; ${it.reconciled.map((r) => `${r.command_key.split(':').slice(1).join(':')} ${r.ledger_status ?? 'absent'} -> ${r.decision}`).join(', ')}`);
  }

  // ---- (6)
  step(6, 'verify + operator handoff');
  const wfId = resume?.items[0]?.workflow_id;
  const wf = wfId ? await w.db.getWorkflow(wfId) : null;
  const verification = wf?.state.verification as { handoff?: string; verified?: boolean } | undefined;
  console.log(`  workflow ${wfId ?? '-'} stage=${wf?.stage ?? '-'} verified=${verification?.verified ?? false}`);
  console.log(`  handoff: ${redact(verification?.handoff ?? '(none)')}`);

  // ---- (7)
  step(7, 'summary');
  const checks = await collectChecks(w, xidGpu(), killedKey, resume);
  printSummary(w, llm, checks);
  return checks.every((c) => c.ok) ? 0 : 1;
}

function printSummary(w: World, llm: LlmSetup, checks: Check[]): void {
  const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
  console.log(`  ${bold('incidents')}`);
  for (const i of w.db.incidents.values()) console.log(`    ${pad(i.incident_id, 34)} ${pad(i.state, 12)} ${i.title.slice(0, 70)}`);
  const byStatus = new Map<string, number>();
  for (const a of w.db.listActions()) byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
  console.log(`  ${bold('actions')}    ${[...byStatus].map(([s, n]) => `${s} ${n}`).join(', ')}`);
  for (const a of w.db.listActions()) console.log(dim(`    ${pad(a.command_key, 46)} ${a.status}${a.reason_code ? ` (${a.reason_code})` : ''}`));
  const ok = llm.calls.filter((c) => c.ok);
  const avg = ok.length ? Math.round(ok.reduce((s, c) => s + c.latencyMs, 0) / ok.length) : 0;
  console.log(`  ${bold('nemotron')}   ${llm.mode}: ${llm.calls.length} call(s), ${ok.length} ok, ${llm.calls.length - ok.length} failed, avg latency ${avg} ms`);
  console.log(`  ${bold('feed')}       ${w.db.agentEvents.length} agent events (${w.db.agentEvents.filter((e) => e.actor === 'nemotron').length} by Nemotron)`);
  console.log(`  ${bold('checks')}`);
  for (const c of checks) console.log(`    ${c.ok ? color(32, 'PASS') : color(31, 'FAIL')}  ${pad(c.name, 58)} ${c.detail}`);
  console.log(`\n${checks.every((c) => c.ok) ? bold('DEMO OK') : bold('DEMO FAILED')}  (LOCAL DEMO on in-memory fakes; live version runs on SpacetimeDB)`);
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error('demo crashed:', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    process.exit(1);
  },
);
