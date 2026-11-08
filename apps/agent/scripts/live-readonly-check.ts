// LIVE READ-ONLY integration check of P3 against a real SpacetimeDB database.
// Calls only read paths of the real DbPort adapter (getObservedSnapshot, listIncidents, listOpenWorkflows,
// getActionStatus, getEvidence, onChange). Triage + planner run OFFLINE on the snapshot via SnapshotDb with real physics.
// Usage (from apps/agent): npx tsx scripts/live-readonly-check.ts   (reads repo-root .env.local; secrets never printed)

import { validatePayload } from '@dcos/contracts';
import { createDbPort } from '../src/adapters/db.js';
import { createPhysicsPort } from '../src/adapters/physics.js';
import { loadConfig, redactString, requireConfig } from '../src/config.js';
import { LlmUnavailableError } from '../src/llm.js';
import { planIncidents } from '../src/planner.js';
import type { DbChange, LlmPort } from '../src/ports.js';
import { createSnapshotDb } from '../src/snapshot-db.js';
import { runTriage } from '../src/triage.js';

const OBSERVE_MS = 15_000;
const cfg = loadConfig();
const out = (s: string) => console.log(redactString(s, cfg));
const jsonSafe = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
const noLlm: LlmPort = {
  chat: async () => {
    throw new LlmUnavailableError('read-only check: llm=null', []);
  },
};

async function main() {
  const c = requireConfig(cfg, ['STDB_URI', 'STDB_DB', 'STDB_AGENT_TOKEN']);
  out(`target ${c.STDB_URI} db=${c.STDB_DB}`);
  const db = await createDbPort({ uri: c.STDB_URI, db: c.STDB_DB, token: c.STDB_AGENT_TOKEN });

  const snap = await db.getObservedSnapshot();
  const v = validatePayload('ObservedSnapshot', snap);
  out(`validatePayload(ObservedSnapshot): ${v.ok ? 'OK' : 'FAIL'}`);
  if (!v.ok) for (const e of v.errors.slice(0, 25)) out(`  - ${e}`);
  out(`typeof: sim_time_ms=${typeof snap.clock.sim_time_ms} decision_epoch=${typeof snap.clock.decision_epoch} tick_index=${typeof snap.clock.tick_index}`);

  const k = snap.clock;
  out(`run ${snap.run_id} sim_time_ms=${k.sim_time_ms} tick=${k.tick_index} step_ms=${k.step_ms} paused=${k.paused} decision_epoch=${k.decision_epoch}`);
  const byAvail: Record<string, number> = {};
  for (const g of snap.gpus) byAvail[g.availability] = (byAvail[g.availability] ?? 0) + 1;
  out(
    `GPUs total=${snap.gpus.length} byAvailability=${jsonSafe(byAvail)}; nodes=${snap.nodes.length} resources=${snap.resources.length} deps=${snap.dependencies.length} allocations=${snap.allocations.length} checkpoints=${snap.checkpoints.length}`,
  );
  const hot = snap.gpus.filter((g) => g.temp_c >= 80).map((g) => `${g.resource_id}:${g.temp_c}C`);
  out(`GPUs >=80C: ${hot.length ? hot.join(', ') : 'none'}; maxTemp=${Math.max(0, ...snap.gpus.map((g) => g.temp_c))}`);
  const xids = snap.gpus.filter((g) => g.last_xid_code !== null).map((g) => `${g.resource_id}:XID${g.last_xid_code}`);
  out(`XID: ${xids.length ? xids.join(', ') : 'none'}`);
  for (const j of snap.job_states) {
    const spec = snap.job_specs.find((s) => s.job_id === j.job_id);
    const done = snap.checkpoints.filter((cp) => cp.job_id === j.job_id && cp.status === 'complete' && cp.complete_sim_time_ms !== null);
    const last = done.reduce<number | null>((m, cp) => (m === null || cp.complete_sim_time_ms! > m ? cp.complete_sim_time_ms! : m), null);
    const age = last === null ? 'none' : `${((k.sim_time_ms - last) / 1000).toFixed(1)}s`;
    out(
      `job ${j.job_id} status=${j.status} progress=${j.progress_work_units}/${spec?.total_work_units ?? '?'} durable=${j.durable_work_units} gpus=[${j.allocated_gpu_ids.join(',')}] latest_ckpt=${j.latest_checkpoint_id ?? 'none'} ckpt_age=${age}`,
    );
  }
  for (const cl of snap.cooling) {
    out(`cooling ${cl.resource_id} state=${cl.operating_state} pump_w=${cl.pump_power_w} nominal_w=${cl.nominal_capacity_w} est_w=${cl.observed_capacity_estimate_w}`);
  }

  // read paths
  const incidents = await db.listIncidents();
  const wfs = await db.listOpenWorkflows();
  const none = await db.getActionStatus('nonexistent');
  out(`listIncidents=${incidents.length} listOpenWorkflows=${wfs.length} getActionStatus('nonexistent')=${none === null ? 'null' : jsonSafe(none)}`);
  if (incidents.length) out(`  incidents: ${incidents.map((i) => `${i.incident_id}/${i.state}`).join(', ')}`);
  try {
    const ev = await db.getEvidence([], 600_000);
    out(`getEvidence([],600000): incidents=${ev.incidents.length} symptoms=${ev.symptoms.length} signals=${ev.signals.length} telemetry=${ev.telemetry.length} as_of=${ev.as_of_sim_time_ms}`);
  } catch (e) {
    out(`getEvidence threw: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }

  // live subscription
  const counts: Record<string, number> = {};
  const samples: DbChange[] = [];
  const unsub = db.onChange((ch) => {
    counts[ch.kind] = (counts[ch.kind] ?? 0) + 1;
    if ((ch.kind === 'signal' || ch.kind === 'action_status') && samples.length < 5) samples.push(ch);
  });
  out(`observing onChange for ${OBSERVE_MS / 1000}s ...`);
  await new Promise((r) => setTimeout(r, OBSERVE_MS));
  unsub();
  out(`onChange counts: ${jsonSafe(counts)}`);
  for (const s of samples) out(`  sample: ${jsonSafe(s).slice(0, 300)}`);
  const snap2 = await db.getObservedSnapshot();
  out(`re-read: sim_time_ms ${k.sim_time_ms} -> ${snap2.clock.sim_time_ms}, decision_epoch ${k.decision_epoch} -> ${snap2.clock.decision_epoch}`);

  // offline triage + planner on the snapshot (SnapshotDb is in-memory; nothing is written to the live DB)
  const physics = await createPhysicsPort();
  const sdb = createSnapshotDb(snap2);
  const tri = await runTriage({ db: sdb, llm: null, now: () => Date.now() });
  out(`OFFLINE triage: incidents=${tri.incidents.length} symptoms=${tri.symptoms.length} unassigned=${tri.unassignedSymptoms.length}`);
  for (const i of tri.incidents) out(`  incident ${i.incident_id} ${jsonSafe(i).slice(0, 200)}`);
  if (tri.incidents.length > 0) {
    const plan = await planIncidents(
      { db: sdb, physics, llm: noLlm, workflowId: 'wf-readonly-check', runId: snap2.run_id },
      { incidents: tri.incidents },
    );
    out(`OFFLINE plan: commands=${plan.commands.length}`);
    out(`  summary=${plan.summary ?? ''} job_plans=${jsonSafe(plan.job_plans.map((p) => ({ job: p.job_id, chosen: (p as { chosen?: unknown }).chosen ?? null }))).slice(0, 400)}`);
    for (const cmd of plan.commands) out(`  ${cmd.operation} ${jsonSafe(cmd).slice(0, 200)}`);
  } else {
    out('OFFLINE plan: no incidents -> no planned commands (expected on a healthy cluster)');
  }
  const th = await physics.thresholdPolicy(snap2);
  out(`physics.thresholdPolicy commands=${th.length}`);
  out('DONE (no writes performed)');
}

main().then(
  () => process.exit(0), // DbPort has no close(): createDbPort drops the client's close(), so force exit
  (e: unknown) => {
    console.error(redactString(e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e), cfg));
    process.exit(1);
  },
);
