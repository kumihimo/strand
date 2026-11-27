import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { auditReport } from '../../core/audit.ts';
import { loadSnapshot } from '../../core/snapshot.ts';
import type { Ctx } from '../ctx.ts';

/** `strand audit [<repo>]`: every applied GitButler stack with its beads and chats, and any drift. */
export async function main(args: string[], ctx: Ctx): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals.length > 1) throw new Error('usage: strand audit [<repo>]');
  const repoDir = resolve(ctx.cwd, positionals[0] ?? '.');
  const report = await auditReport(repoDir, await loadSnapshot(ctx.beads), { trackerDir: ctx.config.trackerDir });
  if (report) ctx.out(report);
  return 0;
}
