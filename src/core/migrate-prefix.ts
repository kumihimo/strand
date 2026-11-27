// Moves the files keyed by a bead id outside the database after `bd rename-prefix` (which renames ids in the database only).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { retryRename, writeAtomic } from './binding.ts';
import { LEGACY_STATE_DIR, STATE_DIR, stateDir, stateEntries } from './state.ts';

export type PrefixItemKind = 'artefacts' | 'session' | 'binding' | 'handover';

/** One id that changes in an item: a JSON field, or `folder` for an artefacts folder's name. */
export type IdChange = { field: string; from: string; to: string };

/** One folder to rename or one file to rewrite. `path` is relative to the tracker. */
export type PrefixItem = { kind: PrefixItemKind; path: string; ids: IdChange[] };

/** An artefacts folder that cannot move because its new name is taken. Left alone. */
export type PrefixConflict = { path: string; target: string };

export type PrefixPlan = { from: string; to: string; items: PrefixItem[]; conflicts: PrefixConflict[] };

const PREFIX = /^[A-Za-z0-9](?:[A-Za-z0-9_.]|-(?!-))*$/;

/** A bead id prefix without its trailing `-`. Throws on anything that is not a plain prefix. */
export function normalisePrefix(p: string): string {
  const bare = typeof p === 'string' && p.endsWith('-') ? p.slice(0, -1) : p;
  if (typeof bare !== 'string' || !PREFIX.test(bare) || bare.includes('..') || bare.endsWith('-')) {
    throw new Error(`invalid prefix: ${JSON.stringify(p)}`);
  }
  return bare;
}

/** The id with `from` swapped for `to`, or undefined when the id does not start with `<from>-`. */
function renamed(id: unknown, from: string, to: string): string | undefined {
  if (typeof id !== 'string' || !id.startsWith(`${from}-`) || id.length === from.length + 1) return undefined;
  return `${to}${id.slice(from.length)}`;
}

function readObject(file: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The changes of the named string fields of a JSON object file. */
function fieldChanges(file: string, fields: string[], from: string, to: string): IdChange[] {
  const obj = readObject(file);
  if (!obj) return [];
  const out: IdChange[] = [];
  for (const field of fields) {
    const next = renamed(obj[field], from, to);
    if (next !== undefined) out.push({ field, from: obj[field] as string, to: next });
  }
  return out;
}

/**
 * What a rename from prefix `oldPrefix` to `newPrefix` moves in the tracker. Reads only. A legacy-folder item hidden by
 * the same name in `.strand/` is skipped, as every reader skips it. Malformed files are skipped.
 */
export function planPrefixMigration(trackerDir: string, oldPrefix: string, newPrefix: string): PrefixPlan {
  const from = normalisePrefix(oldPrefix);
  const to = normalisePrefix(newPrefix);
  if (from === to) throw new Error(`the old and new prefix are the same: ${from}`);
  // Every rerun would rename `<from>-<from-rest>` again.
  if (to.startsWith(`${from}-`)) throw new Error(`the new prefix ${to} starts with ${from}-, so a rerun would rename it again`);
  const plan: PrefixPlan = { from, to, items: [], conflicts: [] };

  const artefacts = path.join(trackerDir, 'artefacts');
  if (existsSync(artefacts)) {
    const names = readdirSync(artefacts, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const name of names) {
      const next = renamed(name, from, to);
      if (next === undefined) continue;
      const rel = path.join('artefacts', name);
      const target = path.join('artefacts', next);
      if (existsSync(path.join(trackerDir, target))) plan.conflicts.push({ path: rel, target });
      else plan.items.push({ kind: 'artefacts', path: rel, ids: [{ field: 'folder', from: name, to: next }] });
    }
  }

  const state = (sub: string, kindOf: (name: string) => PrefixItemKind | undefined, fields: string[]) => {
    for (const { name, path: file } of stateEntries(trackerDir, sub)) {
      if (!name.endsWith('.json')) continue;
      const kind = kindOf(name);
      if (!kind) continue;
      const ids = fieldChanges(file, fields, from, to);
      if (ids.length > 0) plan.items.push({ kind, path: path.relative(trackerDir, file), ids });
    }
  };
  state('sessions', () => 'session', ['beadId']);
  state('bindings', (n) => (n.startsWith('handover-') ? 'handover' : 'binding'), ['bead', 'epic']);
  return plan;
}

/** Thrown when applying stops part way. Every item before `applied` is done; a rerun plans what is left. */
export class PrefixMigrationError extends Error {
  readonly applied: number;
  constructor(message: string, applied: number) {
    super(message);
    this.applied = applied;
  }
}

/** Where a planned state file is written: always under `.strand/`, and whether it was read from the legacy folder. */
function stateTarget(trackerDir: string, rel: string): { file: string; legacy: boolean } {
  const [top, sub, name, ...rest] = rel.split(path.sep);
  if ((top !== STATE_DIR && top !== LEGACY_STATE_DIR) || !sub || !name || rest.length > 0) {
    throw new Error(`not a state file: ${rel}`);
  }
  return { file: path.join(stateDir(trackerDir, sub), name), legacy: top === LEGACY_STATE_DIR };
}

/** Apply a plan from `planPrefixMigration`. Conflicts are left alone. Each write is atomic. */
export function applyPrefixMigration(trackerDir: string, plan: PrefixPlan): { applied: number } {
  let applied = 0;
  for (const item of plan.items) {
    try {
      const source = path.join(trackerDir, item.path);
      if (item.kind === 'artefacts') {
        const target = path.join(trackerDir, 'artefacts', item.ids[0].to);
        if (existsSync(target)) throw new Error(`${target} already exists`);
        retryRename(source, target);
      } else {
        const obj = readObject(source);
        if (!obj) throw new Error(`${source} is no longer readable`);
        for (const c of item.ids) {
          if (obj[c.field] !== c.from) throw new Error(`${source} changed since it was planned`);
          obj[c.field] = c.to;
        }
        const { file, legacy } = stateTarget(trackerDir, item.path);
        mkdirSync(path.dirname(file), { recursive: true });
        writeAtomic(file, JSON.stringify(obj, null, 2) + '\n');
        if (legacy) rmSync(source, { force: true });
      }
      applied++;
    } catch (e) {
      throw new PrefixMigrationError(e instanceof Error ? e.message : String(e), applied);
    }
  }
  return { applied };
}
