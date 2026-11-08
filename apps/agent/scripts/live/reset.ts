// Controlled reset (SCOPE §5, K3): only with the agent stopped, never on prod. Uses the admin client's
// `createRun` (which clears every row of the run and re-projects the preset) and then verifies the fresh
// run by observation: tick_index advancing from the preset start (600000 ms), 64 GPUs, 3 jobs, 0 actions,
// 0 workflows. If Kaushik ships `controlledReset` in @dcos/db-client this file becomes a thin wrapper.

import type { DbClient } from '@dcos/db-client';
import { isProdDb } from './args.js';
import { waitFor } from './wait.js';

export const RUN_START_SIM_MS = 600_000;
export const EXPECTED_GPUS = 64;
const REAL_GPU_ID = 'gpu-real-0';
export const EXPECTED_JOBS = 3;
const LEASE_DRAIN_MS = 25_000;
const FRESH_RUN_MS = 20_000;

export class ResetRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResetRefusedError';
  }
}

export interface ResetOptions {
  db: string;
  runId: string;
  seed: number;
  presetId: string;
  speed: number;
  /** Must be true: the harness asserts its own agent child is gone before calling. */
  agentStopped: boolean;
  log?: (m: string) => void;
}

export interface ResetReport {
  wall_started_unix_ms: number;
  wall_done_unix_ms: number;
  sim_time_after_ms: number;
  tick_index_after: number;
  gpus: number;
  jobs: number;
  actions: number;
  open_workflows: number;
  speed: number;
}

/** Wait until no open workflow holds a live lease (a surviving old agent would still be heartbeating). */
export async function drainLeases(client: DbClient, timeoutMs = LEASE_DRAIN_MS): Promise<void> {
  await waitFor({
    what: 'every open workflow lease to expire (is an agent still running against this database?)',
    timeoutMs,
    pollMs: 1_000,
    read: () => client.listOpenWorkflows(),
    until: (wfs) => (wfs.every((w) => w.lease_owner === null || w.lease_expires_unix_ms < Date.now()) ? true : null),
    summarize: (wfs) => wfs.map((w) => `${w.workflow_id}:${w.lease_owner ?? '-'} exp in ${Math.round((w.lease_expires_unix_ms - Date.now()) / 1000)}s`).join(', ') || 'no open workflows',
  });
}

export async function controlledReset(client: DbClient, opts: ResetOptions): Promise<ResetReport> {
  const log = opts.log ?? (() => undefined);
  if (isProdDb(opts.db)) throw new ResetRefusedError(`refusing to reset production database '${opts.db}'`);
  if (!opts.agentStopped) throw new ResetRefusedError('reset requires the agent child to be stopped first');
  const started = Date.now();

  log('reset: waiting for stale workflow leases to expire');
  await drainLeases(client);

  log(`reset: create_run ${opts.runId} seed=${opts.seed} preset=${opts.presetId}`);
  await client.createRun(opts.runId, opts.seed, opts.presetId);

  const { state } = await waitFor({
    what: `fresh run ${opts.runId} ticking from ${RUN_START_SIM_MS}`,
    timeoutMs: FRESH_RUN_MS,
    pollMs: 500,
    read: async () => ({ snap: await client.getObservedSnapshot(), wfs: await client.listOpenWorkflows() }),
    until: ({ snap }) => (snap.run_id === opts.runId && snap.clock.tick_index > 0 && snap.clock.sim_time_ms > RUN_START_SIM_MS ? true : null),
    summarize: ({ snap }) => `run=${snap.run_id} tick=${snap.clock.tick_index} sim=${snap.clock.sim_time_ms}`,
  });
  const snap = state.snap;
  const problems: string[] = [];
  // `gpu-real-0` is the observation-only Brev GPU (ingest_observations); physics never models it, so it is not counted.
  const simulatedGpus = snap.gpus.filter((g) => g.resource_id !== REAL_GPU_ID).length;
  if (simulatedGpus !== EXPECTED_GPUS) problems.push(`gpus=${simulatedGpus} simulated (expected ${EXPECTED_GPUS})`);
  if (snap.job_states.length !== EXPECTED_JOBS) problems.push(`jobs=${snap.job_states.length} (expected ${EXPECTED_JOBS})`);
  if (state.wfs.length !== 0) problems.push(`open_workflows=${state.wfs.length} (expected 0)`);
  if (snap.clock.sim_time_ms > RUN_START_SIM_MS + 60_000) problems.push(`sim clock ${snap.clock.sim_time_ms} is far past the preset start; was the run actually reset?`);
  const ledger = await new Promise<number>((resolve) => {
    const unsub = client.onActions((a) => {
      resolve(a.length);
      queueMicrotask(() => unsub());
    });
  });
  if (ledger !== 0) problems.push(`actions=${ledger} (expected 0)`);
  if (problems.length) throw new Error(`reset verification failed: ${problems.join('; ')}`);

  if (opts.speed !== 1) {
    log(`reset: configure_run speed=${opts.speed}`);
    await client.configureRun(opts.runId, { speed: opts.speed });
  }
  return {
    wall_started_unix_ms: started,
    wall_done_unix_ms: Date.now(),
    sim_time_after_ms: snap.clock.sim_time_ms,
    tick_index_after: snap.clock.tick_index,
    gpus: simulatedGpus,
    jobs: snap.job_states.length,
    actions: ledger,
    open_workflows: state.wfs.length,
    speed: opts.speed,
  };
}
