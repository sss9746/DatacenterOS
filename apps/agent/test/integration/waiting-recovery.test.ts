// Integration: waiting recovery (plan §0.6) against the REAL @dcos/physics. The Lead fails (choices: null), so these
// pin what the deterministic path does: wait while nothing is placeable, restart from checkpoints once capacity is back.
import type { ObservedSnapshot } from '@dcos/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { createPhysicsPort } from '../../src/adapters/physics.js';
import { planIncidents, type OptionChooser } from '../../src/planner.js';
import type { LlmPort, PhysicsPort } from '../../src/ports.js';
import { createSnapshotDb } from '../../src/snapshot-db.js';
import { runTriage } from '../../src/triage.js';
import { newDriver, observe } from './physics-driver.js';

const NO_LLM: LlmPort = {
  async chat() {
    throw new Error('no LLM in this test');
  },
};

let physics: PhysicsPort;
beforeAll(async () => {
  physics = await createPhysicsPort();
});

function failAllJobs(s: ObservedSnapshot): void {
  for (const j of s.job_states) {
    j.status = 'failed';
    j.allocated_gpu_ids = [];
  }
  s.allocations = [];
}

function setNodes(s: ObservedSnapshot, availability: 'ready' | 'unreachable'): void {
  for (const n of s.nodes) n.availability = availability;
  for (const g of s.gpus) g.availability = availability;
}

const leadDown = () => {
  let calls = 0;
  const chooser: OptionChooser = async (input) => {
    calls += 1;
    return {
      choices: null,
      team: { version: 1, round_id: `${input.workflowId}:a${input.attempt}`, snapshot_sim_ms: 0, model: null, calls_used: 0, wall_ms: 0, outcome: 'deterministic', messages: [], covers: [], missing_roles: [] },
    };
  };
  return { chooser, calls: () => calls };
};

describe('waiting recovery on real physics', () => {
  it('waits with no chooser call while every node is down, then restarts only checkpoint-backed jobs', async () => {
    const down = observe(newDriver(1));
    failAllJobs(down);
    setNodes(down, 'unreachable');
    const noCheckpoint = down.job_specs.map((j) => j.job_id).filter((id) => !down.checkpoints.some((c) => c.job_id === id && c.status === 'complete' && c.accessible));
    const withCheckpoint = down.job_specs.map((j) => j.job_id).filter((id) => !noCheckpoint.includes(id));
    expect(noCheckpoint.length).toBeGreaterThan(0);
    expect(withCheckpoint.length).toBeGreaterThan(0);

    const db = createSnapshotDb(down, []);
    const { incidents } = await runTriage({ db, llm: null, now: () => 0 });
    expect(incidents.length).toBeGreaterThan(0);
    const lead = leadDown();
    const waiting = await planIncidents({ db, physics, llm: NO_LLM, workflowId: 'wf-int', runId: down.run_id, attempt: 1, chooser: lead.chooser }, { incidents });
    expect(lead.calls()).toBe(0);
    expect(waiting.commands).toHaveLength(0);
    expect(waiting.waiting_jobs?.map((j) => j.job_id).sort()).toEqual([...withCheckpoint].sort());
    expect(waiting.operator_jobs?.map((j) => j.job_id).sort()).toEqual([...noCheckpoint].sort());

    const back = structuredClone(down);
    setNodes(back, 'ready');
    const restored = await planIncidents(
      { db: createSnapshotDb(back, []), physics, llm: NO_LLM, workflowId: 'wf-int', runId: back.run_id, attempt: 2, chooser: lead.chooser },
      { incidents },
    );
    expect(lead.calls()).toBe(1);
    const restarted = restored.commands.filter((c) => c.operation === 'migrate_restart').map((c) => c.job_id!);
    expect(restarted.sort()).toEqual([...withCheckpoint].sort());
    expect(restored.commands.some((c) => c.operation === 'escalate')).toBe(false);
    expect(restored.operator_jobs?.map((j) => j.job_id).sort()).toEqual([...noCheckpoint].sort());
    expect(restored.waiting_jobs).toEqual([]);
  });
});
