// Redaction for everything the harness writes (console, JSON, markdown, agent stderr tails). Pure.
//
// Two layers: (1) exact secret values known to the harness (tokens, API keys) are replaced wherever they
// appear; (2) anything that LOOKS like a bearer token / JWT / long hex-ish credential is masked too, so a
// child-process stack trace that embeds a token we never saw still does not leak it.

export const SECRET_ENV_KEYS = ['STDB_ADMIN_TOKEN', 'STDB_AGENT_TOKEN', 'STDB_GATEWAY_TOKEN', 'NIM_API_KEY', 'VITE_ADMIN_TOKEN'] as const;
export const MASK = '***';
const MIN_SECRET_LEN = 4;

/** JWT-like: three base64url segments. Also `Bearer xxx`, `nvapi-...`, and 48+ char hex/base64 runs. */
const SHAPE_PATTERNS: readonly RegExp[] = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /nvapi-[A-Za-z0-9_-]{12,}/g,
  /\b[A-Fa-f0-9]{48,}\b/g,
];

export interface Redactor {
  (text: string): string;
  /** Deep-copy an object with every string field redacted. */
  value<T>(v: T): T;
}

/** Build a redactor for the given secret values (undefined/short values are ignored). */
export function createRedactor(secrets: readonly (string | undefined)[]): Redactor {
  const exact = [...new Set(secrets.filter((s): s is string => typeof s === 'string' && s.length >= MIN_SECRET_LEN))]
    // longest first so a secret that is a prefix of another cannot leave a tail behind
    .sort((a, b) => b.length - a.length);
  const fn = ((text: string): string => {
    let out = text;
    for (const s of exact) out = out.split(s).join(MASK);
    for (const re of SHAPE_PATTERNS) out = out.replace(re, (m, g1?: string) => (typeof g1 === 'string' && m.startsWith(g1) ? `${g1}${MASK}` : MASK));
    return out;
  }) as Redactor;
  fn.value = <T>(v: T): T => redactValue(v, fn) as T;
  return fn;
}

function redactValue(v: unknown, fn: (s: string) => string): unknown {
  if (typeof v === 'string') return fn(v);
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map((x) => redactValue(x, fn));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = (SECRET_ENV_KEYS as readonly string[]).includes(k) && typeof x === 'string' && x.length > 0 ? MASK : redactValue(x, fn);
    }
    return out;
  }
  return v;
}

/** Secret values found in an env-like record (for building a redactor). */
export function secretsFromEnv(env: Record<string, string | undefined>): string[] {
  return SECRET_ENV_KEYS.map((k) => env[k]).filter((v): v is string => typeof v === 'string' && v.length >= MIN_SECRET_LEN);
}

/** A copy of the env that is safe to print: secrets masked, presence preserved. */
export function describeEnv(env: Record<string, string | undefined>, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = env[k];
    out[k] = v === undefined || v === '' ? '(unset)' : (SECRET_ENV_KEYS as readonly string[]).includes(k) ? MASK : v;
  }
  return out;
}
