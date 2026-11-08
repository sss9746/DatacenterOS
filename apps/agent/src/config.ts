// Agent configuration: env vars from CONTRACTS §0.10 that apps/agent uses.
// process.env wins; a repo-root .env.local (if present) fills gaps. No dotenv dependency.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Hosted NVIDIA API catalog endpoint, used as the default fallback (LANE-P3 P3-0). */
export const DEFAULT_NIM_FALLBACK_BASE_URL = 'https://integrate.api.nvidia.com/v1';

const optionalString = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .optional();

const optionalUrl = optionalString.pipe(z.url().optional());

/** AGENT_NAME: Identifier-safe, short; the worker id becomes `<name>-<pid>` (multi-agent harness, SCOPE §5). */
export const AGENT_NAME_RE = /^[a-z0-9-]{1,24}$/;
const optionalAgentName = optionalString.refine((v) => v === undefined || AGENT_NAME_RE.test(v), {
  message: 'must match [a-z0-9-]{1,24}',
});
/** AGENT_ZONE: the cooling loop whose incidents this agent claims first (a preference, never exclusive). */
export const AGENT_ZONES = ['loop-a', 'loop-b'] as const;
export type AgentZone = (typeof AGENT_ZONES)[number];
const optionalZone = optionalString.refine((v) => v === undefined || (AGENT_ZONES as readonly string[]).includes(v), {
  message: `must be one of ${AGENT_ZONES.join(', ')}`,
});

const intWithDefault = (def: number, min: number, max: number) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `must be an integer in [${min}, ${max}], got "${v}"` });
        return z.NEVER;
      }
      return n;
    });

const envSchema = z.object({
  AGENT_NAME: optionalAgentName,
  AGENT_ZONE: optionalZone,
  STDB_URI: optionalUrl,
  STDB_DB: optionalString,
  STDB_AGENT_TOKEN: optionalString,
  NIM_BASE_URL: optionalUrl,
  NIM_API_KEY: optionalString,
  NIM_MODEL: optionalString,
  NIM_FALLBACK_BASE_URL: optionalUrl,
  NIM_FALLBACK_MODEL: optionalString,
  LLM_MAX_TOKENS: intWithDefault(768, 1, 32_768),
  LLM_MAX_TOOL_STEPS: intWithDefault(8, 1, 64),
  LLM_TIMEOUT_MS: intWithDefault(10_000, 100, 600_000),
  LLM_RETRIES: intWithDefault(1, 0, 5),
  NIM_ENABLE_THINKING: z
    .string()
    .trim()
    .toLowerCase()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return 'false' as const;
      if (v === 'true' || v === 'false' || v === 'omit') return v;
      ctx.addIssue({ code: 'custom', message: `must be 'true', 'false' or 'omit', got "${v}"` });
      return z.NEVER;
    }),
});

/** Every env var the agent reads. Secrets: NIM_API_KEY, STDB_AGENT_TOKEN. */
export type AgentConfig = {
  readonly AGENT_NAME: string | undefined;
  readonly AGENT_ZONE: AgentZone | undefined;
  readonly STDB_URI: string | undefined;
  readonly STDB_DB: string | undefined;
  readonly STDB_AGENT_TOKEN: string | undefined;
  readonly NIM_BASE_URL: string | undefined;
  readonly NIM_API_KEY: string | undefined;
  readonly NIM_MODEL: string | undefined;
  readonly NIM_FALLBACK_BASE_URL: string;
  readonly NIM_FALLBACK_MODEL: string | undefined;
  readonly LLM_MAX_TOKENS: number;
  readonly LLM_MAX_TOOL_STEPS: number;
  readonly LLM_TIMEOUT_MS: number;
  readonly LLM_RETRIES: number;
  readonly NIM_ENABLE_THINKING: 'true' | 'false' | 'omit';
};

export type AgentConfigKey = keyof AgentConfig;

export const SECRET_KEYS: readonly AgentConfigKey[] = ['NIM_API_KEY', 'STDB_AGENT_TOKEN'] as const;

const CONFIG_KEYS = Object.keys(envSchema.shape) as AgentConfigKey[];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Parse a .env-style file body (KEY=VALUE, # comments, optional quotes, optional `export `). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!;
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2]!;
    else value = value.replace(/\s+#.*$/, '').trim();
    out[key] = value;
  }
  return out;
}

/** Repo root (apps/agent/src -> ../../..). */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/** Read repo-root .env.local if present; returns {} otherwise. */
export function readEnvLocal(root: string = repoRoot()): Record<string, string> {
  const p = resolve(root, '.env.local');
  if (!existsSync(p)) return {};
  return parseEnvFile(readFileSync(p, 'utf8'));
}

/**
 * Build a validated AgentConfig. `env` (default process.env) takes precedence over `fileEnv`
 * (default: repo-root .env.local). Throws ConfigError with every problem listed (no secret values).
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  fileEnv: Record<string, string> = readEnvLocal(),
): AgentConfig {
  const merged: Record<string, string | undefined> = {};
  for (const key of CONFIG_KEYS) merged[key] = env[key] ?? fileEnv[key];
  const parsed = envSchema.safeParse(merged);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`invalid agent config:\n  ${problems.join('\n  ')}`);
  }
  const c = parsed.data;
  const cfg: AgentConfig = {
    AGENT_NAME: c.AGENT_NAME,
    AGENT_ZONE: c.AGENT_ZONE as AgentZone | undefined,
    STDB_URI: c.STDB_URI,
    STDB_DB: c.STDB_DB,
    STDB_AGENT_TOKEN: c.STDB_AGENT_TOKEN,
    NIM_BASE_URL: c.NIM_BASE_URL,
    NIM_API_KEY: c.NIM_API_KEY,
    NIM_MODEL: c.NIM_MODEL,
    NIM_FALLBACK_BASE_URL: c.NIM_FALLBACK_BASE_URL ?? DEFAULT_NIM_FALLBACK_BASE_URL,
    NIM_FALLBACK_MODEL: c.NIM_FALLBACK_MODEL,
    LLM_MAX_TOKENS: c.LLM_MAX_TOKENS,
    LLM_MAX_TOOL_STEPS: c.LLM_MAX_TOOL_STEPS,
    LLM_TIMEOUT_MS: c.LLM_TIMEOUT_MS,
    LLM_RETRIES: c.LLM_RETRIES,
    NIM_ENABLE_THINKING: c.NIM_ENABLE_THINKING,
  };
  return Object.freeze(cfg);
}

/** Worker id for the DB lease owner: `<AGENT_NAME>-<pid>` when AGENT_NAME is set, else `agent-<host>-<pid>`. */
export function workerIdFor(cfg: Pick<AgentConfig, 'AGENT_NAME'>, host: string, pid: number): string {
  return cfg.AGENT_NAME ? `${cfg.AGENT_NAME}-${pid}` : `agent-${host}-${pid}`;
}

/** Message sender name: AGENT_NAME when set, else the full worker id. */
export const agentNameFor = (cfg: Pick<AgentConfig, 'AGENT_NAME'>, workerId: string): string => cfg.AGENT_NAME ?? workerId;

/** Throw a ConfigError naming any of `keys` that are unset (e.g. before connecting to NIM or STDB). */
export function requireConfig<K extends AgentConfigKey>(
  cfg: AgentConfig,
  keys: readonly K[],
): AgentConfig & { readonly [P in K]-?: NonNullable<AgentConfig[P]> } {
  const missing = keys.filter((k) => cfg[k] === undefined);
  if (missing.length > 0) throw new ConfigError(`missing required env vars: ${missing.join(', ')}`);
  return cfg as AgentConfig & { readonly [P in K]-?: NonNullable<AgentConfig[P]> };
}

const mask = (v: string | undefined): string => (v === undefined ? '(unset)' : '***');

/** A copy of the config that is safe to log: secrets become "***" (or "(unset)"). */
export function redact(cfg: AgentConfig): Record<AgentConfigKey, string | number | undefined> {
  const out = { ...cfg } as Record<AgentConfigKey, string | number | undefined>;
  for (const k of SECRET_KEYS) out[k] = mask(cfg[k] as string | undefined);
  return out;
}

/** Replace every secret value that appears inside `text` (e.g. an error message or URL) with "***". */
export function redactString(text: string, cfg: AgentConfig): string {
  let out = text;
  for (const k of SECRET_KEYS) {
    const v = cfg[k];
    if (typeof v === 'string' && v.length >= 4) out = out.split(v).join('***');
  }
  return out;
}
