import { describe, expect, it } from 'vitest';
import {
  AGENT_NAME_RE,
  agentNameFor,
  ConfigError,
  DEFAULT_NIM_FALLBACK_BASE_URL,
  loadConfig,
  parseEnvFile,
  redact,
  redactString,
  requireConfig,
  workerIdFor,
} from '../src/config.js';

describe('loadConfig', () => {
  it('applies §0.10 defaults when nothing is set', () => {
    const c = loadConfig({}, {});
    expect(c.LLM_MAX_TOKENS).toBe(768);
    expect(c.LLM_MAX_TOOL_STEPS).toBe(8);
    expect(c.LLM_TIMEOUT_MS).toBe(10_000);
    expect(c.LLM_RETRIES).toBe(1);
    expect(c.NIM_ENABLE_THINKING).toBe('false');
    expect(c.NIM_FALLBACK_BASE_URL).toBe(DEFAULT_NIM_FALLBACK_BASE_URL);
    expect(c.NIM_API_KEY).toBeUndefined();
  });

  it('parses NIM_ENABLE_THINKING and LLM_RETRIES', () => {
    expect(loadConfig({ NIM_ENABLE_THINKING: 'TRUE', LLM_RETRIES: '3' }, {})).toMatchObject({ NIM_ENABLE_THINKING: 'true', LLM_RETRIES: 3 });
    expect(loadConfig({ NIM_ENABLE_THINKING: 'omit' }, {}).NIM_ENABLE_THINKING).toBe('omit');
    expect(() => loadConfig({ NIM_ENABLE_THINKING: 'maybe' }, {})).toThrow(/NIM_ENABLE_THINKING/);
    expect(() => loadConfig({ LLM_RETRIES: '6' }, {})).toThrow(ConfigError);
    expect(loadConfig({ LLM_RETRIES: '0' }, {}).LLM_RETRIES).toBe(0);
  });

  it('lets process env override .env.local and treats empty strings as unset', () => {
    const c = loadConfig(
      { NIM_MODEL: 'env-model', NIM_API_KEY: '' },
      { NIM_MODEL: 'file-model', NIM_API_KEY: 'file-key', LLM_MAX_TOKENS: '512' },
    );
    expect(c.NIM_MODEL).toBe('env-model');
    expect(c.NIM_API_KEY).toBeUndefined();
    expect(c.LLM_MAX_TOKENS).toBe(512);
  });

  it('rejects bad numbers and URLs without echoing secrets', () => {
    expect(() => loadConfig({ LLM_TIMEOUT_MS: 'soon' }, {})).toThrow(ConfigError);
    expect(() => loadConfig({ NIM_BASE_URL: 'not a url' }, {})).toThrow(/NIM_BASE_URL/);
    let msg = '';
    try {
      loadConfig({ LLM_MAX_TOKENS: '-1', NIM_API_KEY: 'nvapi-SECRET' }, {});
    } catch (e) {
      msg = String(e);
    }
    expect(msg).toMatch(/LLM_MAX_TOKENS/);
    expect(msg).not.toContain('nvapi-SECRET');
  });

  it('AGENT_NAME: optional, Identifier-safe [a-z0-9-]{1,24}; drives the worker id and the message name', () => {
    expect(loadConfig({}, {}).AGENT_NAME).toBeUndefined();
    expect(loadConfig({ AGENT_NAME: 'agent-alpha' }, {}).AGENT_NAME).toBe('agent-alpha');
    expect(loadConfig({ AGENT_NAME: '' }, { AGENT_NAME: 'from-file' }).AGENT_NAME).toBeUndefined(); // empty env beats the file
    expect(loadConfig({}, { AGENT_NAME: 'from-file' }).AGENT_NAME).toBe('from-file');
    for (const bad of ['Agent', 'agent_alpha', 'agent alpha', 'a'.repeat(25), 'ag.ent']) {
      expect(() => loadConfig({ AGENT_NAME: bad }, {}), bad).toThrow(/AGENT_NAME.*\[a-z0-9-\]\{1,24\}/);
      expect(AGENT_NAME_RE.test(bad)).toBe(false);
    }
    const named = loadConfig({ AGENT_NAME: 'agent-alpha' }, {});
    expect(workerIdFor(named, 'host', 4242)).toBe('agent-alpha-4242');
    expect(workerIdFor(loadConfig({}, {}), 'host', 4242)).toBe('agent-host-4242');
    expect(agentNameFor(named, 'agent-alpha-4242')).toBe('agent-alpha');
    expect(agentNameFor(loadConfig({}, {}), 'agent-host-4242')).toBe('agent-host-4242');
    expect(redact(named).AGENT_NAME).toBe('agent-alpha'); // not a secret: visible in the startup config line
  });

  it('AGENT_ZONE: optional loop-a | loop-b', () => {
    expect(loadConfig({}, {}).AGENT_ZONE).toBeUndefined();
    expect(loadConfig({ AGENT_ZONE: 'loop-b' }, {}).AGENT_ZONE).toBe('loop-b');
    expect(() => loadConfig({ AGENT_ZONE: 'loop-c' }, {})).toThrow(/AGENT_ZONE.*loop-a, loop-b/);
    expect(redact(loadConfig({ AGENT_ZONE: 'loop-a' }, {})).AGENT_ZONE).toBe('loop-a');
  });

  it('requireConfig names missing keys', () => {
    expect(() => requireConfig(loadConfig({}, {}), ['NIM_BASE_URL', 'NIM_MODEL'])).toThrow(/NIM_BASE_URL, NIM_MODEL/);
  });
});

describe('redaction', () => {
  const cfg = loadConfig({ NIM_API_KEY: 'nvapi-SECRET123', STDB_AGENT_TOKEN: 'stdb-TOKEN456', NIM_MODEL: 'm' }, {});

  it('masks secrets in redact()', () => {
    const r = redact(cfg);
    expect(r.NIM_API_KEY).toBe('***');
    expect(r.STDB_AGENT_TOKEN).toBe('***');
    expect(r.NIM_MODEL).toBe('m');
    expect(JSON.stringify(r)).not.toMatch(/SECRET123|TOKEN456/);
  });

  it('scrubs secrets inside arbitrary strings', () => {
    expect(redactString('Bearer nvapi-SECRET123 failed for stdb-TOKEN456', cfg)).toBe('Bearer *** failed for ***');
  });
});

describe('parseEnvFile', () => {
  it('handles comments, quotes, export and inline comments', () => {
    const text = ['# c', 'export A=1', 'B="two words"', "C='x'", 'D=val # note', '', 'bad line', 'E='].join('\n');
    expect(parseEnvFile(text)).toEqual({ A: '1', B: 'two words', C: 'x', D: 'val', E: '' });
  });
});
