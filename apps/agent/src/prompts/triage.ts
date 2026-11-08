// System prompt + tool definition for the P3-3 triage confirmation step (LANE-P3 "Prompting rules").
// The model only assesses deterministic candidates; it never writes to the DB and never acts.

import type { LlmToolDef } from '../ports.js';

export const TRIAGE_TOOL_NAME = 'submit_incident_assessment';

export const TRIAGE_SYSTEM_PROMPT = [
  'You are a GPU-cluster incident engineer doing triage for DataCenterOS.',
  'Deterministic code has grouped observed symptoms into candidate incidents by dependency path',
  '(gpu -> node -> rack -> cooling loop -> pump). Your job is to review each candidate and call',
  `${TRIAGE_TOOL_NAME} exactly once with one assessment per candidate.`,
  '',
  'Rules:',
  '- Use only the data in the user message. Do not invent resources, events or measurements.',
  '- Every assessment must cite evidence_ids copied verbatim from the input (symptom ids or event ids).',
  '- decision "confirm": the grouping is right. Write a short hypothesis (1-2 sentences) naming the likely cause.',
  '- decision "split": some symptoms do not share the cause. List them in split_symptom_ids; they become a separate incident.',
  '- decision "merge_into": this candidate has the same cause as candidate `target`. Only merge candidates that share a',
  '  cooling or hosting provider; never merge just because events happened at the same time.',
  '- An XID error (48/74/79) on a GPU whose providers are healthy is an independent hardware fault, not a cooling symptom.',
  '- Never claim a GPU or pump is repaired or recovered. Cordoning or moving work is not a repair.',
  '- If you are unsure, confirm the candidate with confidence <= 0.5 and say "needs_approval" in the hypothesis.',
  '- Keep hypotheses short and factual. Do not include step-by-step reasoning.',
].join('\n');

export const TRIAGE_TOOL: LlmToolDef = {
  name: TRIAGE_TOOL_NAME,
  description:
    'Submit the triage assessment for the candidate incidents: confirm, split or merge each one, with a short hypothesis, a confidence in [0,1] and the evidence_ids that support it.',
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
            candidate_id: { type: 'string', description: 'candidate_id from the input' },
            decision: { type: 'string', enum: ['confirm', 'split', 'merge_into'] },
            target: { type: 'string', description: 'merge_into only: the candidate_id to merge into' },
            split_symptom_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'split only: symptom ids to move into a separate incident',
            },
            hypothesis: { type: 'string', maxLength: 600 },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            evidence_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
          },
        },
      },
    },
  },
};

export function buildTriageUserMessage(payloadJson: string): string {
  return `Candidate incidents (JSON). Assess every candidate.\n${payloadJson}`;
}
