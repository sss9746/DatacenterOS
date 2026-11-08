// The REAL agent as a child process: the same entry `pnpm --filter agent start` runs (tsx src/main.ts),
// with the agent's env passed through. Kill is SIGKILL (no graceful stop: the point is a crash); on
// Windows `child.kill('SIGKILL')` terminates the process, with `taskkill /F /T` as the fallback for the
// process tree. stdout/stderr are kept as a redacted ring buffer for the failure artifact.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const AGENT_ENTRY = resolve(AGENT_DIR, 'src', 'main.ts');
const TAIL_LINES = 200;
const EXIT_WAIT_MS = 5_000;

/** Env var names the agent reads (config.ts) plus the ones this harness sets. Everything else passes through untouched. */
export const AGENT_ENV_KEYS = [
  'STDB_URI', 'STDB_DB', 'STDB_AGENT_TOKEN',
  'NIM_BASE_URL', 'NIM_API_KEY', 'NIM_MODEL', 'NIM_FALLBACK_BASE_URL', 'NIM_FALLBACK_MODEL',
  'LLM_MAX_TOKENS', 'LLM_MAX_TOOL_STEPS', 'LLM_TIMEOUT_MS', 'LLM_RETRIES', 'NIM_ENABLE_THINKING',
] as const;

export interface AgentEnvInput {
  /** Merged process.env + .env.local view (harness-side). */
  base: Record<string, string | undefined>;
  uri: string;
  db: string;
  agentToken: string;
  /** Deterministic rehearsal: strip NIM credentials so the agent runs with llm=null. */
  noLlm: boolean;
  /** L6: point NIM (and its fallback) at an unreachable endpoint with a short timeout. */
  llmOverride?: { baseUrl: string; timeoutMs: number; retries: number };
}

/**
 * Build the child env. Explicit harness values win over whatever .env.local says (so `--db dcos-dev` can
 * never be overridden by a stray STDB_DB=dcos in the file). Empty string beats a file value in config.ts
 * (`env[key] ?? fileEnv[key]`), which is how `noLlm` disables the key without deleting it from the file.
 */
export function buildAgentEnv(input: AgentEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.base)) if (typeof v === 'string') env[k] = v;
  env.STDB_URI = input.uri;
  env.STDB_DB = input.db;
  env.STDB_AGENT_TOKEN = input.agentToken;
  if (input.noLlm) {
    env.NIM_API_KEY = '';
    env.NIM_MODEL = '';
  }
  if (input.llmOverride) {
    env.NIM_BASE_URL = input.llmOverride.baseUrl;
    env.NIM_FALLBACK_BASE_URL = input.llmOverride.baseUrl;
    env.LLM_TIMEOUT_MS = String(input.llmOverride.timeoutMs);
    env.LLM_RETRIES = String(input.llmOverride.retries);
    // The LLM path must be EXERCISED (and fail) rather than skipped: give it a key/model if none is set.
    if (!env.NIM_API_KEY) env.NIM_API_KEY = 'live-recovery-l6-unreachable-endpoint-key';
    if (!env.NIM_MODEL) env.NIM_MODEL = 'live-recovery-l6-model';
  }
  return env;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
}

/** node <tsx/cli> src/main.ts — identical to the package `start` script, without a shell. */
export function agentSpawnSpec(): SpawnSpec {
  const req = createRequire(resolve(AGENT_DIR, 'package.json'));
  const tsxCli = req.resolve('tsx/cli');
  return { command: process.execPath, args: [tsxCli, AGENT_ENTRY], cwd: AGENT_DIR };
}

export interface AgentHandle {
  readonly pid: number;
  readonly startedUnixMs: number;
  readonly generation: number;
  isAlive(): boolean;
  exitCode(): number | null;
  exitSignal(): NodeJS.Signals | null;
  /** Redacted last lines of stdout+stderr (interleaved, oldest first). */
  tail(): string[];
  /** SIGKILL and wait (bounded) for the process to be gone. */
  kill(): Promise<{ how: 'SIGKILL' | 'taskkill' | 'already_exited'; waitedMs: number }>;
  /** Resolve when the process exits by itself (bounded). */
  waitExit(timeoutMs: number): Promise<boolean>;
}

export interface SpawnAgentOptions {
  env: Record<string, string>;
  redact: (s: string) => string;
  generation: number;
  onLine?: (line: string) => void;
  spec?: SpawnSpec;
}

export function spawnAgent(opts: SpawnAgentOptions): AgentHandle {
  const spec = opts.spec ?? agentSpawnSpec();
  const child: ChildProcess = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const started = Date.now();
  const ring: string[] = [];
  let code: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let exited = false;
  const exitPromise = new Promise<void>((res) => {
    child.once('exit', (c, s) => {
      code = c;
      signal = s;
      exited = true;
      res();
    });
    child.once('error', (e) => {
      ring.push(opts.redact(`[spawn error] ${e.message}`));
      exited = true;
      res();
    });
  });
  const feed = (stream: 'out' | 'err') => (chunk: Buffer) => {
    for (const raw of chunk.toString('utf8').split(/\r?\n/)) {
      if (raw === '') continue;
      const line = opts.redact(`[${stream}] ${raw}`);
      ring.push(line);
      if (ring.length > TAIL_LINES) ring.shift();
      opts.onLine?.(line);
    }
  };
  child.stdout?.on('data', feed('out'));
  child.stderr?.on('data', feed('err'));

  const waitExit = async (timeoutMs: number): Promise<boolean> => {
    if (exited) return true;
    let t: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<false>((r) => (t = setTimeout(() => r(false), timeoutMs)));
    const r = await Promise.race([exitPromise.then(() => true as const), timeout]);
    if (t) clearTimeout(t);
    return r;
  };

  return {
    pid: child.pid ?? -1,
    startedUnixMs: started,
    generation: opts.generation,
    isAlive: () => !exited,
    exitCode: () => code,
    exitSignal: () => signal,
    tail: () => [...ring],
    waitExit,
    async kill() {
      const t0 = Date.now();
      if (exited) return { how: 'already_exited', waitedMs: 0 };
      child.kill('SIGKILL');
      if (await waitExit(EXIT_WAIT_MS)) return { how: 'SIGKILL', waitedMs: Date.now() - t0 };
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
        if (await waitExit(EXIT_WAIT_MS)) return { how: 'taskkill', waitedMs: Date.now() - t0 };
      }
      throw new Error(`agent pid ${child.pid} did not exit ${Date.now() - t0} ms after SIGKILL`);
    },
  };
}
