// Planner prompt + choose_options tool definition (LANE-P3 P3-4, "Prompting rules").
// Nemotron only chooses among options the deterministic planner already scored and safety-checked;
// code re-validates every choice and never lets it pick an excluded option.

import type { LlmToolDef } from '../ports.js';

export const CHOOSE_OPTIONS_TOOL_NAME = 'choose_options';

/**
 * Output budget for the choose_options call. llm.ts already defaults tool-calling requests to 1024 tokens
 * (DEFAULT_TOOL_CALL_MAX_TOKENS); planner.ts may pass this explicitly as `maxTokens`.
 */
export const PLANNER_MAX_TOKENS = 1024;

export const PLANNER_SYSTEM_PROMPT = [
  'You are a GPU-cluster incident engineer choosing mitigation options during an active incident.',
  'Use only the input. Per affected job it lists the top options scored by a physics simulator (lost_wu = expected lost',
  'work units, delay_s = completion delay, waste_s = GPU-busy waste, risk = failure risk), ranked by: no unsafe actions,',
  'least work loss, least delay, least waste, fewest preemptions. "excluded" options failed a safety check: never choose them.',
  `Call ${CHOOSE_OPTIONS_TOOL_NAME} EXACTLY ONCE, with one entry per job, each with one option_id from that job's "options".`,
  'Prefer rank 1 unless the data gives a concrete reason for another listed option; say that reason.',
  'explanation = ONE sentence <= 200 chars: evidence -> choice, citing the numbers used. Example:',
  '"job-a: r2-r3 throttling -> checkpoint + move to r1+r5 (lost 0 wu vs 96 if kept)". No step-by-step reasoning.',
  'Never claim a GPU, pump or loop is repaired; checkpoint, migrate and cordon only mitigate.',
  'If the evidence looks stale, the options look wrong, or you are unsure, set needs_approval to true.',
].join('\n');

export const CHOOSE_OPTIONS_TOOL: LlmToolDef = {
  name: CHOOSE_OPTIONS_TOOL_NAME,
  description:
    'Record ONE proposal (call once): one pre-scored, safety-checked option per job. Code re-checks safety; this executes nothing.',
  parameters: {
    type: 'object',
    properties: {
      choices: {
        type: 'array',
        description: 'Exactly one entry per job in the input.',
        items: {
          type: 'object',
          properties: {
            job_id: { type: 'string', description: 'Job ID from the input, e.g. job-a.' },
            option_id: { type: 'string', description: "One option_id from that job's options list (never an excluded one)." },
            needs_approval: { type: 'boolean', description: 'True to require a human operator to approve before execution.' },
            explanation: { type: 'string', description: 'ONE sentence, <= 200 chars: evidence -> choice, citing the metrics used.' },
          },
          required: ['job_id', 'option_id', 'needs_approval', 'explanation'],
          additionalProperties: false,
        },
      },
    },
    required: ['choices'],
    additionalProperties: false,
  },
};

/** User message: a short instruction plus the bounded JSON payload. */
export const buildPlannerUserMessage = (payloadJson: string): string =>
  `Choose one option per job and call ${CHOOSE_OPTIONS_TOOL_NAME}.\nPLANNING_INPUT=${payloadJson}`;
