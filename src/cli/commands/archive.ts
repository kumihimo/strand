import { parseArgs } from 'node:util';
import { archivePending } from '../../core/archive.ts';
import type { Ctx } from '../ctx.ts';

/** `strand archive`: archive every ended, unarchived session transcript into the tracker. */
export async function main(args: string[], ctx: Ctx): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } });
  const archived = await archivePending(ctx.config.trackerDir, {
    vcs: ctx.config.artefactsVcs,
    comment: (id, text) => ctx.beads.comment(id, text),
  });
  if (values.json) ctx.out(JSON.stringify({ archived }));
  else if (archived.length === 0) ctx.out('nothing to archive');
  else for (const p of archived) ctx.out(p);
  return 0;
}
