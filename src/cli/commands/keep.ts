import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { run } from '../../core/exec.ts';
import { assertSafeSegment } from '../../core/sessions.ts';
import type { Ctx } from '../ctx.ts';

async function git(cwd: string, args: string[]): Promise<void> {
  const r = await run('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || r.stdout.trim()}`);
}

/** `strand keep <id> <file>`: promote a scratch artefact to a kept one (committed when artefacts are under git). */
export async function main(args: string[], ctx: Ctx): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const [id, file] = positionals;
  if (!id || !file || positionals.length > 2) throw new Error('usage: strand keep <bead-id> <scratch-file>');
  assertSafeSegment(id, 'bead id');
  assertSafeSegment(file, 'scratch file name');

  await ctx.beads.show(id);
  const tracker = ctx.config.trackerDir;
  const from = join(tracker, 'artefacts', id, 'scratch', file);
  if (!existsSync(from) || !statSync(from).isFile()) throw new Error('no such scratch file');
  const to = join(tracker, 'artefacts', id, file);
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);

  if (ctx.config.artefactsVcs !== 'none') {
    const rel = relative(tracker, to).replace(/\\/g, '/');
    await git(tracker, ['add', '--', rel]);
    await git(tracker, ['commit', '-q', '-m', `${id}: keep ${file}`, '--', rel]);
  }
  await ctx.beads.note(id, `kept ${file}`);
  ctx.out(to);
  return 0;
}
