// Planner prompt + choose_options tool definition (LANE-P3 P3-4, "Prompting rules").
// Nemotron only chooses among options the deterministic planner already scored and safety-checked;
// code re-validates every choice and never lets it pick an excluded option.

import type { LlmToolDef } from '../ports.js';

export const CHOOSE_OPTIONS_TOOL_NAME = 'choose_options';

export const PLANNER_SYSTEM_PROMPT = [
  'You are a GPU-cluster incident engineer choosing mitigation options during an active incident.',
  'Use only the data in the user message. It lists, per affected job, the top options already scored by a deterministic',
  'physics simulator (expected lost work units, completion delay in sim-seconds, GPU-busy waste, failure risk) and',
  'ranked by: no unsafe actions, then least irreversible work loss, then least completion delay, then least GPU-busy waste,',
  'then fewest preemptions. Options under "excluded" failed a hard safety check: never choose them.',
  'For every job, call choose_options once with exactly one option_id from that job\'s "options" list.',
  'Prefer rank 1 unless the data gives a concrete reason to prefer another listed option; say that reason.',
  'Each explanation is one or two short sentences citing the numbers or evidence IDs you used. Do not show step-by-step reasoning.',
  'Never claim a GPU, pump or cooling loop is repaired; checkpoint, migrate and cordon only mitigate.',
  'If the evidence looks stale, the options look wrong, or you are unsure, set needs_approval to true.',
].join('\n');

export const CHOOSE_OPTIONS_TOOL: LlmToolDef = {
  name: CHOOSE_OPTIONS_TOOL_NAME,
  description:
    'Choose one pre-scored, safety-checked option per affected job and explain the choice briefly. ' +
    'This only records a proposal: deterministic code re-checks safety and executes nothing itself.',
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
            explanation: { type: 'string', description: 'One or two short sentences citing the metrics or evidence IDs used.' },
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
