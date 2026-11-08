// SSH transport to the Brev box: one-shot commands + a reconnecting line stream. Node built-ins only.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

const SSH_OPTS = [
  '-o', 'BatchMode=yes', // never prompt (no password/host-key prompts hanging the collector)
  '-o', 'ConnectTimeout=10',
  '-o', 'ServerAliveInterval=5',
  '-o', 'ServerAliveCountMax=3',
];
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** nvidia-smi -l 1 prints every second; 10 s of silence means the stream is wedged. */
const SILENCE_KILL_MS = 10_000;

const log = (msg: string) => process.stderr.write(`[collector] ${msg}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run one command over ssh and return stdout. Rejects on non-zero exit. */
export function sshExec(host: string, command: string, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...SSH_OPTS, host, command], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`ssh spawn failed: ${e.message} (is ssh on PATH?)`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`ssh ${host} exited ${code}: ${err.trim().split('\n').slice(-2).join(' | ')}`));
    });
  });
}

export interface StreamHandle {
  stop(): void;
}

/**
 * Stream stdout lines of `command` on `host`, reconnecting with exponential backoff forever.
 * Backoff resets once a reconnected stream produces a line.
 */
export function sshStreamLines(host: string, command: string, onLine: (line: string) => void): StreamHandle {
  let stopped = false;
  let child: ChildProcess | undefined;

  const runOnce = () =>
    new Promise<boolean>((resolve) => {
      let gotLine = false;
      let watchdog: NodeJS.Timeout | undefined;
      const arm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          log(`no output for ${SILENCE_KILL_MS / 1000}s; restarting ssh`);
          child?.kill();
        }, SILENCE_KILL_MS);
      };
      child = spawn('ssh', [...SSH_OPTS, host, command], { stdio: ['ignore', 'pipe', 'pipe'] });
      arm();
      createInterface({ input: child.stdout! }).on('line', (line) => {
        gotLine = true;
        arm();
        onLine(line);
      });
      child.stderr!.on('data', (d: Buffer) => log(`ssh stderr: ${d.toString().trim()}`));
      child.on('error', (e) => log(`ssh spawn failed: ${e.message}`));
      child.on('close', (code) => {
        clearTimeout(watchdog);
        resolve(gotLine);
        if (!stopped) log(`ssh stream closed (exit ${code})`);
      });
    });

  void (async () => {
    let backoff = BACKOFF_MIN_MS;
    while (!stopped) {
      const hadData = await runOnce();
      if (stopped) break;
      if (hadData) backoff = BACKOFF_MIN_MS;
      log(`reconnecting in ${backoff / 1000}s`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  })();

  return {
    stop() {
      stopped = true;
      child?.kill();
    },
  };
}
