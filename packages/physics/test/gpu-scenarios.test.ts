// P1-9: seeded evaluation scenarios (ARCHITECTURE §9). Every scenario loads, validates, steps from t=0 to its
// horizon with no commands, deterministically, and its faults visibly bite.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  validatePayload,
  type Checkpoint,
  type CoolingCurrent,
  type FaultInjection,
  type GpuCurrent,
  type JobState,
  type NodeCurrent,
  type PhysicsWorld,
  type ResourceSpec,
  type TelemetryEvent,
} from '../../contracts/src/index.js';
import {
  CLOCKS_EVENT_HW_THERMAL,
  SLOWDOWN_C,
  buildPreset,
  dueFaults,
  loadScenarios,
  scenarioTickInput,
  scenarioWorld,
  step,
  toObserved,
  type Scenario,
} from '../src/index.js';
import { SCENARIO_DATA_FILE, SCENARIO_DIR, readScenarioJson, renderScenarioData, scenarioFiles } from '../scripts/make-scenarios.js';
import { gpusOn } from './gpu-helpers.js';

const scenarios = loadScenarios();
const byId = new Map(scenarios.map((s) => [s.scenario_id, s]));

/** One observed tick, kept small (the full world is ~100 KB, so a 600-tick run keeps only these rows). */
interface Frame {
  t: number;
  gpus: Map<string, GpuCurrent>;
  jobs: Map<string, JobState>;
  nodes: Map<string, NodeCurrent>;
  cooling: Map<string, CoolingCurrent>;
  checkpoints: Checkpoint[];
  active: string[];
  telemetry: TelemetryEvent[];
}
interface Trace { frames: Frame[]; final: PhysicsWorld; invalid: string[] }

const frameOf = (w: PhysicsWorld, telemetry: TelemetryEvent[]): Frame => ({
  t: w.observable.clock.sim_time_ms,
  gpus: new Map(w.observable.gpus.map((g) => [g.resource_id, g])),
  jobs: new Map(w.observable.job_states.map((j) => [j.job_id, j])),
  nodes: new Map(w.observable.nodes.map((n) => [n.resource_id, n])),
  cooling: new Map(w.observable.cooling.map((c) => [c.resource_id, c])),
  checkpoints: w.observable.checkpoints,
  active: w.active_faults_private.map((f) => f.fault_id),
  telemetry,
});

/** Step a scenario from t=0 to horizon_s with no commands; validate every tick result. */
function runScenarioNoAction(s: Scenario, validate: boolean): Trace {
  let w = scenarioWorld(s);
  const frames: Frame[] = [frameOf(w, [])];
  const invalid: string[] = [];
  while (w.observable.clock.sim_time_ms < s.horizon_s * 1000) {
    const r = step(scenarioTickInput(s, w));
    if (validate) {
      const v = validatePayload('PhysicsTickResult', r);
      if (!v.ok) invalid.push(`t=${r.world_after.observable.clock.sim_time_ms}: ${v.errors.slice(0, 3).join('; ')}`);
    }
    w = r.world_after;
    frames.push(frameOf(w, r.telemetry));
  }
  return { frames, final: w, invalid };
}

const traces = new Map<string, Trace>();
const trace = (id: string): Trace => {
  let tr = traces.get(id);
  if (!tr) {
    tr = runScenarioNoAction(byId.get(id)!, false);
    traces.set(id, tr);
  }
  return tr;
};
const at = (tr: Trace, seconds: number): Frame => {
  const f = tr.frames.find((x) => x.t === seconds * 1000);
  if (!f) throw new Error(`no frame at ${seconds} s`);
  return f;
};
const last = (tr: Trace): Frame => tr.frames[tr.frames.length - 1]!;
const throttled = (g: GpuCurrent | undefined) => g !== undefined && (g.clocks_event_reasons & CLOCKS_EVENT_HW_THERMAL) !== 0;
const everThrottled = (tr: Trace, ids: string[]) => tr.frames.some((f) => ids.some((id) => throttled(f.gpus.get(id))));
const maxTemp = (tr: Trace, ids: string[]) =>
  Math.max(...tr.frames.flatMap((f) => ids.map((id) => f.gpus.get(id)!).filter((g) => g.availability !== 'unreachable').map((g) => g.temp_c)));
const job = (f: Frame, id: string) => f.jobs.get(id)!;
const firstFrame = (tr: Trace, pred: (f: Frame) => boolean) => tr.frames.find(pred);
const LOOP_A_GPUS = gpusOn(2, 3, 4);

// ---- files, loading, bundling ----------------------------------------------------------------------

describe('scenarios: files and loadScenarios()', () => {
  it('has at least 10 scenarios (20 stretch) with unique ids, sorted', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(10);
    expect(scenarios.length).toBe(20);
    const ids = scenarios.map((s) => s.scenario_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
  });

  it('one file per scenario, named <scenario_id>.json, and loadScenarios() equals the JSON files', () => {
    expect(scenarioFiles()).toEqual(scenarios.map((s) => `${s.scenario_id}.json`));
    expect(scenarios).toEqual(readScenarioJson());
  });

  it('src/gpu/scenarios.data.ts is up to date with fixtures/scenarios (run scripts/make-scenarios.ts)', () => {
    expect(readFileSync(SCENARIO_DATA_FILE, 'utf8')).toBe(renderScenarioData());
  });

  it('is deterministic and returns fresh copies', () => {
    const a = loadScenarios();
    a[0]!.faults.length = 0;
    a[0]!.seed = -1;
    expect(loadScenarios()).toEqual(scenarios);
    expect(loadScenarios()[0]!.faults.length).toBeGreaterThan(0);
  });

  it('every scenario has the §0.6 shape plus only the optional description / initial_overrides', () => {
    const allowed = new Set(['scenario_id', 'seed', 'preset_id', 'faults', 'horizon_s', 'description', 'initial_overrides']);
    for (const s of scenarios) {
      for (const k of Object.keys(s)) expect(allowed.has(k), `${s.scenario_id}.${k}`).toBe(true);
      expect(s.scenario_id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
      expect(s.preset_id).toBe('gpu_demo_8');
      expect(Number.isInteger(s.seed) && s.seed >= 0).toBe(true);
      expect(Number.isInteger(s.horizon_s) && s.horizon_s > 0).toBe(true);
      expect(s.faults.length).toBeGreaterThan(0);
      expect(typeof s.description).toBe('string');
    }
  });

  it('JSON files are pretty-printed with a trailing newline', () => {
    for (const f of scenarioFiles()) {
      const text = readFileSync(join(SCENARIO_DIR, f), 'utf8');
      expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    }
  });
});

// ---- faults ----------------------------------------------------------------------------------------

/** Resource kinds each fault kind can target in the physics (src/gpu/faults.ts + world.ts faultConditions). */
const SUPPORTED_TARGETS: Record<FaultInjection['kind'], ReadonlySet<ResourceSpec['kind']>> = {
  cooling_pump_degradation: new Set(['cooling_pump']),
  cooling_pump_outage: new Set(['cooling_pump']),
  gpu_thermal_load: new Set(['gpu']),
  gpu_xid_48: new Set(['gpu']),
  gpu_xid_79: new Set(['gpu']),
  gpu_xid_74: new Set(['gpu']),
  node_crash: new Set(['node', 'checkpoint_store']),
  network_link_down: new Set(['checkpoint_store']), // a link-r* target has no modeled effect: not used
  sensor_stale: new Set(['gpu', 'rack', 'cooling_pump']),
};

describe('scenarios: faults', () => {
  const resources = new Map(buildPreset('gpu_demo_8', 'run-demo-1', 1).observable.resources.map((r) => [r.resource_id, r]));

  it('every fault validates as FaultInjection (run-demo-1, schema 1.1.0, integer times, severity 0..1)', () => {
    for (const s of scenarios) {
      for (const f of s.faults) {
        const v = validatePayload('FaultInjection', f);
        expect(v, `${s.scenario_id} ${f.fault_id}`).toEqual({ ok: true });
        expect(f.run_id).toBe('run-demo-1');
        expect(f.start_sim_time_ms % 1000).toBe(0); // lands on a tick boundary
        expect(f.start_sim_time_ms).toBeLessThan(s.horizon_s * 1000);
      }
    }
  });

  it('fault ids are unique across all scenarios; seed_offset is unique within a scenario', () => {
    const ids = scenarios.flatMap((s) => s.faults.map((f) => f.fault_id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of scenarios) {
      const offsets = s.faults.map((f) => f.seed_offset);
      expect(new Set(offsets).size, s.scenario_id).toBe(offsets.length);
    }
  });

  it('every fault targets a real gpu_demo_8 resource of a kind the physics implements for that fault', () => {
    for (const s of scenarios) {
      for (const f of s.faults) {
        const r = resources.get(f.target_resource_id);
        expect(r, `${s.scenario_id}: unknown target ${f.target_resource_id}`).toBeDefined();
        expect(SUPPORTED_TARGETS[f.kind].has(r!.kind), `${s.scenario_id}: ${f.kind} on ${r!.kind}`).toBe(true);
        expect(r!.config.allocatable, `${s.scenario_id}: never fault the real GPU`).not.toBe(false);
      }
    }
  });

  it('dueFaults: a fault is due on the tick whose end reaches its start, once, and never after it ends', () => {
    const s = byId.get('sc14-preventive-move-hurts')!; // pump-a fault 30 s – 120 s
    const f = s.faults[0]!;
    let w = scenarioWorld(s);
    const dueAt: number[] = [];
    while (w.observable.clock.sim_time_ms < 200_000) {
      const due = dueFaults(s, w);
      if (due.length > 0) dueAt.push(w.observable.clock.sim_time_ms + 1000);
      w = step(scenarioTickInput(s, w)).world_after;
      const t = w.observable.clock.sim_time_ms;
      const active = w.active_faults_private.some((a) => a.fault_id === f.fault_id);
      expect(active, `t=${t}`).toBe(t >= 30_000 && t < 120_000);
    }
    expect(dueAt).toEqual([30_000]);
  });
});

// ---- starting world --------------------------------------------------------------------------------

describe('scenarios: scenarioWorld()', () => {
  it('is buildPreset(preset_id, run-demo-1, seed) and validates as PhysicsWorld / ObservedSnapshot', () => {
    for (const s of scenarios) {
      const w = scenarioWorld(s);
      expect(validatePayload('PhysicsWorld', w), s.scenario_id).toEqual({ ok: true });
      expect(validatePayload('ObservedSnapshot', toObserved(w)), s.scenario_id).toEqual({ ok: true });
      if (!s.initial_overrides) expect(w).toEqual(buildPreset('gpu_demo_8', 'run-demo-1', s.seed));
    }
  });

  it('applies initial_overrides to the job and its latest checkpoint row (sc13 near-complete job-b)', () => {
    const w = scenarioWorld(byId.get('sc13-near-complete-job-stay')!);
    const b = w.observable.job_states.find((j) => j.job_id === 'job-b')!;
    expect(b.progress_work_units).toBe(58_000);
    expect(b.durable_work_units).toBe(57_600);
    expect(w.observable.checkpoints.find((c) => c.checkpoint_id === b.latest_checkpoint_id)!.progress_work_units).toBe(57_600);
    expect((w.hidden_physics_state_json as { last_checkpoint_sim_ms: Record<string, number> }).last_checkpoint_sim_ms['job-b']).toBe(-50_000);
    // other jobs untouched
    const base = buildPreset('gpu_demo_8', 'run-demo-1', 113);
    expect(w.observable.job_states.filter((j) => j.job_id !== 'job-b')).toEqual(base.observable.job_states.filter((j) => j.job_id !== 'job-b'));
  });

  it('rejects overrides that break 0 ≤ durable ≤ progress ≤ total or name an unknown job', () => {
    const s = byId.get('sc13-near-complete-job-stay')!;
    const bad = (jobs: NonNullable<Scenario['initial_overrides']>['jobs']) => () => scenarioWorld({ ...s, initial_overrides: { jobs } });
    expect(bad({ 'job-b': { progress_work_units: 70_000 } })).toThrow();
    expect(bad({ 'job-b': { progress_work_units: 50_000, durable_work_units: 55_000 } })).toThrow();
    expect(bad({ 'job-c': { durable_work_units: 10_000 } })).toThrow(); // job-c has no checkpoint
    expect(bad({ 'job-z': { progress_work_units: 1 } })).toThrow();
  });
});

// ---- stepping --------------------------------------------------------------------------------------

describe.each(scenarios.map((s) => [s.scenario_id, s] as const))('scenario %s', (id, s) => {
  it('steps t=0 → horizon_s with no commands; every tick result validates as PhysicsTickResult', () => {
    const tr = runScenarioNoAction(s, true);
    traces.set(id, tr);
    expect(tr.invalid).toEqual([]);
    expect(tr.final.observable.clock.sim_time_ms).toBe(s.horizon_s * 1000);
    expect(tr.final.observable.clock.tick_index).toBe(s.horizon_s);
    // every fault that started was applied exactly once
    const applied = tr.frames.flatMap((f, i) => f.active.filter((x) => !(tr.frames[i - 1]?.active ?? []).includes(x)));
    expect([...applied].sort()).toEqual(s.faults.map((f) => f.fault_id).sort());
  });

  it('is deterministic: the same seed gives an identical final state', () => {
    const again = runScenarioNoAction(s, false);
    expect(again.final).toEqual(trace(id).final);
  });
});

// ---- does each fault bite? ---------------------------------------------------------------------------

const BITES: Record<string, (tr: Trace) => void> = {
  'sc01-thermal-warning-only': (tr) => {
    expect(at(tr, 31).cooling.get('pump-a')!.operating_state).toBe('degraded');
    expect(everThrottled(tr, LOOP_A_GPUS)).toBe(false);
    expect(maxTemp(tr, LOOP_A_GPUS)).toBeLessThan(71); // capacity still exceeds heat: no rise at all
    for (const j of last(tr).jobs.values()) expect(j.status).toBe('running');
  },
  'sc02-harmless-temp-spike': (tr) => {
    const hot = ['gpu-r3-n1-0', 'gpu-r3-n1-1', 'gpu-r3-n1-2', 'gpu-r3-n1-3'];
    for (const g of hot) {
      expect(at(tr, 80).gpus.get(g)!.temp_c).toBeGreaterThanOrEqual(79);
      expect(last(tr).gpus.get(g)!.temp_c).toBeLessThan(71);
    }
    expect(everThrottled(tr, LOOP_A_GPUS)).toBe(false);
    expect(maxTemp(tr, LOOP_A_GPUS)).toBeLessThan(SLOWDOWN_C);
    for (const j of last(tr).jobs.values()) expect(j.status).toBe('running');
  },
  'sc03-severe-pump': (tr) => {
    for (const r of [2, 3, 4]) expect(everThrottled(tr, gpusOn(r)), `r${r}`).toBe(true);
    expect(everThrottled(tr, gpusOn(1, 5, 7, 8))).toBe(false);
    for (const id of ['job-a', 'job-b']) {
      const j = job(last(tr), id);
      expect(j.status).toBe('failed');
      expect(j.progress_work_units).toBe(j.durable_work_units);
    }
    expect(job(last(tr), 'job-c').status).toBe('running');
  },
  'sc04-failed-gpu-xid79': (tr) => {
    expect(at(tr, 60).gpus.get('gpu-r3-n1-5')!.availability).toBe('unreachable');
    expect(job(at(tr, 59), 'job-a').status).toBe('running');
    const a = job(at(tr, 60), 'job-a');
    expect(a.status).toBe('failed');
    expect(a.progress_work_units).toBe(86_400);
    expect(job(at(tr, 59), 'job-a').progress_work_units - 86_400).toBeGreaterThan(9_000); // ≈10 sim-min × 16 GPUs lost
    expect(job(last(tr), 'job-b').status).toBe('running');
  },
  'sc05-pump-gpu-mid-checkpoint': (tr) => {
    expect(at(tr, 10).cooling.get('pump-a')!.operating_state).toBe('degraded');
    expect(job(at(tr, 30), 'job-a').status).toBe('failed');
    expect(at(tr, 30).gpus.get('gpu-r2-n1-1')!.availability).toBe('unreachable');
    expect(job(last(tr), 'job-b').status).toBe('running'); // r2/r3 heat went away with job-a
  },
  'sc06-gpu-loss-after-checkpoint': (tr) => {
    const b = job(at(tr, 45), 'job-b');
    expect(b.status).toBe('failed');
    expect(b.progress_work_units).toBe(40_000);
    expect(job(at(tr, 44), 'job-b').progress_work_units - 40_000).toBeCloseTo(8 * 104, 0); // only ≈105 s of work lost
    expect(job(last(tr), 'job-a').status).toBe('running');
  },
  'sc07-no-spare-capacity': (tr) => {
    const f = at(tr, 5);
    for (const r of [1, 5, 7, 8]) expect(f.nodes.get(`node-r${r}-n1`)!.availability).toBe('unreachable');
    // until the jobs themselves shut down (≈553 s) and free their own hot GPUs, nothing is free to move to
    const live = tr.frames.filter((x) => x.t >= 5000 && [...x.jobs.values()].every((j) => j.status === 'running'));
    expect(live.length).toBeGreaterThan(500);
    for (const fr of live) {
      const allocated = new Set([...fr.jobs.values()].flatMap((j) => j.allocated_gpu_ids));
      const free = [...fr.gpus.values()].filter((g) => g.availability === 'ready' && !allocated.has(g.resource_id));
      expect(free.length, `t=${fr.t}`).toBe(0);
    }
    expect(everThrottled(tr, LOOP_A_GPUS)).toBe(true);
  },
  'sc08-non-preemptible-affected': (tr) => {
    expect(at(tr, 10).cooling.get('pump-b')!.operating_state).toBe('degraded');
    expect(everThrottled(tr, gpusOn(6))).toBe(true);
    const c = job(last(tr), 'job-c');
    expect(c.status).toBe('running');
    expect(c.allocated_gpu_ids).toEqual(gpusOn(6));
    expect(c.progress_work_units).toBeLessThan(30_000 + 8 * 600 - 500); // throttling cost job-c real work
    expect(everThrottled(tr, LOOP_A_GPUS)).toBe(false);
  },
  'sc09-hot-destination': (tr) => {
    const loadRiseC = 35 * 0.9; // what a full job would add on an idle GPU (§0.4: 35 °C × load)
    for (const f of tr.frames.slice(1)) {
      for (const r of [1, 5]) expect(f.nodes.get(`node-r${r}-n1`)!.thermal_headroom_c, `r${r} t=${f.t}`).toBeLessThan(loadRiseC);
      for (const r of [7, 8]) expect(f.nodes.get(`node-r${r}-n1`)!.thermal_headroom_c, `r${r} t=${f.t}`).toBeGreaterThan(loadRiseC);
    }
    expect(at(tr, 1).gpus.get('gpu-r1-n1-0')!.temp_c).toBeGreaterThan(65);
    expect(everThrottled(tr, LOOP_A_GPUS)).toBe(true);
  },
  'sc10-checkpoint-storage-inaccessible': (tr) => {
    expect(at(tr, 4).checkpoints.every((c) => c.accessible)).toBe(true);
    for (const f of tr.frames.filter((x) => x.t >= 5000)) expect(f.checkpoints.every((c) => !c.accessible), `t=${f.t}`).toBe(true);
    expect(everThrottled(tr, LOOP_A_GPUS)).toBe(true);
  },
  'sc11-stale-telemetry': (tr) => {
    const frozen = at(tr, 5);
    for (const g of gpusOn(3)) {
      for (const f of tr.frames.filter((x) => x.t > 5000 && x.gpus.get(g)!.availability !== 'unreachable')) {
        expect(f.gpus.get(g)!.temp_c, `${g} t=${f.t}`).toBe(frozen.gpus.get(g)!.temp_c);
      }
    }
    const q = at(tr, 100).telemetry.filter((e) => e.resource_id === 'gpu-r3-n1-0' || e.resource_id === 'rack-r3');
    expect(q.length).toBeGreaterThan(0);
    expect(q.every((e) => e.quality === 'stale')).toBe(true);
    expect(everThrottled(tr, gpusOn(2))).toBe(true);
    expect(everThrottled(tr, gpusOn(3))).toBe(false); // r3 never *looks* throttled
  },
  'sc12-two-independent-incidents': (tr) => {
    const c = job(at(tr, 120), 'job-c');
    expect(c.status).toBe('failed');
    expect(c.progress_work_units).toBe(0); // no checkpoint: everything lost
    expect(job(at(tr, 120), 'job-a').status).toBe('running');
    expect(everThrottled(tr, LOOP_A_GPUS)).toBe(true);
  },
  'sc13-near-complete-job-stay': (tr) => {
    const done = firstFrame(tr, (f) => job(f, 'job-b').status === 'completed');
    expect(done).toBeDefined();
    expect(done!.t).toBeLessThanOrEqual(260_000);
    expect(tr.frames.filter((f) => f.t <= done!.t).some((f) => gpusOn(4).some((g) => throttled(f.gpus.get(g))))).toBe(false);
    expect(at(tr, 10).cooling.get('pump-a')!.operating_state).toBe('degraded');
  },
  'sc14-preventive-move-hurts': (tr) => {
    expect(at(tr, 60).cooling.get('pump-a')!.operating_state).toBe('degraded');
    expect(at(tr, 120).cooling.get('pump-a')!.operating_state).toBe('normal');
    const peak = maxTemp(tr, LOOP_A_GPUS);
    expect(peak).toBeGreaterThan(75);
    expect(peak).toBeLessThan(SLOWDOWN_C);
    expect(Math.max(...gpusOn(2).map((g) => last(tr).gpus.get(g)!.temp_c))).toBeLessThan(71); // cooled back down
    for (const j of last(tr).jobs.values()) expect(j.status).toBe('running');
  },
  'sc15-xid48-ecc': (tr) => {
    const g = at(tr, 90).gpus.get('gpu-r4-n1-6')!;
    expect(g.availability).toBe('degraded'); // reachable, not unreachable
    expect(g.last_xid_code).toBe(48);
    const b = job(at(tr, 90), 'job-b');
    expect(b.status).toBe('failed');
    expect(b.progress_work_units).toBe(40_000);
  },
  'sc16-pump-outage': (tr) => {
    expect(at(tr, 10).cooling.get('pump-a')!.operating_state).toBe('failed');
    const throttleAt = firstFrame(tr, (f) => LOOP_A_GPUS.some((g) => throttled(f.gpus.get(g))))!.t;
    expect(throttleAt).toBeLessThan(200_000);
    for (const id of ['job-a', 'job-b']) expect(job(last(tr), id).status).toBe('failed');
  },
  'sc17-demo-destination-xid79': (tr) => {
    expect(at(tr, 89).gpus.get('gpu-r1-n1-0')!.availability).toBe('ready');
    expect(at(tr, 90).gpus.get('gpu-r1-n1-0')!.availability).toBe('unreachable');
    expect(at(tr, 90).gpus.get('gpu-r1-n1-0')!.last_xid_code).toBe(79);
    for (const j of at(tr, 90).jobs.values()) expect(j.status).toBe('running'); // the XID hits free capacity
    expect(everThrottled(tr, LOOP_A_GPUS)).toBe(true);
  },
  'sc18-xid74-nvlink': (tr) => {
    const g = at(tr, 60).gpus.get('gpu-r2-n1-4')!;
    expect(g.availability).toBe('degraded');
    expect(g.last_xid_code).toBe(74);
    expect(job(last(tr), 'job-a').status).toBe('running');
    expect(job(last(tr), 'job-a').allocated_gpu_ids).toContain('gpu-r2-n1-4');
  },
  'sc19-node-crash': (tr) => {
    expect(at(tr, 60).nodes.get('node-r4-n1')!.availability).toBe('unreachable');
    expect(job(at(tr, 60), 'job-b').status).toBe('failed');
    expect(at(tr, 359).nodes.get('node-r4-n1')!.availability).toBe('unreachable');
    expect(at(tr, 360).nodes.get('node-r4-n1')!.availability).toBe('ready');
    for (const g of gpusOn(4)) expect(last(tr).gpus.get(g)!.availability).toBe('ready');
    expect(job(last(tr), 'job-b').status).toBe('failed'); // a reboot does not restart the job
  },
  'sc20-transient-storage-outage': (tr) => {
    expect(at(tr, 19).checkpoints.every((c) => c.accessible)).toBe(true);
    expect(at(tr, 20).checkpoints.every((c) => !c.accessible)).toBe(true);
    expect(at(tr, 199).checkpoints.every((c) => !c.accessible)).toBe(true);
    expect(at(tr, 200).checkpoints.every((c) => c.accessible)).toBe(true);
    expect(everThrottled(tr, LOOP_A_GPUS)).toBe(true);
  },
};

describe('scenarios: each fault bites (no-action run)', () => {
  it('every scenario has a sanity check', () => {
    expect(Object.keys(BITES).sort()).toEqual(scenarios.map((s) => s.scenario_id));
  });
  it.each(scenarios.map((s) => s.scenario_id))('%s', (id) => {
    BITES[id]!(trace(id));
  });
});
