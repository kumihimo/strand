import type { Ctx } from '../ctx.ts';

/** Needs no config, no bd and no session id: the PostToolUse hook sees the command and binds the session to no bead. */
export const needsCtx = false;

/** `strand none`: the user said this work needs no bead. */
export async function main(_args: string[], ctx: Pick<Ctx, 'out'>): Promise<number> {
  ctx.out('No bead for this session.');
  return 0;
}
