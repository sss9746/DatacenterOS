// Agent supervisor (plan section 0.4): `pnpm --filter agent supervised`.
//
// Runs the agent entry as one child at a time and relaunches it after an abnormal exit (a crash, or a signal such as
// SIGKILL). SIGINT, SIGTERM and SIGHUP stop the agent and the supervisor without a relaunch. The restart count is
// bounded, and it resets once the agent has run stably for a while.
//
// A relaunched agent reclaims its workflows after the 15 s lease expires. This restarts the same agent on this machine;
// it does not cover a machine failure. Environment values are inherited and never printed.

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { directAgentSpawnSpec, type SpawnSpec } from './live/agent-process.js';

/** The agent's exit code when a lane's adapter is not shipped (main.ts): a relaunch cannot fix that. */
export const EXIT_NOT_READY = 3;
export const EXIT_GAVE_UP = 1;

export interface SupervisorPolicy {
  /** Relaunches allowed before the supervisor gives up. */
  maxRestarts: number;
  restartDelayMs: number;
  /** A run at least this long counts as stable and clears the restart count. */
  stableResetMs: number;
  /** After a requested stop, how long the agent gets to shut down before SIGKILL. */
  stopGraceMs: number;
}

export const DEFAULT_POLICY: SupervisorPolicy = { maxRestarts: 5, restartDelayMs: 1_000, stableResetMs: 120_000, stopGraceMs: 20_000 };

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** How long this child ran. */
  runMs: number;
  /** A stop signal reached the supervisor before this exit. */
  stopRequested: boolean;
}

export type Decision =
  | { kind: 'restart'; delayMs: number; restartsUsed: number; reason: string }
  | { kind: 'stop'; exitCode: number; reason: string };

export const describeExit = (code: number | null, signal: NodeJS.Signals | null): string => (signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`);

/** Pure restart decision. `restartsUsed` counts relaunches since the last stable run. */
export function decideAfterExit(policy: SupervisorPolicy, restartsUsed: number, exit: ChildExit): Decision {
  const how = describeExit(exit.code, exit.signal);
  if (exit.stopRequested) return { kind: 'stop', exitCode: exit.code ?? 0, reason: `stop requested; agent exited with ${how}` };
  if (exit.signal === null && exit.code === 0) return { kind: 'stop', exitCode: 0, reason: 'agent exited cleanly' };
  if (exit.signal === null && exit.code === EXIT_NOT_READY) return { kind: 'stop', exitCode: EXIT_NOT_READY, reason: 'agent adapters are not ready; a relaunch cannot fix that' };
  const used = exit.runMs >= policy.stableResetMs ? 0 : restartsUsed;
  if (used >= policy.maxRestarts) return { kind: 'stop', exitCode: EXIT_GAVE_UP, reason: `agent exited with ${how}; giving up after ${used} restarts` };
  return { kind: 'restart', delayMs: policy.restartDelayMs, restartsUsed: used + 1, reason: `agent exited abnormally with ${how} after ${(exit.runMs / 1000).toFixed(1)} s` };
}

export type StopSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

export interface ChildHandle {
  pid: number | undefined;
  kill(signal: NodeJS.Signals): void;
  /** Called exactly once, when the child is gone. */
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export interface SupervisorDeps {
  spawnChild: () => ChildHandle;
  log: (message: string) => void;
  /** Register for stop signals; returns the unregister function. */
  onStopSignal: (handler: (signal: StopSignal) => void) => () => void;
  policy?: Partial<SupervisorPolicy>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Runs until a decision says stop; resolves with the supervisor's exit code. */
export function runSupervisor(deps: SupervisorDeps): Promise<number> {
  const policy: SupervisorPolicy = { ...DEFAULT_POLICY, ...deps.policy };
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  return new Promise<number>((resolve) => {
    let child: ChildHandle | null = null;
    let restartsUsed = 0;
    let stopSignal: StopSignal | null = null;
    let restartTimer: unknown = null;
    let graceTimer: unknown = null;
    let finished = false;
    let unregister: () => void = () => undefined;

    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      if (restartTimer !== null) clearTimer(restartTimer);
      if (graceTimer !== null) clearTimer(graceTimer);
      unregister();
      resolve(code);
    };

    const launch = () => {
      restartTimer = null;
      let started: ChildHandle;
      try {
        started = deps.spawnChild();
      } catch (e) {
        deps.log(`could not launch the agent: ${e instanceof Error ? e.name : 'error'}`);
        finish(EXIT_GAVE_UP);
        return;
      }
      child = started;
      const startedAt = now();
      deps.log(`agent started (pid ${started.pid ?? 'unknown'})`);
      started.onExit((code, signal) => {
        child = null;
        if (graceTimer !== null) {
          clearTimer(graceTimer);
          graceTimer = null;
        }
        const decision = decideAfterExit(policy, restartsUsed, { code, signal, runMs: now() - startedAt, stopRequested: stopSignal !== null });
        if (decision.kind === 'stop') {
          deps.log(`stopping: ${decision.reason}`);
          finish(decision.exitCode);
          return;
        }
        restartsUsed = decision.restartsUsed;
        deps.log(`${decision.reason}; restart ${restartsUsed}/${policy.maxRestarts} in ${decision.delayMs} ms`);
        restartTimer = setTimer(launch, decision.delayMs);
      });
    };

    unregister = deps.onStopSignal((signal) => {
      // Only the first signal counts: tsx can relay one signal twice, and a second SIGINT would kill the agent mid-shutdown.
      if (stopSignal !== null || finished) return;
      stopSignal = signal;
      if (restartTimer !== null) {
        deps.log(`${signal} during the restart delay: not relaunching`);
        finish(0);
        return;
      }
      if (!child) return;
      deps.log(`${signal}: stopping the agent`);
      child.kill(signal === 'SIGHUP' ? 'SIGTERM' : signal);
      graceTimer = setTimer(() => {
        graceTimer = null;
        deps.log(`agent still running ${policy.stopGraceMs} ms after ${signal}: sending SIGKILL`);
        child?.kill('SIGKILL');
      }, policy.stopGraceMs);
    });

    launch();
  });
}

/**
 * The agent gets its own process group, so a terminal Ctrl-C reaches it only through the supervisor. Otherwise it
 * would receive SIGINT twice and the second one would interrupt its graceful shutdown.
 */
export function spawnAgentChild(spec: SpawnSpec): ChildHandle {
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: process.env, stdio: 'inherit', detached: process.platform !== 'win32' });
  return {
    pid: child.pid,
    kill: (signal) => void child.kill(signal),
    onExit: (cb) => {
      let reported = false;
      const report = (code: number | null, signal: NodeJS.Signals | null) => {
        if (reported) return;
        reported = true;
        cb(code, signal);
      };
      child.once('exit', report);
      child.once('error', () => report(1, null));
    },
  };
}

function onProcessStopSignals(handler: (signal: StopSignal) => void): () => void {
  const signals: StopSignal[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const listeners = signals.map((signal) => {
    const listener = () => handler(signal);
    process.on(signal, listener);
    return { signal, listener };
  });
  return () => listeners.forEach(({ signal, listener }) => process.off(signal, listener));
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const spec = directAgentSpawnSpec();
  let current: ChildHandle | null = null;
  // If the supervisor itself goes down unexpectedly, do not leave an unsupervised agent holding workflow leases.
  process.on('exit', () => current?.kill('SIGKILL'));
  runSupervisor({
    spawnChild: () => {
      const child = spawnAgentChild(spec);
      current = child;
      child.onExit(() => {
        if (current === child) current = null;
      });
      return child;
    },
    log: (message) => console.log(`${new Date().toISOString().slice(11, 23)} supervise: ${message}`),
    onStopSignal: onProcessStopSignals,
  }).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`supervise: fatal ${e instanceof Error ? e.name : 'error'}`);
      process.exit(1);
    },
  );
}
