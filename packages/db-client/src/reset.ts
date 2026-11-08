// controlledReset (K3, SCOPE §5, CONTRACTS §0.13 #8): reset a run only once its agent is gone.
//
// The CALLER stops the agent and waits for its exit first. This helper then proves no worker is
// still heartbeating, because fencing tokens restart after a reset and a surviving agent could hold
// a token that looks valid to the new run.
import type { DbClient } from './client.js';

/** Default agent workflow lease is 15 s; a dead agent's lease has lapsed by then. */
const LEASE_WAIT_MS = 20_000;
const FIRST_TICK_WAIT_MS = 15_000;
const POLL_MS = 500;

export interface ControlledResetOptions {
  /** Database name, used only for the prod guard. */
  db: string;
  runId?: string;
  seed?: number;
  /** Required to reset prod `dcos`. */
  allowProd?: boolean;
  leaseWaitMs?: number;
  firstTickWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ControlledResetResult {
  run_id: string;
  seed: number;
  sim_time_ms: number;
  tick_index: number;
  gpus: number;
  jobs: number;
}

export async function controlledReset(client: DbClient, opts: ControlledResetOptions): Promise<ControlledResetResult> {
  if (opts.db === 'dcos' && !opts.allowProd) throw new Error('controlledReset: refusing to reset prod dcos without allowProd');
  const runId = opts.runId ?? 'run-demo-1';
  const seed = opts.seed ?? 42;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const leaseDeadline = now() + (opts.leaseWaitMs ?? LEASE_WAIT_MS);
  for (;;) {
    const live = (await client.listOpenWorkflows()).filter((w) => w.lease_owner && w.lease_expires_unix_ms > now());
    if (live.length === 0) break;
    if (now() >= leaseDeadline) {
      const owners = live.map((w) => `${w.workflow_id} (${w.lease_owner})`).join(', ');
      throw new Error(`controlledReset: an agent is still heartbeating: ${owners}. Stop it and wait for it to exit first.`);
    }
    await sleep(POLL_MS);
  }

  await client.createRun(runId, seed, 'gpu_demo_8');

  const tickDeadline = now() + (opts.firstTickWaitMs ?? FIRST_TICK_WAIT_MS);
  let snap = await client.getObservedSnapshot();
  while (snap.clock.tick_index === 0) {
    if (now() >= tickDeadline) throw new Error(`controlledReset: ${runId} did not tick after the reset`);
    await sleep(POLL_MS);
    snap = await client.getObservedSnapshot();
  }

  const actions = await new Promise<number>((resolve) => {
    let stop: (() => void) | undefined;
    let seen = false;
    stop = client.onActions((list) => {
      if (seen) return;
      seen = true;
      queueMicrotask(() => stop?.());
      resolve(list.length);
    });
  });
  const workflows = (await client.listOpenWorkflows()).length;
  if (snap.gpus.length !== 64 || snap.job_states.length !== 3 || actions !== 0 || workflows !== 0) {
    throw new Error(`controlledReset: run is not clean: ${snap.gpus.length} GPUs, ${snap.job_states.length} jobs, ${actions} actions, ${workflows} open workflows`);
  }
  return { run_id: runId, seed, sim_time_ms: snap.clock.sim_time_ms, tick_index: snap.clock.tick_index, gpus: snap.gpus.length, jobs: snap.job_states.length };
}
