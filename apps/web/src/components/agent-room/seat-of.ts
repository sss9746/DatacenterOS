// Pure mapping from a persisted agent event to the specialist seat that "spoke" it. Attribution comes from the
// persisted `actor` field only; an event without one is always Unattributed, never guessed as Nemotron.

import type { AgentActor, AgentEventInput } from '@dcos/db-client';

export type Seat = 'triage' | 'planner' | 'simulator' | 'safety' | 'coordinator' | 'verifier' | 'unattributed';

export interface SeatInfo { id: Seat; name: string; role: string; actor: AgentActor | null; initial: string }

export const SEATS: readonly SeatInfo[] = [
  { id: 'triage', name: 'Triage', role: 'triage · diagnose', actor: 'nemotron', initial: 'T' },
  { id: 'planner', name: 'Planner', role: 'plan · replan', actor: 'nemotron', initial: 'P' },
  { id: 'simulator', name: 'Simulator', role: 'simulate_plan', actor: 'code', initial: 'S' },
  { id: 'safety', name: 'Safety', role: 'evaluate_safety', actor: 'code', initial: 'G' },
  { id: 'coordinator', name: 'Coordinator', role: 'ledger · actions', actor: 'code', initial: 'C' },
  { id: 'verifier', name: 'Verifier', role: 'verify · handoff', actor: 'code', initial: 'V' },
];

export const UNATTRIBUTED: SeatInfo = { id: 'unattributed', name: 'Unattributed', role: 'actor not recorded', actor: null, initial: '?' };

export const seatInfo = (seat: Seat): SeatInfo => SEATS.find((s) => s.id === seat) ?? UNATTRIBUTED;

/** Same shape as workflow-view's (unexported) RESUME_SUMMARY_RE; it is not exported there, so it is mirrored here. */
export const RESUME_SUMMARY_RE = /^(?:Example:\s*)?(?:resumed after agent restart|continuing \S+ from stage \S+ after agent restart)/i;

const PLANNER_TOOLS = new Set(['propose_plan', 'list_placement_candidates']);
const TRIAGE_TOOLS = new Set(['group_symptoms', 'upsert_symptoms', 'upsert_incident', 'get_incident_evidence']);
const SIMULATOR_TOOLS = new Set(['simulate_plan', 'get_resource_dependencies', 'get_job_state']);
const COORDINATOR_TOOLS = new Set(['request_action', 'claim_action', 'start_action', 'cancel_action', 'get_action_status']);
const BLOCKED_RE = /\bBLOCKED\b/;

export function seatOf(event: AgentEventInput): Seat {
  const tools = new Set(event.tool_calls.map((t) => t.tool));
  const has = (names: Set<string>) => [...tools].some((t) => names.has(t));
  if (event.actor === 'nemotron') {
    if (event.stage === 'triage' || event.stage === 'diagnose') return 'triage';
    if (event.stage === 'plan' || event.stage === 'replan') return 'planner';
    if (has(PLANNER_TOOLS)) return 'planner';
    if (has(TRIAGE_TOOLS)) return 'triage';
    return 'unattributed';
  }
  if (event.actor === 'code') {
    if (has(SIMULATOR_TOOLS)) return 'simulator';
    if (tools.has('evaluate_safety') || BLOCKED_RE.test(event.summary)) return 'safety';
    if (has(COORDINATOR_TOOLS) || event.stage === 'execute') return 'coordinator';
    if (tools.has('verify_action') || event.stage === 'verify') return 'verifier';
    if (event.stage === 'safety') return 'safety';
    if (event.stage === 'plan' || event.stage === 'replan') return 'simulator';
    if (event.stage === 'triage' || event.stage === 'diagnose') return 'coordinator';
    if (RESUME_SUMMARY_RE.test(event.summary)) return 'coordinator';
    return 'coordinator';
  }
  return 'unattributed';
}
