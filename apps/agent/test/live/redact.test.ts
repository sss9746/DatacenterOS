import { describe, expect, it } from 'vitest';
import { createRedactor, describeEnv, MASK, secretsFromEnv } from '../../scripts/live/redact.js';

const ADMIN = 'eyJhbGciOiJFUzI1NiJ9.eyJoZXhfaWRlbnRpdHkiOiJhYmMifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
const NIM = 'nvapi-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

describe('live harness redaction', () => {
  it('replaces exact secret values anywhere in text, longest first', () => {
    const r = createRedactor(['secret-value', 'secret-value-longer']);
    expect(r('a secret-value-longer and secret-value here')).toBe(`a ${MASK} and ${MASK} here`);
  });

  it('ignores short/undefined secrets so it never masks ordinary words', () => {
    const r = createRedactor([undefined, 'ab', '']);
    expect(r('ab abc')).toBe('ab abc');
  });

  it('masks JWT-like, Bearer and nvapi-shaped tokens it was never told about', () => {
    const r = createRedactor([]);
    expect(r(`token=${ADMIN}`)).toBe(`token=${MASK}`);
    expect(r(`Authorization: Bearer ${NIM}`)).toBe(`Authorization: Bearer ${MASK}`);
    expect(r(`key ${NIM}`)).toBe(`key ${MASK}`);
    expect(r('gpu-r7-n1-3 running at 600000')).toBe('gpu-r7-n1-3 running at 600000');
  });

  it('deep-redacts objects, masks secret env keys by name, and stringifies bigints', () => {
    const r = createRedactor([ADMIN]);
    const out = r.value({ STDB_ADMIN_TOKEN: 'whatever', note: `uses ${ADMIN}`, nested: [{ fencing_token: 42n }], n: 1 });
    expect(out).toEqual({ STDB_ADMIN_TOKEN: MASK, note: `uses ${MASK}`, nested: [{ fencing_token: '42' }], n: 1 });
  });

  it('collects secrets from env and describes env without values', () => {
    const env = { STDB_ADMIN_TOKEN: ADMIN, NIM_API_KEY: NIM, STDB_DB: 'dcos-dev', NIM_MODEL: 'nvidia/nemotron', STDB_AGENT_TOKEN: '' };
    expect(secretsFromEnv(env)).toEqual([ADMIN, NIM]);
    expect(describeEnv(env, ['STDB_DB', 'STDB_ADMIN_TOKEN', 'STDB_AGENT_TOKEN', 'NIM_MODEL', 'MISSING'])).toEqual({
      STDB_DB: 'dcos-dev',
      STDB_ADMIN_TOKEN: MASK,
      STDB_AGENT_TOKEN: '(unset)',
      NIM_MODEL: 'nvidia/nemotron',
      MISSING: '(unset)',
    });
  });
});
