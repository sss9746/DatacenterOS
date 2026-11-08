// P3 cleanup regressions on P1's REAL harness (runScenario, real physics, deterministic Nemotron path, llm = null).
// The full 20-scenario check (including key conflicts) runs in scripts/eval-side-by-side.ts, which exits 1 on any
// logical-step key conflict; these are the scenarios the cleanup targeted.
import type { ActionCommand } from '@dcos/contracts';
import { loadScenarios, runScenario } from '@dcos/physics';
import { beforeAll, describe, expect, it } from 'vitest';
import { logicalKeyConflicts } from '../../scripts/eval-side-by-side.js';
import { createPhysicsPort } from '../../src/adapters/physics.js';
import { createNemotronPolicy } from '../../src/policy.js';
import type { PhysicsPort, Policy } from '../../src/ports.js';

let physics: PhysicsPort;
beforeAll(async () => {
  physics = await createPhysicsPort();
});

async function evalScenario(id: string) {
  const s = loadScenarios().find((x) => x.scenario_id === id);
  if (!s) throw new Error(`no scenario ${id}`);
  const policy = createNemotronPolicy({ llm: null, physics });
  const issued: ActionCommand[] = [];
  const recording: Policy = async (obs, ctx) => {
    const out = await policy(obs, ctx);
    issued.push(...out);
    return out;
  };
  const result = await runScenario(s, recording, { policy_name: 'nemotron' });
  return { result, issued, stats: policy.stats() };
}

describe('nemotron policy on real physics (P3 cleanup)', () => {
  it('sc13 near-complete job: no needless checkpoint / move (deferred while the keep outlook is clean)', async () => {
    const { result, issued } = await evalScenario('sc13-near-complete-job-stay');
    expect(result.unnecessary_preemptions).toBe(0);
    expect(result.lost_work_units).toBe(0);
    expect(issued.filter((c) => c.job_id === 'job-b' && c.operation !== 'escalate')).toEqual([]);
    expect(logicalKeyConflicts(issued)).toEqual([]);
  }, 180_000);

  it('sc14 transient pump fault: the preventive checkpoint + move is deferred and never needed', async () => {
    const { result, issued, stats } = await evalScenario('sc14-preventive-move-hurts');
    expect(result.unnecessary_preemptions).toBe(0);
    expect(result.lost_work_units).toBe(0);
    expect(issued.some((c) => c.operation === 'migrate_restart')).toBe(false);
    expect(stats.deferredRechecks).toBeGreaterThan(0);
  }, 180_000);

  it('sc20 transient storage outage: a failed checkpoint gets new attempt keys; no logical step is issued under two keys', async () => {
    const { result, issued } = await evalScenario('sc20-transient-storage-outage');
    expect(logicalKeyConflicts(issued)).toEqual([]);
    expect(result.successful_recoveries).toBeGreaterThanOrEqual(1);
    expect(result.unsafe_actions_executed).toBe(0);
  }, 180_000);
});
