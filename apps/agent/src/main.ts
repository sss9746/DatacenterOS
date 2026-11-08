// Entry point for `pnpm --filter agent start`: the live agent on SpacetimeDB.
// Exit codes: 0 clean stop, 1 config error / crash, 3 a lane's real adapter is not shipped yet.

import { hostname } from 'node:os';
import { createAgentLoop, LLM_UNAVAILABLE_NOTICE } from './agent-loop.js';
import { isAdapterNotReady } from './adapters/errors.js';
import { createDbPort, loadDbClient } from './adapters/db.js';
import { createPhysicsPort } from './adapters/physics.js';
import { agentNameFor, ConfigError, loadConfig, redact, redactString, requireConfig, workerIdFor, type AgentConfig } from './config.js';
import { createEventPublisher } from './events.js';
import { createLoggingLlm, createNimLlm } from './llm.js';
import type { DbPort, LlmPort, PhysicsPort } from './ports.js';

export const EXIT_CONFIG = 1;
export const EXIT_NOT_READY = 3;
const SIM_CLOCK_REFRESH_MS = 2_000;

const log = (m: string) => console.log(`agent: ${m}`);

function buildLlm(cfg: AgentConfig): LlmPort | null {
  if (!cfg.NIM_API_KEY || !cfg.NIM_MODEL) {
    log(`WARNING: NIM_API_KEY / NIM_MODEL not set. ${LLM_UNAVAILABLE_NOTICE} (requireApproval=false)`);
    return null;
  }
  const nim = createNimLlm(cfg, { onEvent: (e) => log(`nim ${e.type} (${e.endpoint} ${e.model})`) });
  return createLoggingLlm(nim, (e) =>
    log(`nemotron ${e.ok ? 'ok' : `failed (${e.errorName})`} ${e.latencyMs} ms${e.toolNames.length ? ` tools=${e.toolNames.join(',')}` : ''}`),
  );
}

/** Probe both lanes first so one message names everything that is missing. */
async function loadAdapters(): Promise<{ physics: PhysicsPort } | { missing: string[] }> {
  const missing: string[] = [];
  let physics: PhysicsPort | null = null;
  try {
    physics = await createPhysicsPort();
  } catch (e) {
    if (!isAdapterNotReady(e)) throw e;
    missing.push(e.message);
  }
  try {
    await loadDbClient();
  } catch (e) {
    if (!isAdapterNotReady(e)) throw e;
    missing.push(e.message);
  }
  return physics && missing.length === 0 ? { physics } : { missing };
}

/** Sync sim clock for event stamps: refreshed from the snapshot and from change notifications. */
function trackSimClock(db: DbPort, initialSimMs: number) {
  let sim = initialSimMs;
  const bump = (t: number) => (sim = Math.max(sim, t));
  const unsub = db.onChange((c) => bump(c.kind === 'signal' ? c.signal.sim_time_ms : c.kind === 'action_status' ? c.status.updated_sim_time_ms : c.sim_time_ms));
  const timer = setInterval(() => {
    db.getObservedSnapshot().then((s) => bump(s.clock.sim_time_ms), () => undefined);
  }, SIM_CLOCK_REFRESH_MS);
  return { clock: { unixMs: () => Date.now(), simTimeMs: () => sim }, dispose: () => (clearInterval(timer), unsub()) };
}

async function main(): Promise<number> {
  const cfg = loadConfig();
  log(`config ${JSON.stringify(redact(cfg))}`);

  const adapters = await loadAdapters();
  if ('missing' in adapters) {
    console.error('agent: cannot start the live agent yet:');
    for (const m of adapters.missing) console.error(`  - ${m}`);
    console.error('agent: run the end-to-end demo on in-memory fakes instead:  pnpm --filter agent demo');
    return EXIT_NOT_READY;
  }
  const stdb = requireConfig(cfg, ['STDB_URI', 'STDB_DB', 'STDB_AGENT_TOKEN']);
  const db = await createDbPort({ uri: stdb.STDB_URI, db: stdb.STDB_DB, token: stdb.STDB_AGENT_TOKEN });
  const snap = await db.getObservedSnapshot();
  const runId = snap.run_id;
  const workerId = workerIdFor(cfg, hostname(), process.pid);
  const agentName = agentNameFor(cfg, workerId);
  const sim = trackSimClock(db, snap.clock.sim_time_ms);
  // No event read-back on DbPort: a wall-clock start seq keeps ids unique across restarts.
  const events = createEventPublisher({ db, runId, clock: sim.clock, redact: (s) => redactString(s, cfg), startSeq: Date.now() });
  const loop = createAgentLoop({ db, physics: adapters.physics, llm: buildLlm(cfg), events, workerId, agentName, zone: cfg.AGENT_ZONE ?? null, runId, clock: sim.clock, log });

  log(`worker ${workerId} (agent ${agentName}, zone ${cfg.AGENT_ZONE ?? 'any'}) on run ${runId} (sim t=${(snap.clock.sim_time_ms / 1000).toFixed(1)} s)`);
  await new Promise<void>((resolve) => {
    let stopping = false;
    const shutdown = (sig: string) => {
      if (stopping) return;
      stopping = true;
      log(`${sig}: stopping`);
      void loop.stop().finally(() => {
        sim.dispose();
        resolve();
      });
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    loop.start().catch((e: unknown) => {
      console.error(`agent: loop failed to start: ${redactString(String(e), cfg)}`);
      shutdown('start-failure');
    });
  });
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof ConfigError) {
      console.error(`agent: ${err.message}`);
      process.exit(EXIT_CONFIG);
    }
    let msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    try {
      msg = redactString(msg, loadConfig());
    } catch {
      /* config unreadable: message has no config secrets to redact */
    }
    console.error(`agent: fatal ${msg}`);
    process.exit(EXIT_CONFIG);
  },
);
