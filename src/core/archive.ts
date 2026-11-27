import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { homeDir } from './config.ts';
import { run } from './exec.ts';
import { assertSafeSegment, pendingArchives, writeEntry } from './sessions.ts';
import type { SessionEntry } from './sessions.ts';
import type { ArtefactsVcs } from './config.ts';

const gzipAsync = promisify(gzip);

export type ArchiveOptions = {
  vcs: ArtefactsVcs;
  /** Adds a bead comment; best effort (a failure is logged, never fatal). */
  comment?: (beadId: string, text: string) => Promise<void>;
};

async function git(cwd: string, args: string[]): Promise<void> {
  const r = await run('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
}

/**
 * Where Claude Code keeps a session's transcript: `<config dir>/projects/<encoded cwd>/<session id>.jsonl`.
 * The config dir is `CLAUDE_CONFIG_DIR` (absolute only), else `<home>/.claude`. The encoding of the cwd is
 * Claude Code's own and is not copied here: each project folder is looked in, one level deep. Undefined when
 * no file is found.
 */
export function findTranscript(env: NodeJS.ProcessEnv, sessionId: string, platform: NodeJS.Platform = process.platform): string | undefined {
  try {
    assertSafeSegment(sessionId, 'session id');
    const set = env.CLAUDE_CONFIG_DIR;
    if (set && !isAbsolute(set)) return undefined;
    const projects = join(set || join(homeDir(env, platform), '.claude'), 'projects');
    for (const d of readdirSync(projects, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const file = join(projects, d.name, `${sessionId}.jsonl`);
      if (existsSync(file)) return file;
    }
  } catch {
    // No projects folder, or an unsafe id: nothing to find.
  }
  return undefined;
}

/**
 * Gzip one ended session's transcript into the tracker, commit it when the artefacts are under git, and
 * comment `session <id> archived` on the bead. Returns '' when there is nothing to archive.
 */
export async function archiveTranscript(trackerDir: string, e: SessionEntry, opts: ArchiveOptions): Promise<string> {
  assertSafeSegment(e.beadId, 'bead id');
  assertSafeSegment(e.sessionId, 'session id');
  if (!e.transcriptPath) return '';
  // Async reads, gzip and writes: the cockpit runs this on its server's event loop.
  let raw: Buffer;
  try {
    raw = await readFile(e.transcriptPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
  const target = join(trackerDir, 'artefacts', e.beadId, 'sessions', `${e.sessionId}.jsonl.gz`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await gzipAsync(raw));
  if (opts.vcs !== 'none') {
    const rel = relative(trackerDir, target).replace(/\\/g, '/');
    await git(trackerDir, ['add', '--', rel]);
    const staged = await run('git', ['diff', '--cached', '--quiet', '--', rel], { cwd: trackerDir });
    if (staged.code === 1) {
      await git(trackerDir, ['commit', '-m', `${e.beadId}: archive session ${e.sessionId}`, '--', rel]);
    } else if (staged.code !== 0) {
      throw new Error(`git diff --cached failed: ${staged.stderr.trim()}`);
    }
  }
  writeEntry(trackerDir, { ...e, archived: true });
  if (opts.comment) {
    try {
      await opts.comment(e.beadId, `session ${e.sessionId} archived`);
    } catch (err) {
      console.error(`strand: comment on ${e.beadId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return target;
}

/** Archive every ended, unarchived session; failures are skipped so one bad entry never blocks the rest. */
export async function archivePending(trackerDir: string, opts: ArchiveOptions): Promise<string[]> {
  const done: string[] = [];
  for (const e of pendingArchives(trackerDir)) {
    try {
      const p = await archiveTranscript(trackerDir, e, opts);
      if (p) done.push(p);
    } catch (err) {
      console.error(`strand: archive ${e.sessionId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return done;
}
