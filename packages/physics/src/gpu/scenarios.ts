// P1-9: seeded evaluation scenarios (ARCHITECTURE §9) for preset gpu_demo_8.
//
// Source of truth: packages/physics/fixtures/scenarios/*.json (one file per scenario). Physics src may not read files
// (this code also runs inside the SpacetimeDB module), so `scripts/make-scenarios.ts` bundles the JSON into
// ./scenarios.data.ts; test/gpu-scenarios.test.ts fails if that generated file drifts from the JSON.
//
// Pure: no fs, clock, randomness or I/O. Only `import type` from @dcos/contracts.
import type { FaultInjection, JobState, PhysicsWorld, SimulationTickInput } from '@dcos/contracts';
import { STEP_MS, WIRE_SCHEMA_VERSION } from './constants.js';
import { buildPreset, type PresetId } from './preset.js';
import { SCENARIO_DATA } from './scenarios.data.js';
import { cloneJson, hiddenOf, specOf } from './world.js';

/**
 * Optional starting-state changes for cases the faults cannot express (CONTRACT ADDITION, additive and optional).
 * Only per-job progress is supported: e.g. "near-complete job where staying wins" needs a job close to done.
 */
export interface ScenarioInitialOverrides {
  jobs?: Record<string, {
    /** Progress at t=0 (≤ total_work_units, ≥ the durable value). */
    progress_work_units?: number;
    /** Durable work at t=0 (the latest completed checkpoint's progress; ≤ progress). */
    durable_work_units?: number;
  }>;
}

/**
 * A seeded scenario. CONTRACTS §0.6 shape `{ scenario_id, seed, preset_id, faults, horizon_s }` plus two OPTIONAL,
 * additive fields: `description` (the §9 case and what a no-action run shows) and `initial_overrides`.
 */
export interface Scenario {
  scenario_id: string;
  seed: number;
  preset_id: PresetId;
  /** Private ground truth: never show these to a policy or the agent. */
  faults: FaultInjection[];
  horizon_s: number;
  description?: string;
  initial_overrides?: ScenarioInitialOverrides;
}

/** Every scenario, sorted by scenario_id. Returns fresh copies (callers may mutate them). */
export function loadScenarios(): Scenario[] {
  return (cloneJson(SCENARIO_DATA) as Scenario[]).sort((a, b) =>
    a.scenario_id < b.scenario_id ? -1 : a.scenario_id > b.scenario_id ? 1 : 0);
}

/** The run id every scenario's faults carry (CONTRACTS §0.3). */
export function scenarioRunId(s: Scenario): string {
  return s.faults[0]?.run_id ?? 'run-demo-1';
}

/** The starting world for a scenario: buildPreset(preset_id, run_id, seed) plus initial_overrides. */
export function scenarioWorld(s: Scenario, runId: string = scenarioRunId(s)): PhysicsWorld {
  const world = buildPreset(s.preset_id, runId, s.seed);
  const jobs = s.initial_overrides?.jobs ?? {};
  const h = hiddenOf(world);
  for (const jobId of Object.keys(jobs).sort()) {
    const o = jobs[jobId]!;
    const job: JobState | undefined = world.observable.job_states.find((j) => j.job_id === jobId);
    const spec = specOf(world, jobId);
    if (!job || !spec) throw new Error(`physics: scenario ${s.scenario_id} overrides unknown job ${jobId}`);
    const durable = o.durable_work_units ?? job.durable_work_units;
    const progress = o.progress_work_units ?? job.progress_work_units;
    if (!(durable >= 0 && durable <= progress && progress <= spec.total_work_units)) {
      throw new Error(`physics: scenario ${s.scenario_id} job ${jobId} needs 0 ≤ durable ≤ progress ≤ total`);
    }
    if (durable !== job.durable_work_units && !job.latest_checkpoint_id) {
      throw new Error(`physics: scenario ${s.scenario_id} job ${jobId} has no checkpoint to hold durable work`);
    }
    job.progress_work_units = progress;
    job.durable_work_units = durable;
    const ckpt = world.observable.checkpoints.find((c) => c.checkpoint_id === job.latest_checkpoint_id);
    if (ckpt) {
      ckpt.progress_work_units = durable;
      // keep the hidden checkpoint age consistent with progress − durable at the nominal rate
      const rate = spec.gpus_required * spec.work_rate_per_gpu_per_sim_s;
      h.last_checkpoint_sim_ms[jobId] = rate > 0 ? -Math.round(((progress - durable) / rate) * 1000) : 0;
    }
  }
  return world;
}

/**
 * Faults to pass in `due_faults_private` for the tick that starts from `world` (t0 → t1 = t0 + stepMs): every fault
 * whose window [start, start + duration) contains t1 and that is not active yet. A fault that has ended by t1 is
 * never passed again (step() would re-apply it, since it dedupes only against the active list).
 */
export function dueFaults(s: Scenario, world: PhysicsWorld, stepMs: number = STEP_MS): FaultInjection[] {
  const t1 = world.observable.clock.sim_time_ms + stepMs;
  const active = new Set(world.active_faults_private.map((f) => f.fault_id));
  return s.faults
    .filter((f) => f.start_sim_time_ms <= t1
      && (f.duration_sim_ms === null || f.start_sim_time_ms + f.duration_sim_ms > t1)
      && !active.has(f.fault_id))
    .map((f) => cloneJson(f));
}

/** The SimulationTickInput for one scenario tick (the DB tick and the evaluation harness build the same thing). */
export function scenarioTickInput(
  s: Scenario, world: PhysicsWorld, requestedActionIds: string[] = [], stepMs: number = STEP_MS,
): SimulationTickInput {
  return {
    schema_version: WIRE_SCHEMA_VERSION, run_id: world.run_id, step_ms: stepMs, seed: s.seed, world,
    due_faults_private: dueFaults(s, world, stepMs), requested_action_ids: requestedActionIds,
  };
}
