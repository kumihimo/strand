import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './exec.ts';

export type Dependency = {
  id: string;
  issue_type: string;
  status: string;
  description?: string;
  dependency_type: 'blocks' | 'parent-child' | 'related' | 'discovered-from' | string;
};

export type Bead = {
  id: string;
  title: string;
  status: 'open' | 'in_progress' | 'blocked' | 'deferred' | 'closed' | string;
  priority: number;
  issue_type: string;
  labels: string[];
  design?: string;
  notes?: string;
  acceptance_criteria?: string;
  description?: string;
  assignee?: string;
  parent?: string;
  /** Second precision (`2026-11-23T04:28:53Z`) in bd 1.2.2, the same in `show` and `list`. Moves on every write. */
  updated_at?: string;
  dependencies: Dependency[];
};

export type Comment = { id: string; author: string; text: string; created_at: string };

/** One row of `bd list --all --json` (bd 1.2.2): every non-gate issue with labels, design, notes and raw dependencies. */
export type ListedBead = {
  id: string;
  title: string;
  status: string;
  priority: number;
  issue_type: string;
  parent?: string;
  labels: string[];
  design?: string;
  notes?: string;
  acceptance_criteria?: string;
  description?: string;
  assignee?: string;
  updated_at?: string;
  dependencies: { issue_id: string; depends_on_id: string; type: string }[];
};

function normalise(raw: Record<string, unknown>): Bead {
  const b = raw as Partial<Bead> & Record<string, unknown>;
  return { ...(b as Bead), labels: b.labels ?? [], dependencies: b.dependencies ?? [] };
}

/** Extract the first JSON value from mixed stdout (bd may print warnings or tips around it). */
function extractJson(stdout: string): unknown {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    // fall through to scanning
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;
    // try progressively from each closing bracket of the same family, longest first
    const close = ch === '{' ? '}' : ']';
    for (let j = text.lastIndexOf(close); j > i; j = text.lastIndexOf(close, j - 1)) {
      try {
        return JSON.parse(text.slice(i, j + 1));
      } catch {
        // keep shrinking
      }
    }
  }
  throw new SyntaxError('no JSON value found');
}

/** bd ran and exited non-zero; `stderr` is what it printed. */
export class BdError extends Error {
  stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.name = 'BdError';
    this.stderr = stderr;
  }
  /** bd's own one-line reason (e.g. `Error: parent issue x-1 not found`). */
  get firstStderrLine(): string {
    return this.stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? this.message;
  }
}

/** How long one bd call may take before it is killed and reported as not answering. */
export const BD_TIMEOUT_MS = 20_000;

export class Beads {
  trackerDir: string;
  timeoutMs: number;

  constructor(trackerDir: string, opts: { timeoutMs?: number } = {}) {
    this.trackerDir = trackerDir;
    this.timeoutMs = opts.timeoutMs ?? BD_TIMEOUT_MS;
  }

  private async exec(args: string[], input?: string): Promise<string> {
    const r = await run('bd', args, { cwd: this.trackerDir, input, env: { BD_NON_INTERACTIVE: '1', BEADS_DIR: join(this.trackerDir, '.beads') }, timeoutMs: this.timeoutMs });
    if (r.code !== 0) {
      throw new BdError(`bd ${args.join(' ')} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`, r.stderr);
    }
    return r.stdout;
  }

  private async json(args: string[], input?: string): Promise<unknown> {
    const full = [...args, '--json'];
    const out = await this.exec(full, input);
    try {
      return extractJson(out);
    } catch {
      throw new Error(`bd ${full.join(' ')}: could not parse JSON output: ${out.trim().slice(0, 300)}`);
    }
  }

  /** Write every issue (labels, dependencies, comments included) to `file`, one JSON line each. Throws when bd fails. */
  async exportAll(file: string): Promise<void> {
    await this.exec(['export', '--all', '-o', file]);
  }

  async show(id: string): Promise<Bead> {
    const v = await this.json(['show', id]);
    const obj = Array.isArray(v) ? v[0] : v;
    if (!obj) throw new Error(`bd show ${id}: bead not found`);
    return normalise(obj as Record<string, unknown>);
  }

  async list(): Promise<Bead[]> {
    return ((await this.json(['list', '--limit', '0'])) as Record<string, unknown>[]).map(normalise);
  }

  /** Every non-gate issue, closed included, in one call (the cockpit's per-refresh read). */
  async listAll(): Promise<ListedBead[]> {
    const v = (await this.json(['list', '--all', '--limit', '0'])) as Record<string, unknown>[] | null;
    return (v ?? []).map((raw) => {
      const b = raw as Partial<ListedBead>;
      return {
        ...(b as ListedBead),
        labels: b.labels ?? [],
        design: b.design ?? undefined,
        notes: b.notes ?? undefined,
        dependencies: b.dependencies ?? [],
      };
    });
  }

  async ready(): Promise<Bead[]> {
    return ((await this.json(['ready', '--limit', '0'])) as Record<string, unknown>[]).map(normalise);
  }

  async create(i: {
    title: string;
    type: string;
    priority?: number;
    labels?: string[];
    parent?: string;
    description?: string;
    acceptance?: string;
  }): Promise<Bead> {
    // `--flag=value` keeps text that starts with `-` (every criterion does) from being read as a flag.
    const args = ['create', `--title=${i.title}`, '-t', i.type];
    if (i.description) args.push(`--description=${i.description}`);
    if (i.acceptance) args.push(`--acceptance=${i.acceptance}`);
    if (i.priority !== undefined) args.push('-p', String(i.priority));
    if (i.labels?.length) args.push('--labels', i.labels.join(','));
    if (i.parent) args.push('--parent', i.parent);
    const v = await this.json(args);
    return normalise((Array.isArray(v) ? v[0] : v) as Record<string, unknown>);
  }

  async claim(id: string): Promise<void> {
    await this.exec(['update', id, '--status', 'in_progress']);
  }

  /** Set the status with one `bd update`. `--status=value` keeps the value from being read as a flag. */
  async setStatus(id: string, status: string): Promise<void> {
    await this.exec(['update', id, `--status=${status}`]);
  }

  async setDesign(id: string, text: string): Promise<void> {
    await this.exec(['update', id, '--design', text]);
  }

  async setAcceptance(id: string, text: string): Promise<void> {
    await this.exec(['update', id, `--acceptance=${text}`]);
  }

  /** One `bd update` with only the given fields. `--flag=value` keeps text that starts with `-` from being read as a flag. */
  async update(
    id: string,
    f: {
      title?: string;
      description?: string;
      acceptance?: string;
      design?: string;
      type?: string;
      priority?: number;
      parent?: string;
      addLabels?: string[];
      removeLabels?: string[];
    },
  ): Promise<void> {
    const args = ['update', id];
    // Labels change in the same call as the fields, so a repo change is one write.
    for (const l of f.removeLabels ?? []) args.push(`--remove-label=${l}`);
    for (const l of f.addLabels ?? []) args.push(`--add-label=${l}`);
    if (f.title !== undefined) args.push(`--title=${f.title}`);
    if (f.description !== undefined) args.push(`--description=${f.description}`);
    if (f.acceptance !== undefined) args.push(`--acceptance=${f.acceptance}`);
    if (f.design !== undefined) args.push(`--design=${f.design}`);
    if (f.type !== undefined) args.push(`--type=${f.type}`);
    if (f.priority !== undefined) args.push(`--priority=${f.priority}`);
    if (f.parent !== undefined) args.push(`--parent=${f.parent}`);
    if (args.length === 2) return;
    await this.exec(args);
  }

  async addLabel(id: string, label: string): Promise<void> {
    await this.exec(['update', id, `--add-label=${label}`]);
  }

  async removeLabel(id: string, label: string): Promise<void> {
    await this.exec(['update', id, `--remove-label=${label}`]);
  }

  /** `id` depends on `dependsOn`. */
  async addDep(id: string, dependsOn: string): Promise<void> {
    await this.exec(['dep', 'add', id, dependsOn]);
  }

  async note(id: string, text: string): Promise<void> {
    await this.exec(['note', id, '--stdin'], text);
  }

  async comment(id: string, text: string): Promise<void> {
    // bd treats leading-dash positional text as flags and has no stdin mode for comments, so pass a temp file.
    const tmp = await mkdtemp(join(tmpdir(), 'strand-bd-'));
    try {
      const file = join(tmp, 'comment.txt');
      await writeFile(file, text, 'utf8');
      await this.exec(['comments', 'add', id, '-f', file]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  async comments(id: string): Promise<Comment[]> {
    return (await this.json(['comments', id])) as Comment[];
  }

  /** `session` is the Claude Code session that closed the bead, recorded by bd. */
  async close(id: string, reason: string, session?: string): Promise<void> {
    await this.exec(['close', id, '--reason', reason, ...(session ? ['--session', session] : [])]);
  }
}
