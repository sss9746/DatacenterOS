import { describe, expect, it } from 'vitest';
import { AGENT_ENTRY, AGENT_ENV_KEYS, agentSpawnSpec, buildAgentEnv, directAgentSpawnSpec } from '../../scripts/live/agent-process.js';
import { expectsLead, needsDirectAgent } from '../../scripts/live/cases.js';

const input = { uri: 'ws://localhost:3000', db: 'dcos-dev', agentToken: 'tok', noLlm: false };

describe('agent child env: team mode', () => {
  it('passes the requested mode to the child and lists the key', () => {
    expect(buildAgentEnv({ ...input, base: {}, teamMode: 'multi' }).DCOS_AGENT_TEAM_MODE).toBe('multi');
    expect(AGENT_ENV_KEYS).toContain('DCOS_AGENT_TEAM_MODE');
  });

  it('wins over a stray value in the merged env, in both directions', () => {
    expect(buildAgentEnv({ ...input, base: { DCOS_AGENT_TEAM_MODE: 'multi' }, teamMode: 'single' }).DCOS_AGENT_TEAM_MODE).toBe('single');
    expect(buildAgentEnv({ ...input, base: { DCOS_AGENT_TEAM_MODE: 'single' }, teamMode: 'multi' }).DCOS_AGENT_TEAM_MODE).toBe('multi');
  });
});

describe('agent launch spec', () => {
  it('the direct spec runs the agent entry in the spawned process, with no tsx/cli wrapper', () => {
    const spec = directAgentSpawnSpec();
    expect(spec.args[0]).toBe('--import');
    expect(spec.args[1]).toMatch(/^file:.*tsx.*loader\.mjs$/);
    expect(spec.args[2]).toBe(AGENT_ENTRY);
    expect(spec.args.join(' ')).not.toMatch(/cli\.mjs/);
  });

  it('single-mode L1-L6 keep the original launch; Scene B and multi use the direct one', () => {
    expect(agentSpawnSpec().args[0]).toMatch(/cli\.mjs$/);
    for (const id of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'] as const) {
      expect(needsDirectAgent(id, 'single')).toBe(false);
      expect(needsDirectAgent(id, 'multi')).toBe(true);
    }
    expect(needsDirectAgent('SB', 'single')).toBe(true);
    expect(needsDirectAgent('SBK', 'single')).toBe(true);
  });
});

describe('expectsLead', () => {
  it('needs a live model, and never holds for L6', () => {
    expect(expectsLead('L3', 'live_nim')).toBe(true);
    expect(expectsLead('SB', 'live_nim')).toBe(true);
    expect(expectsLead('L6', 'live_nim')).toBe(false);
    expect(expectsLead('L3', 'deterministic_no_llm')).toBe(false);
  });
});
