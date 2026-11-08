import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_NIM_FALLBACK_BASE_URL,
  loadConfig,
  parseEnvFile,
  redact,
  redactString,
  requireConfig,
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
