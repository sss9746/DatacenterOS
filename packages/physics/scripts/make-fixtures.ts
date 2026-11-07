// Generates packages/physics/fixtures/*.json (CONTRACTS §9). Owned by S-3.
// Run (no tsx needed, Node >= 22.6):
//   pnpm -F @dcos/physics build && node --experimental-strip-types packages/physics/scripts/make-fixtures.ts
// With tsx (if added later): pnpm -F @dcos/physics exec tsx scripts/make-fixtures.ts  (after a build)
//
// The scenario numbers ("pump_B failed + ticket lie + operator asked about pump_A", tick 300) are HAND-WRITTEN
// from LANE-S §3.3 (steady state 22.0 °C, cooling margin +2 kW) until step() lands; then swap them for a real run.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileTopology, defaultDemoConfig, PRESET_CONFIGS } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'fixtures');

type Row = Record<string, unknown>;

const TICK = 300;
const TICKET_LIE_TICK = 125;
const INCIDENT_ID = 12;
const ACTION_ID = 7;
const PUMP_DRAW_FRAC = 0.05;

function write(name: string, data: unknown): void {
  const path = join(outDir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log('wrote', path);
}

// ---------- facility_default.json ----------
const { state } = compileTopology(defaultDemoConfig());
write('facility_default.json', state);

// ---------- hand-written steady state at tick 300 with pump_B failed ----------
// C = 50 kW (pump_A only), Q_it = 48 kW, margin +2. Every rack's share is 6.25 kW >= its 6 kW load → 22.0 °C.
const comps = Object.values(state.components) as Array<Row & { id: string; kind: string; params: Row }>;
const pumpADraw = PUMP_DRAW_FRAC * 50; // 2.5 kW
const itLoad = 48;

function statusOf(id: string): string {
  return id === 'pump_B' ? 'offline' : 'online';
}

function latestFor(c: Row & { id: string; kind: string }): Row {
  const isRack = c.kind === 'rack';
  const isReal = c.id === 'rack_3';
  let power = 0;
  let cooling = 0;
  let load = 0;
  if (isRack) { power = 6; cooling = 6; load = 6; }
  if (c.id === 'pump_A') { power = pumpADraw; cooling = 50; load = pumpADraw; }
  if (c.kind === 'utility') { power = itLoad + pumpADraw; }
  return {
    component_id: c.id,
    tick: TICK,
    temp_c: 22.0,
    power_kw: power,
    cooling_kw: cooling,
    load_kw: load,
    ups_energy_kwh: c.kind === 'ups' ? 20 : 0,
    fan_health: 1,
    fan_anomaly: isReal ? 0.12 : 0,
    fan_online: true,
    fan_fault_class: isReal ? 'healthy' : '',
    fan_rms: isReal ? 0.031 : 0,
    sensor_age_s: 0,
  };
}

const history: Row[] = [];
let histId = 1;
for (const id of ['rack_3', 'pump_B']) {
  for (let t = TICK - 29; t <= TICK; t++) {
    const isRack = id === 'rack_3';
    history.push({
      id: histId++,
      component_id: id,
      tick: t,
      temp_c: 22.0,
      power_kw: isRack ? 6 : 0,
      cooling_kw: isRack ? 6 : 0,
      fan_anomaly: isRack ? [0.11, 0.12, 0.13][t % 3] : 0,
    });
  }
}

// ---------- agent steps (also agent_steps_example.json) ----------
const plans = {
  plans: [
    {
      name: 'Migrate 3 kW off rack_3',
      actions: [{ kind: 'migrate_load', target_id: 'rack_3', params: { kw: 3, to: 'rack_1' } }],
      outcome: { min_cooling_margin_kw: 1.5, peak_temp_c: 37.2, racks_degraded: 0, racks_shutdown: 0, downtime_rack_s: 0 },
    },
    {
      name: 'Shed rack_8',
      actions: [{ kind: 'shed_load', target_id: 'rack_8', params: { kw: 6 } }],
      outcome: { min_cooling_margin_kw: 8, peak_temp_c: 41.8, racks_degraded: 0, racks_shutdown: 0, downtime_rack_s: 0 },
    },
    {
      name: 'Do nothing',
      actions: [],
      outcome: { min_cooling_margin_kw: 2, peak_temp_c: 47.5, racks_degraded: 1, racks_shutdown: 0, downtime_rack_s: 165 },
    },
  ],
  chosen: 0,
  reason: 'Lowest downtime with no shutdowns',
};

const stepSpecs: Array<[string, string, string, string, unknown]> = [
  ['diagnose', 'thought', '', 'Operator asks whether pump_A can be shut down. Check both pumps and their maintenance history first.', {}],
  ['diagnose', 'tool_call', 'get_component_status', 'get_component_status(pump_A)', { args: { id: 'pump_A' } }],
  ['diagnose', 'tool_result', 'get_component_status', 'pump_A online, 50 kW cooling', { result: { id: 'pump_A', kind: 'pump', status: 'online', cooling_kw: 50, power_kw: 2.5 } }],
  ['diagnose', 'tool_call', 'get_maintenance_logs', 'get_maintenance_logs(pump_B)', { args: { id: 'pump_B' } }],
  ['diagnose', 'tool_result', 'get_maintenance_logs', 'Ticket #41 "Repair: pump_B" completed', { result: [{ id: 41, component_id: 'pump_B', title: 'Repair: pump_B', status: 'completed', notes: 'Replaced impeller, pump back online', created_tick: TICKET_LIE_TICK }] }],
  ['diagnose', 'tool_call', 'get_component_status', 'get_component_status(pump_B)', { args: { id: 'pump_B' } }],
  ['diagnose', 'tool_result', 'get_component_status', 'pump_B offline, 0 kW cooling', { result: { id: 'pump_B', kind: 'pump', status: 'offline', cooling_kw: 0, power_kw: 0 } }],
  ['diagnose', 'decision', '', 'Contradiction: ticket #41 says repaired, pump_B is offline', {
    hypothesis: 'pump_B is still failed; ticket #41 is wrong. pump_A is the only working pump (margin +2 kW).',
    evidence: ['ticket #41 status=completed', 'pump_B status=offline, cooling 0 kW', 'cooling 50 kW vs IT load 48 kW'],
  }],
  ['plan', 'decision', '', 'Chose "Migrate 3 kW off rack_3": lowest downtime with no shutdowns', plans],
  ['handoff', 'thought', '', 'Pump A must stay online until pump_B is physically repaired. Ticket #41 needs to be reopened; dispatch a tech to pump_B.', {}],
];

const agentSteps: Row[] = stepSpecs.map(([agent, kind, tool, summary, payload], i) => ({
  id: i + 1,
  incident_id: INCIDENT_ID,
  agent,
  step_no: i + 1,
  kind,
  tool,
  summary,
  payload_json: JSON.stringify(payload),
  tick: TICK - 9 + i,
}));

// ---------- rows_public.json ----------
const rows = {
  facility: [{ id: 1, name: state.name, template: state.template, seed: state.seed, tick: TICK, sim_time_s: TICK, status: 'normal' }],
  component: comps.map((c) => ({
    id: c.id, kind: c.kind, label: c.label, status: statusOf(c.id),
    params_json: JSON.stringify(c.params), is_real_hardware: c.is_real_hardware, x: c.x, y: c.y,
  })),
  edge: state.edges.map((e: Row, i: number) => ({ id: i + 1, from_id: e.from_id, to_id: e.to_id, kind: e.kind })),
  telemetry_latest: comps.map(latestFor),
  telemetry_history: history,
  ticket: [
    { id: 40, component_id: 'pump_A', title: 'Quarterly bearing check', status: 'completed', notes: 'Bearings inspected, OK', created_tick: 0 },
    { id: 41, component_id: 'pump_B', title: 'Repair: pump_B', status: 'completed', notes: 'Replaced impeller, pump back online', created_tick: TICKET_LIE_TICK },
  ],
  shift_note: [{ id: 1, author: 'human', body: 'Night shift: Pump B work done, all good', verified: true, tick: 0 }],
  incident: [{
    id: INCIDENT_ID, opened_tick: TICK - 10, symptom: 'operator_question', component_ids: 'pump_A,pump_B', severity: 'high',
    status: 'awaiting_approval',
    hypothesis: 'pump_B is still failed despite ticket #41; shutting down pump_A would leave 0 kW of cooling for 48 kW of IT load.',
    chosen_plan_json: JSON.stringify(plans.plans[0]), resolved_tick: 0,
  }],
  action: [{
    id: ACTION_ID, request_key: '6f1c2b9e-4d3a-4f8e-9b1a-2c7d5e8f0a13', requested_by: 'agent', kind: 'shutdown_component',
    target_id: 'pump_A', params_json: '{}', status: 'blocked',
    safety_reason: 'BLOCKED: cooling 0 kW < load 48 kW; projected: 8 racks shut down within 360 s',
    predicted_json: JSON.stringify({ min_cooling_margin_kw: -48, peak_temp_c: 33.6, racks_degraded: 0, racks_shutdown: 0, downtime_rack_s: 0 }),
    incident_id: INCIDENT_ID, tick: TICK - 3,
  }],
  agent_step: agentSteps,
  metric: [
    { key: 'events_per_s', value: 14 },
    { key: 'subscribers', value: 3 },
    { key: 'agent_calls', value: 9 },
    { key: 'agent_tokens', value: 4120 },
    { key: 'downtime_rack_s', value: 0 },
    { key: 'unsafe_blocked', value: 1 },
    { key: 'unsafe_executed', value: 0 },
  ],
};

write('rows_public.json', rows);
write('agent_steps_example.json', agentSteps);

// ---------- presets (only once PRESET_CONFIGS is real) ----------
const presetEntries = Object.entries(PRESET_CONFIGS as Record<string, unknown>);
if (presetEntries.length > 0) {
  const warnings: Record<string, string[]> = {};
  for (const [key, cfg] of presetEntries) {
    write(`presets/${key}.json`, cfg);
    warnings[key] = compileTopology(cfg as Parameters<typeof compileTopology>[0]).warnings;
  }
  write('presets/warnings.json', warnings);
}
