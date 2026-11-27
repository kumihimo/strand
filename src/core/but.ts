import { run } from './exec.ts';

export type ButBranch = { name: string; commits: { commitId: string; message: string }[] };

async function exec(repoDir: string, args: string[], timeoutMs?: number): Promise<string> {
  const r = await run('but', args, { cwd: repoDir, env: { BUT_PAGER: 'cat', NO_COLOR: '1' }, timeoutMs });
  if (r.code !== 0) {
    throw new Error(`but ${args.join(' ')} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout;
}

/** Parse the JSON object in stdout, tolerating notice lines around it. */
function extractJson(stdout: string): any {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    // fall through
  }
  const start = text.indexOf('{');
  for (let j = text.lastIndexOf('}'); start >= 0 && j > start; j = text.lastIndexOf('}', j - 1)) {
    try {
      return JSON.parse(text.slice(start, j + 1));
    } catch {
      // keep shrinking
    }
  }
  throw new SyntaxError('no JSON found in but output');
}

export async function butStatus(repoDir: string): Promise<{ branches: ButBranch[]; uncommitted: string[] }> {
  const data = extractJson(await exec(repoDir, ['--json', 'status']));
  const branches: ButBranch[] = [];
  for (const stack of data.stacks ?? []) {
    for (const b of stack.branches ?? []) {
      branches.push({
        name: b.name,
        commits: (b.commits ?? []).map((c: any) => ({ commitId: c.commitId, message: String(c.message ?? '').trim() })),
      });
    }
  }
  const uncommitted: string[] = (data.uncommittedChanges ?? []).map((u: any) => u.filePath);
  return { branches, uncommitted };
}

export async function butCommit(repoDir: string, o: { branch: string; message: string; files: string[] }): Promise<void> {
  if (o.files.length === 0) throw new Error('butCommit requires a non-empty files list');
  // --message=<msg> keeps a leading '-' from being read as a flag; '--' guards file names.
  await exec(repoDir, ['commit', '-b', o.branch, `--message=${o.message}`, '--', ...o.files]);
}

export async function butPush(repoDir: string, branch: string): Promise<void> {
  await exec(repoDir, ['push', branch]);
}

/** Every applied stack's branches, top first, from `but branch list --json` output. Stacks count from 1. */
export function parseStackHeads(stdout: string): { stack: number; name: string }[] {
  const data = extractJson(stdout);
  const out: { stack: number; name: string }[] = [];
  const stacks: unknown[] = Array.isArray(data?.appliedStacks) ? data.appliedStacks : [];
  stacks.forEach((stack: any, i) => {
    for (const h of Array.isArray(stack?.heads) ? stack.heads : []) {
      if (typeof h?.name === 'string' && h.name) out.push({ stack: i + 1, name: h.name });
    }
  });
  return out;
}

/** The applied stacks of the GitButler project in repoDir. Throws when but fails (not a GitButler project, say). */
export async function butStackHeads(repoDir: string, opts: { timeoutMs?: number } = {}): Promise<{ stack: number; name: string }[]> {
  return parseStackHeads(await exec(repoDir, ['branch', 'list', '--json'], opts.timeoutMs));
}
