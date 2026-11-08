// WP-B1: team-mode wiring in the agent loop. Uses a fake OptionChooser; the feed formatter is mocked so these tests
// pin the loop's ordering, not WP-A's wording.
import type { ActionCommand, SignalEvent } from '@dcos/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentLoop, type AgentLoop, type AgentLoopDeps } from '../src/agent-loop.js';
import { createEventPublisher, type EventPublisher } from '../src/events.js';
import type { ChooserInput, OptionChooser } from '../src/planner.js';
import { planStaleReason } from '../src/replan.js';
import type { TeamTrace } from '../src/team/protocol.js';
import { FakeDb, FakeLlm, FakePhysics } from './fakes/index.js';
import { RUN_ID, loadPumpDegradedSnapshot, loadSignalXid79Dest, loadSignalXid79R7 } from './fixtures/index.js';

vi.mock('../src/team/protocol.js', () => ({
  TEAM_ROLES: ['cooling', 'workload', 'lead'],
  teamFeedEvents: (trace: TeamTrace, incidentId?: string) =>
    ['Cooling → Workload: first', 'Workload → Lead: second'].map((summary) => ({
      stage: 'plan',
      summary: `${trace.round_id} ${summary}`,
      actor: 'nemotron',
      toolCalls: [{ tool: 'team_message', args_summary: 'x', result_summary: 'y' }],
      incidentId,
    })),
}));

const macrotask = (ms = 3) => new Promise<void>((r) => setTimeout(r, ms));

function world() {
  const physics = new FakePhysics();
  const db = new FakeDb({ snapshot: loadPumpDegradedSnapshot(), physics });
  const simNow = () => {
    let t = 0;
    db.mutateSnapshot((s) => (t = s.clock.sim_time_ms));
    return t;
  };
  const clock = { unixMs: () => 0, simTimeMs: simNow };
  const hooks: Array<() => Promise<void> | void> = [];
  const sleep = async () => {
    db.tick(1000);
    for (const h of hooks) await h();
  };
  return { physics, db, clock, sleep, hooks, simNow };
}
type World = ReturnType<typeof world>;

const loops: AgentLoop[] = [];
function makeLoop(w: World, over: Partial<AgentLoopDeps> = {}): AgentLoop {
  const events = over.events ?? createEventPublisher({ db: w.db, runId: RUN_ID, clock: w.clock, redact: (s) => s });
  const loop = createAgentLoop({ db: w.db, physics: w.physics, llm: null, events, workerId: 'worker-1', runId: RUN_ID, clock: w.clock, sleep: w.sleep, log: () => undefined, pollMs: 50, debounceMs: 10, ...over });
  loops.push(loop);
  return loop;
}
afterEach(async () => {
  for (const l of loops.splice(0)) await l.stop();
});

const trace = (roundId: string): TeamTrace => ({
  version: 1,
  round_id: roundId,
  snapshot_sim_ms: 0,
  model: 'fake',
  calls_used: 3,
  wall_ms: 10,
  outcome: 'deterministic',
  messages: [],
  covers: [],
  missing_roles: [],
});

/** Deterministic choices (null), like a failed Lead, plus an optional action during the "round". */
function fakeChooser(during?: (input: ChooserInput) => void | Promise<void>) {
  const calls: ChooserInput[] = [];
  const chooser: OptionChooser = async (input) => {
    calls.push(input);
    await during?.(input);
    return { choices: null, team: trace(`${input.workflowId}:a${input.attempt}`) };
  };
  return { chooser, calls };
}

const destOf = (c: ActionCommand): string[] =>
  c.operation === 'migrate_restart' ? ((c.arguments.destination_gpu_ids as string[] | undefined) ?? []) : [];

const xidOn = (w: World, gpu: string, n = 0): SignalEvent => {
  const sim = w.simNow();
  return { ...loadSignalXid79Dest(), event_id: `sig-xid-${gpu}-${sim}-${n}`, resource_id: gpu, sim_time_ms: sim, evidence: { xid_code: 79, gpu_id: gpu } };
};

/** Idle GPU on a healthy rack: unrelated to the pump incident and to every plan. */
const R7_GPU = loadSignalXid79R7().resource_id;

const openCommands = async (w: World): Promise<ActionCommand[]> => ((await w.db.listOpenWorkflows())[0]?.state.commands ?? []) as ActionCommand[];
const readsOf = (w: World): number => w.db.calls.filter((c) => c.method === 'getEvidence' && (c.args[0] as string[]).length === 0).length;
/** Lets the real-timer watch run while the fake execution would otherwise finish on microtasks alone. */
const yieldToWatch = (w: World) => w.hooks.push(() => macrotask());

const r7Incident = (ids: string[]) => ids.filter((id) => id.includes('compute') && id.includes(R7_GPU));

describe('team mode wiring', () => {
  it('the chooser reaches plan() and runReplan, and triage never calls the model', async () => {
    const w = world();
    const { chooser, calls } = fakeChooser();
    let injected = false;
    w.hooks.push(async () => {
      if (injected) return;
      if (!w.db.listActions().some((a) => a.status === 'running' && a.command_key.includes(':checkpoint:job-a:'))) return;
      const dest = (await openCommands(w)).flatMap(destOf)[0];
      if (!dest) return;
      injected = true;
      w.db.injectSignal(xidOn(w, dest));
    });
    const llm = new FakeLlm();
    const r = await makeLoop(w, { chooser, llm }).runOnce();
    expect(r.replans).toHaveLength(1);
    expect(calls.map((c) => c.attempt)).toEqual([1, 2]);
    expect(llm.requests).toHaveLength(0);
  });

  it('single mode (no chooser): triage and planner still use the LLM, and no team state or feed appears', async () => {
    const w = world();
    const llm = new FakeLlm(Array.from({ length: 4 }, () => FakeLlm.text('no tool')));
    const r = await makeLoop(w, { llm, incidentWatchMs: 1 }).runOnce();
    expect(r.verification?.verified).toBe(true);
    expect(llm.requests.length).toBeGreaterThan(0);
    expect((await w.db.getWorkflow(r.workflow_id!))?.state.team).toBeUndefined();
    expect(w.db.agentEvents.some((e) => e.tool_calls.some((t) => t.tool === 'team_message'))).toBe(false);
  });

  it('a new fault during single-mode execution stays out of the running workflow', async () => {
    const w = world();
    let injected = false;
    w.hooks.push(async () => {
      if (!injected && w.db.listActions().some((a) => a.status === 'running')) {
        injected = true;
        w.db.injectSignal(xidOn(w, R7_GPU));
      }
      await macrotask();
    });
    const r = await makeLoop(w, { incidentWatchMs: 1 }).runOnce();
    expect(r.replans).toHaveLength(0);
    expect(r.new_incident_ids).toHaveLength(1);
  });

  it('persists team before publishing its feed events, in order', async () => {
    const w = world();
    const { chooser } = fakeChooser();
    const inner = createEventPublisher({ db: w.db, runId: RUN_ID, clock: w.clock, redact: (s) => s });
    const seen: { summary: string; team: unknown }[] = [];
    const events: EventPublisher = {
      ...inner,
      emit: async (stage, input) => {
        if (input.toolCalls?.some((t) => t.tool === 'team_message')) {
          const wf = await w.db.getWorkflow(input.workflowId!);
          seen.push({ summary: input.summary, team: wf?.state.team });
        }
        return inner.emit(stage, input);
      },
    };
    const r = await makeLoop(w, { chooser, events }).runOnce();
    const roundId = `${r.workflow_id}:a1`;
    expect(seen.map((s) => s.summary)).toEqual([`${roundId} Cooling → Workload: first`, `${roundId} Workload → Lead: second`]);
    for (const s of seen) expect((s.team as TeamTrace).round_id).toBe(roundId);
    expect(((await w.db.getWorkflow(r.workflow_id!))?.state.team as TeamTrace).round_id).toBe(roundId);
  });

  it('after a replan, state.team is the new round and its events follow that write', async () => {
    const w = world();
    const { chooser } = fakeChooser();
    let injected = false;
    w.hooks.push(async () => {
      if (injected || !w.db.listActions().some((a) => a.status === 'running' && a.command_key.includes(':checkpoint:job-a:'))) return;
      const dest = (await openCommands(w)).flatMap(destOf)[0];
      if (!dest) return;
      injected = true;
      w.db.injectSignal(xidOn(w, dest));
    });
    const inner = createEventPublisher({ db: w.db, runId: RUN_ID, clock: w.clock, redact: (s) => s });
    const rounds: string[] = [];
    const events: EventPublisher = {
      ...inner,
      emit: async (stage, input) => {
        if (input.toolCalls?.some((t) => t.tool === 'team_message') && input.summary.includes(':a2 ')) {
          rounds.push(((await w.db.getWorkflow(input.workflowId!))?.state.team as TeamTrace).round_id);
        }
        return inner.emit(stage, input);
      },
    };
    const r = await makeLoop(w, { chooser, events }).runOnce();
    expect(r.replans).toHaveLength(1);
    expect(rounds).toEqual([`${r.workflow_id}:a2`, `${r.workflow_id}:a2`]);
  });
});

describe('post-round freshness', () => {
  /** Fail the plan's future destination while the round is deliberating: rank-1 is known from the ranked options. */
  const failDestinationDuringRound = (w: World, onlyAttempt = 1) =>
    fakeChooser((input) => {
      if (input.attempt !== onlyAttempt) return;
      const dest = [...input.ranked.values()].flatMap((opts) => opts.flatMap((o) => o.commands.flatMap(destOf)))[0];
      if (dest) w.db.injectSignal(xidOn(w, dest));
    });

  it('a resource failing during the round triggers a replan before anything executes', async () => {
    const w = world();
    const { chooser, calls } = failDestinationDuringRound(w);
    const r = await makeLoop(w, { chooser }).runOnce();
    expect(r.replans).toHaveLength(1);
    expect(r.replans[0]!.reason).toContain('changed during the team round');
    expect(calls.map((c) => c.attempt)).toEqual([1, 2]);
    // Attempt 1 never reached the executor.
    expect(w.db.listActions().every((a) => a.command_key.endsWith(':2'))).toBe(true);
    expect(r.executions).toHaveLength(1);
    expect(r.verification?.verified).toBe(true);
  });

  it('cannot loop past the replan limit when every round goes stale', async () => {
    const w = world();
    let n = 0;
    const { chooser, calls } = fakeChooser((input) => {
      // choices: null means each job takes its top eligible option, so killing those destinations makes every round stale.
      const top = [...input.ranked.values()].flatMap((opts) => opts.filter((o) => !o.excluded_reason).slice(0, 1));
      for (const dest of top.flatMap((o) => o.commands.flatMap(destOf))) w.db.injectSignal(xidOn(w, dest, n++));
    });
    const r = await makeLoop(w, { chooser, maxReplans: 1 }).runOnce();
    expect(calls.map((c) => c.attempt)).toEqual([1, 2]);
    expect(r.replans).toHaveLength(1);
    expect(r.escalated).toBe(true);
    const wf = await w.db.getWorkflow(r.workflow_id!);
    expect(wf?.stage).toBe('escalated');
    expect(String(wf?.state.escalation_reason)).toContain('replan limit (1) reached');
    expect(w.db.listActions()).toHaveLength(0);
  });

  it('no stale replan when nothing material changed during the round', async () => {
    const w = world();
    const { chooser } = fakeChooser();
    const r = await makeLoop(w, { chooser }).runOnce();
    expect(r.replans).toHaveLength(0);
    expect(r.verification?.verified).toBe(true);
  });

  it('planStaleReason ignores routine drift and names a failed destination', async () => {
    const w = world();
    const { chooser } = fakeChooser();
    const r = await makeLoop(w, { chooser }).runOnce();
    const plan = r.plans[0]!;
    const dest = plan.commands.flatMap(destOf)[0]!;
    const before = loadPumpDegradedSnapshot();
    const drift = structuredClone(before);
    for (const g of drift.gpus) g.temp_c += 1;
    expect(planStaleReason(plan, before, drift)).toBeNull();
    const failed = structuredClone(before);
    const gpu = failed.gpus.find((g) => g.resource_id === dest)!;
    gpu.availability = 'unreachable';
    gpu.last_xid_code = 79;
    expect(planStaleReason(plan, before, failed)).toContain(dest);
  });
});

describe('new-incident watch (team mode)', () => {
  it('a new unrelated incident during execution triggers exactly one replan and is folded in', async () => {
    const w = world();
    yieldToWatch(w);
    const { chooser } = fakeChooser();
    let injected = false;
    w.hooks.push(() => {
      if (injected || !w.db.listActions().some((a) => a.status === 'running')) return;
      injected = true;
      w.db.injectSignal(xidOn(w, R7_GPU));
    });
    const r = await makeLoop(w, { chooser, incidentWatchMs: 1 }).runOnce();
    expect(injected).toBe(true);
    expect(r.replans).toHaveLength(1);
    expect(r.replans[0]!.reason).toContain('new incident during execution');
    expect(r7Incident(r.replans[0]!.new_incident_ids)).toHaveLength(1);
    expect(r7Incident((await w.db.getWorkflow(r.workflow_id!))!.incident_ids)).toHaveLength(1);
    expect(r.verification?.verified).toBe(true);
  });

  it('a fault during the last command is caught before verify, without waiting for a timer tick', async () => {
    const w = world();
    const { chooser } = fakeChooser();
    let injected = false;
    w.hooks.push(async () => {
      if (injected) return;
      // A short command can finish within one fake tick, so "submitted" is the reliable sign it is the last one in play.
      const last = (await openCommands(w)).at(-1);
      if (!last || !w.db.listActions().some((a) => a.command_key === last.command_key)) return;
      injected = true;
      w.db.injectSignal(xidOn(w, R7_GPU));
    });
    // The timer never fires in this test: only the pre-verify read can see the fault.
    const r = await makeLoop(w, { chooser, incidentWatchMs: 3_600_000 }).runOnce();
    expect(injected).toBe(true);
    expect(r.executions[0]!.aborted).toBe(false);
    expect(r.replans).toHaveLength(1);
    expect(r7Incident(r.replans[0]!.new_incident_ids)).toHaveLength(1);
    expect(r.verification).not.toBeNull();
  });

  it('repeated identical candidates do not burn replans', async () => {
    const w = world();
    yieldToWatch(w);
    const { chooser } = fakeChooser();
    let n = 0;
    w.hooks.push(() => {
      if (w.db.listActions().some((a) => a.status === 'running')) w.db.injectSignal(xidOn(w, R7_GPU, n++));
    });
    const r = await makeLoop(w, { chooser, incidentWatchMs: 1, maxReplans: 1 }).runOnce();
    expect(n).toBeGreaterThan(1);
    expect(r.replans).toHaveLength(1);
    expect(r.escalated).toBe(false);
    expect(r.verification?.verified).toBe(true);
  });

  it('a thermal side effect on the plan’s own destination does not fire', async () => {
    const w = world();
    yieldToWatch(w);
    const { chooser } = fakeChooser();
    let heated: string | null = null;
    w.hooks.push(async () => {
      if (heated) return;
      const dest = (await openCommands(w)).flatMap(destOf)[0];
      if (!dest || !w.db.listActions().some((a) => a.status === 'running')) return;
      heated = dest;
      w.db.mutateSnapshot((s) => {
        s.gpus.find((g) => g.resource_id === dest)!.temp_c = 95;
      });
    });
    const r = await makeLoop(w, { chooser, incidentWatchMs: 1 }).runOnce();
    expect(heated).not.toBeNull();
    expect(r.replans).toHaveLength(0);
  });

  it('stops reading after the workflow ends, and keeps at most one read in flight', async () => {
    const w = world();
    yieldToWatch(w);
    const { chooser } = fakeChooser();
    let inFlight = 0;
    let peak = 0;
    const original = w.db.getEvidence.bind(w.db);
    w.db.getEvidence = async (ids, window) => {
      if (ids.length > 0) return original(ids, window);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await macrotask(4);
      inFlight -= 1;
      return original(ids, window);
    };
    const r = await makeLoop(w, { chooser, incidentWatchMs: 1 }).runOnce();
    expect(r.verification?.verified).toBe(true);
    expect(peak).toBe(1);
    await macrotask(10);
    const after = readsOf(w);
    await macrotask(20);
    expect(readsOf(w)).toBe(after);
    expect(inFlight).toBe(0);
  });
});
