// The one way a test copies the real environment, and the one way a test spawns with an env of its own.
import spawn from 'cross-spawn';

/**
 * Variables that would point a test at real or foreign state whatever the sandbox sets. `STRAND_CONFIG_DIR`
 * wins over `APPDATA` and `XDG_CONFIG_HOME`, so a shell where the demo command set it would send the config
 * and the cockpit key file into the demo folder. `BEADS_DIR` and `BEADS_ACTOR` would point bd at the real
 * tracker. Every pre-rename `SDLC_*` variable goes too: the CLI and hooks read it as its `STRAND_*` twin
 * (ADR 0021), so `SDLC_CONFIG_DIR` or `SDLC_WORKSPACE` from the shell would steer a test, and a session's
 * `SDLC_BEAD_ID` would add a deprecation line to a child's stderr.
 */
const LEAKS = ['STRAND_CONFIG_DIR', 'BEADS_DIR', 'BEADS_ACTOR'];
const LEAK_PREFIX = 'SDLC_';

/** A copy of `process.env` without the variables in LEAKS or with LEAK_PREFIX. Tests spread this, never `process.env` itself. */
export function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    const up = k.toUpperCase();
    if (LEAKS.includes(up) || up.startsWith(LEAK_PREFIX)) delete env[k];
  }
  return env;
}

/**
 * Run a command with exactly `env`, no shell. `run()` in src/core/exec.ts merges its env over `process.env`,
 * so a key a test removed would come back; this does not merge. Build `env` from `baseEnv()`.
 */
export function runWith(
  cmd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false, windowsHide: true, cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
