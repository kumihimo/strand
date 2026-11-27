import { existsSync, statSync } from 'node:fs';
import { spawn as spawnPlain } from 'node:child_process';
import spawn from 'cross-spawn';

export interface RunOptions {
  cwd?: string;
  input?: string;
  env?: Record<string, string>;
  /** Kill the child and reject with `<cmd> did not answer within <s> s` when it runs longer than this. */
  timeoutMs?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class ToolMissingError extends Error {
  tool: string;
  hint: string;
  constructor(tool: string, hint: string, message?: string) {
    super(message ?? `${tool} not found. ${hint}`);
    this.name = 'ToolMissingError';
    this.tool = tool;
    this.hint = hint;
  }
}

/**
 * Kill a process and everything it started. Does not wait for the kill to finish.
 * Returns the pending SIGKILL timer on POSIX so the caller can cancel it once the child has closed.
 */
function killTree(pid: number | undefined, fallback: () => void): NodeJS.Timeout | undefined {
  if (pid === undefined) {
    fallback();
    return undefined;
  }
  if (process.platform === 'win32') {
    try {
      // Spawned directly, not through run(): run() would wait for the result and could itself time out.
      const killer = spawnPlain('taskkill', ['/pid', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.on('error', fallback);
      killer.unref();
    } catch {
      fallback();
    }
    return undefined;
  }
  // The child leads its own process group (see run()), so a negative pid signals the whole tree.
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      // ESRCH: the group is already gone
    }
  };
  signalGroup('SIGTERM');
  const timer = setTimeout(() => signalGroup('SIGKILL'), 500);
  timer.unref();
  return timer;
}

/**
 * Run an executable without a shell. Resolves on any exit code; rejects when the command cannot be spawned
 * or, with `timeoutMs`, when it does not exit in time (the child and its own children are killed).
 * On POSIX the child gets its own process group so the whole tree can be signalled. stdio is piped and nothing is
 * interactive, so losing terminal Ctrl-C delivery to the child is fine.
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.cwd !== undefined && !(existsSync(opts.cwd) && statSync(opts.cwd).isDirectory())) {
      reject(new Error(`working directory not found: ${opts.cwd}`));
      return;
    }
    const child = spawn(cmd, args, {
      shell: false,
      windowsHide: true,
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            killTimer = killTree(child.pid, () => child.kill());
            settle(() => reject(new Error(`${cmd} did not answer within ${opts.timeoutMs! / 1000} s`)));
          }, opts.timeoutMs)
        : undefined;
    child.stdout!.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr!.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (err: NodeJS.ErrnoException) => {
      settle(() => {
        if (err.code === 'ENOENT') {
          reject(new ToolMissingError(cmd, `Install ${cmd} and make sure it is on PATH`));
        } else {
          reject(err);
        }
      });
    });
    child.on('close', (code) => {
      if (killTimer) clearTimeout(killTimer);
      settle(() => resolve({ code: code ?? 1, stdout, stderr }));
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(opts.input ?? '');
  });
}
