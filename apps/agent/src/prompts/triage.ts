// System prompt + tool definition for the P3-3 triage confirmation step (LANE-P3 "Prompting rules").
// The model only assesses deterministic candidates; it never writes to the DB and never acts.

import type { LlmToolDef } from '../ports.js';

export const TRIAGE_TOOL_NAME = 'submit_incident_assessment';

/** Output budget for the single triage tool call (llm.ts caps it at LLM_MAX_TOKENS, never raises it). */
export const TRIAGE_MAX_TOKENS = 1024;

export const TRIAGE_SYSTEM_PROMPT = [
  'You are a GPU-cluster incident engineer doing triage for DataCenterOS.',
  'Code grouped observed symptoms into candidate incidents by dependency path (gpu > node > rack > cooling loop > pump).',
  `Call ${TRIAGE_TOOL_NAME} EXACTLY ONCE, with one item per candidate in "incidents". Never repeat the call.`,
  'Rules:',
  '- Use only the input. Never invent resources, events or numbers.',
  '- evidence_ids: cite 1-5 refs exactly as listed in the input ("S1" symptom refs or "E1" evidence refs).',
  '- "confirm": grouping is right. hypothesis = ONE sentence <= 200 chars: evidence -> conclusion, using resource names;',
  '  never put S/E refs in the hypothesis. Example: "24 GPUs on racks r2-r4 throttling + pump-a degraded -> one cooling incident".',
  '  Independent fault: "XID 79 on gpu-r7-n1-3, providers healthy -> separate hardware incident".',
  '- "split": some symptoms do not share the cause; list their S refs in split_symptom_ids.',
  '- "merge_into": same cause as candidate `target`; only if they share a cooling or hosting provider, never for timing alone.',
  '- An XID (48/74/79) on a GPU with healthy providers is an independent hardware fault, not a cooling symptom.',
  '- Never claim anything is repaired; cordoning or moving work is not a repair.',
  '- Unsure: confirm with confidence <= 0.5 and say "needs_approval" in the hypothesis.',
].join('\n');

export const TRIAGE_TOOL: LlmToolDef = {
  name: TRIAGE_TOOL_NAME,
  description: 'Submit ONE triage assessment covering every candidate (call once).',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['incidents'],
    properties: {
      incidents: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['candidate_id', 'decision', 'hypothesis', 'confidence', 'evidence_ids'],
          properties: {
            candidate_id: { type: 'string' },
            decision: { type: 'string', enum: ['confirm', 'split', 'merge_into'] },
            target: { type: 'string', description: 'merge_into only: candidate_id to merge into' },
            split_symptom_ids: { type: 'array', items: { type: 'string' }, description: 'split only: S refs' },
            hypothesis: { type: 'string', maxLength: 600, description: 'ONE sentence <= 200 chars: evidence -> conclusion' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            evidence_ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'S/E refs from the input' },
          },
        },
      },
    },
  },
};

export function buildTriageUserMessage(payloadJson: string): string {
  return `Candidate incidents (JSON). Assess every candidate in one ${TRIAGE_TOOL_NAME} call.\n${payloadJson}`;
}
