import { run, ToolMissingError } from './exec.ts';

export { ToolMissingError };

export type ToolName = 'bd' | 'but' | 'git' | 'claude';

/** The oldest version of each tool the system is tested with. */
export const MINIMUM_VERSIONS: Record<ToolName, string> = { git: '2.40.0', bd: '1.2.2', but: '0.23.5', claude: '2.1.296' };

/** Numeric per-component comparison: negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Check that a tool is installed and at least minVersion; returns the found version. */
export async function requireTool(
  name: ToolName,
  minVersion: string,
  opts: { path?: string } = {},
): Promise<string> {
  const exe = opts.path ?? name;
  const hint = `Install ${name} and make sure it is on PATH`;
  let out;
  try {
    out = await run(exe, ['--version']);
  } catch (e) {
    if (e instanceof ToolMissingError) throw new ToolMissingError(name, hint);
    throw e;
  }
  const m = /\d+\.\d+\.\d+/.exec(out.stdout + '\n' + out.stderr);
  if (out.code !== 0 || !m) {
    throw new ToolMissingError(name, hint, `${name} --version failed or printed no version. ${hint}`);
  }
  const found = m[0];
  if (compareVersions(found, minVersion) < 0) {
    throw new ToolMissingError(
      name,
      `Upgrade ${name} to ${minVersion} or newer`,
      `${name} ${found} is older than the required minimum ${minVersion}`,
    );
  }
  return found;
}
