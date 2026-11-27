import { parseArgs } from 'node:util';
import type { Ctx } from '../ctx.ts';
import { acceptCriteria } from '../../core/approve.ts';

/** `strand criteria accept <id>`: the engineer accepted changed criteria; write a new baseline. */
export async function main(args: string[], ctx: Ctx): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const [sub, id] = positionals;
  if (sub !== 'accept' || !id || positionals.length > 2) throw new Error('usage: strand criteria accept <bead-id>');
  await acceptCriteria(ctx, id);
  ctx.out(`criteria accepted for ${id}`);
  return 0;
}
