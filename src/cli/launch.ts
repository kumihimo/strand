import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { constants } from 'node:os';
import spawn from 'cross-spawn';
import { ToolMissingError } from '../core/exec.ts';

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

/**
 * Run an interactive child in the foreground with inherited stdio and resolve with its exit code.
 * The terminal sends Ctrl+C (SIGINT) and Ctrl+\ (SIGQUIT) to the whole foreground group, so the
 * parent ignores them while the child runs and lets the child decide; SIGTERM/SIGHUP sent to the
 * parent alone are forwarded. Handlers are removed when the child exits or fails to start.
 */
export function launchInteractive(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  spawnFn: SpawnFn = spawn as unknown as SpawnFn,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawnFn(cmd, args, { cwd, env, stdio: 'inherit', shell: false });
    const ignore = () => {};
    const forward = (sig: NodeJS.Signals) => {
      child.kill(sig);
    };
    const handlers: [NodeJS.Signals, (sig: NodeJS.Signals) => void][] = [
      ['SIGINT', ignore],
      ['SIGTERM', forward],
    ];
    if (process.platform !== 'win32') handlers.push(['SIGQUIT', ignore], ['SIGHUP', forward]);
    for (const [sig, h] of handlers) process.on(sig, h);
    let done = false;
    const cleanup = () => {
      if (done) return false;
      done = true;
      for (const [sig, h] of handlers) process.off(sig, h);
      return true;
    };
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (!cleanup()) return;
      reject(e.code === 'ENOENT' ? new ToolMissingError(cmd, `Install ${cmd} and make sure it is on PATH`) : e);
    });
    child.on('close', (code, signal) => {
      if (!cleanup()) return;
      resolve(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1));
    });
  });
}

