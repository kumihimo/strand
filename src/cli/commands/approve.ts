import { parseArgs } from 'node:util';
import type { Ctx } from '../ctx.ts';
import { approveSpec } from '../../core/approve.ts';

/** `strand approve <id>`: approve the spec. Engineer-only; the gate hook refuses it from Claude. */
export async function main(args: string[], ctx: Ctx): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const id = positionals[0];
  if (!id || positionals.length > 1) throw new Error('usage: strand approve <bead-id>');
  const r = await approveSpec(ctx, id, { by: 'cli' });
  ctx.out(`approved ${id}`);
  if (r.warn) ctx.out(`warning: ${r.warn}`);
  return 0;
}
