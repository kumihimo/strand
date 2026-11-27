#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyLegacyEnv } from '../core/config.ts';
import { ToolMissingError } from '../core/exec.ts';
import { buildCtx, type Ctx } from './ctx.ts';

type Command = (args: string[], ctx: Ctx) => Promise<number>;

/** A command with `needsCtx = false` runs without loading the config, bd or the keychain. */
const COMMANDS: Record<string, () => Promise<{ main: Command; needsCtx?: boolean }>> = {
  new: () => import('./commands/new.ts'),
  work: () => import('./commands/work.ts'),
  approve: () => import('./commands/approve.ts'),
  criteria: () => import('./commands/criteria.ts'),
  pr: () => import('./commands/pr.ts'),
  none: () => import('./commands/none.ts'),
  audit: () => import('./commands/audit.ts'),
  keep: () => import('./commands/keep.ts'),
  brief: () => import('./commands/brief.ts'),
  archive: () => import('./commands/archive.ts'),
  cockpit: () => import('./commands/cockpit.ts'),
  migrate: () => import('./commands/migrate.ts'),
  'migrate-prefix': () => import('./commands/migrate-prefix.ts'),
};

const USAGE = `usage: strand <command> [options]

  new "<title>" --type <t> [--priority n] [--repo <name>] [--context <folder>]... [--parent <id>]
      [--description <text>] [--acceptance <text>] [--description-file <path>] [--acceptance-file <path>] [--json]
      A title, a type and a parent epic are enough. Description and criteria are optional free text,
      checked at approval. Suggested forms: "As <role>, I want ..., so that ..."
      and one line per criterion: "- [ ] <text> (check: <command>)".
  work <bead-id> [--specify] [--resume <session-id> | --session-id <session-id>] [--format <spec-format>] [--json]
  approve <bead-id>
  criteria accept <bead-id>
  pr <bead-id> --title <title> (--body <text> | --body-file <file>) [--base <branch>] [--json]
  none
  audit [<repo>]
  keep <bead-id> <scratch-file>
  brief [--json]
  archive [--json]
  cockpit [--port n] [--no-open] [--window app|tab|none]
  migrate [--apply] [--json]
  migrate-prefix <old> <new> [--apply] [--json]
      After bd rename-prefix: move the artefacts folders and rewrite the sessions, bindings and handovers
      that still name an old id. Dry run unless --apply.`;

/** The one-line message printed after `error: `. A missing tool reads `<message> — <hint>`, with the hint once. */
export function errorMessage(e: unknown): string {
  if (e instanceof ToolMissingError) {
    const base = e.message.endsWith(e.hint) ? e.message.slice(0, -e.hint.length).replace(/[\s.]+$/, '') : e.message;
    return `${base} — ${e.hint}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Dispatch one command; every failure becomes a single `error: …` line and exit code 1. */
export async function runCli(argv: string[], ctx?: Ctx): Promise<number> {
  const [name, ...rest] = argv;
  const err = ctx?.err ?? ((s: string) => process.stderr.write(s + '\n'));
  try {
    if (name === undefined) throw new Error('missing command (run strand help)');
    if (name === 'help' || name === '--help' || name === '-h') {
      (ctx?.out ?? ((s: string) => process.stdout.write(s + '\n')))(USAGE);
      return 0;
    }
    const load = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
    if (!load) throw new Error(`unknown command ${name}`);
    const mod = await load();
    const out = (s: string) => void process.stdout.write(s + '\n');
    return await mod.main(rest, ctx ?? (mod.needsCtx === false ? ({ out, err } as Ctx) : buildCtx()));
  } catch (e) {
    err(`error: ${errorMessage(e).split(/\r?\n/)[0]}`);
    return 1;
  }
}

function isEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  // SDLC_* still works for one release (ADR 0021); child processes see the STRAND_* names too.
  applyLegacyEnv(process.env);
  process.exitCode = await runCli(process.argv.slice(2));
}
