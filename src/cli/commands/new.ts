import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { repoNameIn } from '../../core/folders.ts';
import { createBead } from '../../core/create-bead.ts';
import type { Ctx } from '../ctx.ts';

/** Text from the flag or from a file (resolved against the current folder), not both. */
function textOf(name: string, inline: string | undefined, file: string | undefined): string | undefined {
  if (inline !== undefined && file !== undefined) throw new Error(`pass --${name} or --${name}-file, not both`);
  if (file === undefined) return inline;
  try {
    return readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trimEnd();
  } catch {
    throw new Error(`cannot read --${name}-file ${file}`);
  }
}

/** parseArgs refuses a value that starts with `-`, and every criteria list does. Join those two flags to their value. */
function joinDashValues(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if ((a === '--description' || a === '--acceptance') && i + 1 < args.length) out.push(`${a}=${args[++i]}`);
    else out.push(a);
  }
  return out;
}

export async function main(args: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parseArgs({
    args: joinDashValues(args),
    allowPositionals: true,
    options: {
      type: { type: 'string' },
      priority: { type: 'string', default: '2' },
      repo: { type: 'string' },
      context: { type: 'string', multiple: true },
      parent: { type: 'string' },
      description: { type: 'string' },
      acceptance: { type: 'string' },
      'description-file': { type: 'string' },
      'acceptance-file': { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const title = positionals[0];
  if (!title?.trim() || positionals.length > 1) throw new Error('usage: strand new "<title>" --type <t>');
  if (!values.type) throw new Error('--type is required');
  const description = textOf('description', values.description, values['description-file']);
  const acceptance = textOf('acceptance', values.acceptance, values['acceptance-file']);
  // Default: the repo folder this is run from, when that folder sits directly in the workspace root.
  const repo = values.repo ?? repoNameIn(ctx.config.workspaceRoot, ctx.cwd);
  const bead = await createBead(ctx, { title, type: values.type, priority: values.priority, repo, context: values.context, parent: values.parent, description, acceptance });
  if (values.json) {
    const { id, title: t, issue_type, priority: p, labels } = bead;
    ctx.out(JSON.stringify({ id, title: t, type: issue_type, priority: p, labels }));
  } else {
    ctx.out(bead.id);
  }
  return 0;
}
