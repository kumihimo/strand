import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { BD_TIMEOUT_MS, type Bead, type Comment, type ListedBead } from '../core/bd.ts';
import { approvalWip, criteriaChanged } from '../core/approve.ts';
import { contextOf, mergedAsReason, parseCriteria, planApprovedAt, prsOf, repoOf, specProblems, specReady, type Criterion } from '../core/facts.ts';
import { beadVersion } from '../core/edit-bead.ts';
import { pickForge, type Forge } from '../core/forge.ts';
import { createGitea } from '../core/gitea.ts';
import { createGitHub } from '../core/github.ts';
import { beadBranch, isSafeRepoName } from '../core/naming.ts';
import { getGiteaToken } from '../core/secrets.ts';
import { assertSafeSegment, liveSessions, sessionsFor, type SessionEntry } from '../core/sessions.ts';
import { defaultSpecFormat, type SpecFormat } from '../core/spec.ts';
import { deriveStage, isHeld, type Stage, type StageFacts } from '../core/stage.ts';
import { isWorkItem, localFacts, parentOf } from '../core/snapshot.ts';
import { checkBuild, wipCounts, type WipCounts } from '../core/wip.ts';
import { waitingAction, type Brief } from '../cli/commands/brief.ts';
import { originOf } from '../cli/commands/work.ts';
import type { Ctx, Gitea } from '../cli/ctx.ts';

export type BeadCard = {
  id: string;
  title: string;
  type: string;
  priority: number;
  status: string;
  stage: Stage;
  ready: boolean;
  /** Open, non-gate beads this one waits on. */
  blockedBy: string[];
  parent?: string;
  /** The primary repo: the session's folder, where the branch and PR live. */
  repo?: string;
  /** Context folders from the `context:` labels: more folders the session can read. */
  context: string[];
  live: boolean;
  /** A live session of this bead has stopped and waits for the engineer, and the bead is not closed. */
  needsYou: boolean;
  /** Blocked or deferred: keeps its stage, does not count toward WIP. */
  held: boolean;
  /** Stage `specify`, with acceptance text that meets the approval rules (specReady): it waits for your approval. */
  awaitingApproval: boolean;
  /** The bead has a PR and its CI state is unknown (no forge answer). */
  ciUnknown: boolean;
  branch?: string;
  pr?: { owner: string; repo: string; number: number; url?: string };
  /** The bead's `updated_at`, for sorting. */
  updatedAt?: string;
  /** Labels other than `repo:`, `context:`, `branch:` and `pr:`, which the card shows in other fields. */
  labels: string[];
};

export type Relations = {
  parent?: string;
  children: string[];
  blockedBy: string[];
  blocks: string[];
  related: string[];
  discoveredFrom: string[];
  spawned: string[];
};

export type ArtefactFile = {
  name: string;
  /** Path relative to the bead's folder `<trackerDir>/artefacts/<id>/`, with forward slashes (what the artefact and open endpoints take). */
  relPath: string;
  size: number;
  kind: 'html' | 'image' | 'video' | 'pdf' | 'svg' | 'transcript' | 'other';
};

export type ArtefactList = { kept: ArtefactFile[]; scratch: ArtefactFile[]; transcripts: ArtefactFile[] };

export type BeadDetail = BeadCard & {
  design?: string;
  notes?: string;
  labels: string[];
  specFormat: SpecFormat;
  criteria: Criterion[];
  /** What the spec lacks for Approve spec (empty when it can be approved). */
  specProblems: string[];
  /** The bead's `updated_at`: an edit sends it back, and is refused when it no longer matches. */
  version: string;
  /** The raw acceptance text, for the edit form. */
  acceptance?: string;
  /** Not closed. */
  editable: boolean;
  planApprovedAt?: string;
  /** The criteria text no longer matches the approved baseline. */
  criteriaChanged: boolean;
  description?: string;
  /** The WIP limit approval would hit, if any. */
  wipWarning?: string;
  relations: Relations;
  comments: Comment[];
  artefacts: ArtefactList;
  sessions: SessionEntry[];
  command: string;
};

export type Epic = {
  id: string;
  title: string;
  priority: number;
  counts: { closed: number; inProgress: number; ready: number; blocked: number };
  children: BeadCard[];
};

export type Board = {
  cards: BeadCard[];
  wip: { build: number; review: number; limits: { build: number; review: number }; mode: 'warn' | 'refuse' };
};

/** Everything one refresh derives from one `bd list`. */
type Snapshot = {
  at: number;
  beads: Map<string, ListedBead>;
  /** Cards for every non-gate bead, epics included (callers filter), ordered by priority then id. */
  cards: Map<string, BeadCard>;
  children: Map<string, string[]>;
  blocks: Map<string, string[]>;
  related: Map<string, string[]>;
  spawned: Map<string, string[]>;
  live: SessionEntry[];
};

type Origin = { owner: string; repo: string; host?: string };

const DEFAULT_TTL_MS = 15_000;
/** detail() re-reads Beads for an unknown id only when the snapshot is at least this old. */
const UNKNOWN_ID_REREAD_MS = 1_000;
/** At most this many beads look up PR facts at once, so a Gitea outage costs a few parallel timeouts. */
const GITEA_CONCURRENCY = 4;

/** Map items with at most `limit` calls of fn in flight; results keep the input order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Settle with p, or reject with `bd did not answer within <s> s` after ms (covers a Beads that never settles). */
function answerWithin<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`bd did not answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Keep only well-formed list rows' arrays so one odd row cannot break relations. */
function sanitise(b: ListedBead): ListedBead {
  const labels = Array.isArray(b.labels) ? b.labels.filter((l) => typeof l === 'string') : [];
  const dependencies = Array.isArray(b.dependencies)
    ? b.dependencies.filter((d) => d && typeof d.depends_on_id === 'string' && typeof d.type === 'string')
    : [];
  return { ...b, labels, dependencies };
}

function notFound(id: string): Error {
  return Object.assign(new Error(`bead ${id} not found`), { code: 'NOT_FOUND' });
}

function unavailable(e: unknown): Error {
  return new Error(`Beads unavailable: ${e instanceof Error ? e.message : String(e)}`);
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

const byPriority = (a: { priority: number; id: string }, b: { priority: number; id: string }) =>
  a.priority - b.priority || a.id.localeCompare(b.id);

const IMAGE = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
const VIDEO = ['.mp4', '.webm', '.mov'];

export function artefactKind(name: string): ArtefactFile['kind'] {
  const n = name.toLowerCase();
  if (n.endsWith('.jsonl.gz')) return 'transcript';
  const ext = n.includes('.') ? n.slice(n.lastIndexOf('.')) : '';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (IMAGE.includes(ext)) return 'image';
  if (VIDEO.includes(ext)) return 'video';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.svg') return 'svg';
  return 'other';
}

function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Regular files under dir (recursively when deep), as artefact entries with relPath built from `rel` segments. */
function filesIn(dir: string, rel: string[], deep: boolean): ArtefactFile[] {
  const out: ArtefactFile[] = [];
  for (const d of entries(dir)) {
    const full = join(dir, d.name);
    if (d.isFile()) {
      let size = 0;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      out.push({ name: d.name, relPath: [...rel, d.name].join('/'), size, kind: artefactKind(d.name) });
    } else if (deep && d.isDirectory()) {
      out.push(...filesIn(full, [...rel, d.name], true));
    }
  }
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/**
 * Files kept for a bead under `<trackerDir>/artefacts/<id>/`: top-level files, `scratch/` and `sessions/`.
 * Plain filesystem reads only: the artefacts folder need not be a git repo (ADR 0009).
 */
export function listArtefacts(trackerDir: string, id: string): ArtefactList {
  assertSafeSegment(id, 'bead id');
  const root = join(trackerDir, 'artefacts', id);
  return {
    kept: filesIn(root, [], false),
    scratch: filesIn(join(root, 'scratch'), ['scratch'], true),
    transcripts: filesIn(join(root, 'sessions'), ['sessions'], true),
  };
}

/**
 * The cockpit's read model. Each refresh costs one `bd list --all`, plus forge (Gitea or GitHub)
 * PR lookups only for beads with a `pr:` label; everything else is derived in memory and cached for
 * the TTL. `detail` adds one `bd show` and one `bd comments` for the requested bead.
 */
export class Model {
  private ctx: Ctx;
  private ttlMs: number;
  private now: () => number;
  private bdTimeoutMs: number;
  private originOf: (dir: string) => Promise<Origin | undefined>;
  private github: () => Forge;
  private snap?: Snapshot;
  private pending?: Promise<Snapshot>;
  /** Bumped by invalidate(): a refresh started under an older generation must not store its snapshot. */
  private generation = 0;

  constructor(
    ctx: Ctx,
    opts: {
      ttlMs?: number;
      now?: () => number;
      bdTimeoutMs?: number;
      originOf?: (dir: string) => Promise<Origin | undefined>;
      /** A GitHub client for one refresh; defaults to a fresh `createGitHub()`. */
      github?: () => Forge;
    } = {},
  ) {
    this.ctx = ctx;
    this.bdTimeoutMs = opts.bdTimeoutMs ?? BD_TIMEOUT_MS;
    this.originOf = opts.originOf ?? originOf;
    this.github = opts.github ?? (() => createGitHub());
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Drop the cache (after any write action). */
  invalidate(): void {
    this.generation++;
    this.snap = undefined;
    this.pending = undefined;
  }

  async board(): Promise<Board> {
    const s = await this.snapshot();
    const cards = [...s.cards.values()].filter((c) => c.type !== 'epic');
    const c = this.wipOf(s);
    const { build, review, mode } = this.ctx.config.wip;
    return { cards, wip: { build: c.build, review: c.review, limits: { build, review }, mode } };
  }

  async reviewQueue(): Promise<BeadCard[]> {
    return (await this.board()).cards.filter((c) => c.stage === 'review');
  }

  async epics(): Promise<Epic[]> {
    const s = await this.snapshot();
    const out: Epic[] = [];
    for (const b of [...s.beads.values()].sort(byPriority)) {
      if (b.issue_type !== 'epic' || b.status === 'closed') continue;
      const children = (s.children.get(b.id) ?? [])
        .map((id) => s.cards.get(id)!)
        .filter((c) => c.type !== 'epic')
        .sort(byPriority);
      const counts = { closed: 0, inProgress: 0, ready: 0, blocked: 0 };
      for (const c of children) {
        if (c.status === 'closed') counts.closed++;
        else if (c.status === 'in_progress') counts.inProgress++;
        else if (c.status === 'blocked' || c.blockedBy.length) counts.blocked++;
        else if (c.ready) counts.ready++;
      }
      out.push({ id: b.id, title: b.title, priority: b.priority, counts, children });
    }
    return out;
  }

  async detail(id: string): Promise<BeadDetail> {
    let s = await this.snapshot();
    if (!s.beads.has(id) && this.now() - s.at >= UNKNOWN_ID_REREAD_MS) {
      // Possibly created since the last refresh (e.g. from the CLI): re-read once, keeping the current
      // snapshot until the new one lands, so junk ids cannot force a refresh per request.
      s = await this.snapshot(true);
    }
    const listed = s.beads.get(id);
    if (!listed) throw notFound(id);
    let shown: Bead;
    let comments: Comment[];
    try {
      shown = await answerWithin(this.ctx.beads.show(id), this.bdTimeoutMs);
      comments = (await answerWithin(this.ctx.beads.comments(id), this.bdTimeoutMs)) ?? [];
    } catch (e) {
      throw unavailable(e);
    }
    const card = s.cards.get(id)!;
    const relations: Relations = {
      children: [...(s.children.get(id) ?? [])].sort(),
      blockedBy: card.blockedBy,
      blocks: [...(s.blocks.get(id) ?? [])].sort(),
      related: [...(s.related.get(id) ?? [])].sort(),
      discoveredFrom: listed.dependencies.filter((d) => d.type === 'discovered-from').map((d) => d.depends_on_id),
      spawned: [...(s.spawned.get(id) ?? [])].sort(),
    };
    if (listed.parent) relations.parent = listed.parent;
    const criteria = parseCriteria(shown.acceptance_criteria ?? listed.acceptance_criteria);
    const spec = specProblems({
      type: shown.issue_type,
      description: shown.description,
      acceptance: shown.acceptance_criteria ?? listed.acceptance_criteria,
    });
    const detail: BeadDetail = {
      ...card,
      labels: shown.labels,
      context: contextOf(shown.labels),
      specFormat: defaultSpecFormat(listed.issue_type),
      criteria,
      specProblems: spec,
      version: beadVersion(shown),
      editable: shown.status !== 'closed',
      criteriaChanged: criteriaChanged(shown),
      relations,
      comments,
      artefacts: this.guard('artefacts', () => listArtefacts(this.ctx.config.trackerDir, id), {
        kept: [],
        scratch: [],
        transcripts: [],
      }),
      sessions: this.guard('session index', () => sessionsFor(this.ctx.config.trackerDir, id), []),
      command: `strand work ${id}`,
    };
    const acceptance = shown.acceptance_criteria ?? listed.acceptance_criteria;
    if (acceptance) detail.acceptance = acceptance;
    if (shown.design) detail.design = shown.design;
    if (shown.notes) detail.notes = shown.notes;
    const approved = planApprovedAt(shown.notes);
    if (approved) detail.planApprovedAt = approved;
    if (shown.description) detail.description = shown.description;
    if (!approved && shown.status !== 'closed') {
      const reason = approvalWip(this.workItems(s), id, this.ctx.config.wip).reason;
      if (reason) detail.wipWarning = reason;
    }
    return detail;
  }

  /** `strand brief` from the cached data: no per-bead `bd show` (same `Brief` shape as collectBrief). */
  async brief(): Promise<Brief> {
    const s = await this.snapshot();
    const work = [...s.cards.values()].filter((c) => c.type !== 'epic' && c.status !== 'closed');
    const waiting: Brief['waiting'] = [];
    const blocked: Brief['blocked'] = [];
    for (const c of work) {
      const action = waitingAction(c.stage, c.awaitingApproval);
      if (action) waiting.push({ id: c.id, title: c.title, action });
      if (c.status === 'blocked' || c.blockedBy.length) blocked.push({ id: c.id, title: c.title, blockers: c.blockedBy });
    }
    const ready = work.filter((c) => c.ready).map((c) => ({ id: c.id, title: c.title, priority: c.priority }));
    const { wip } = await this.board();
    const briefWip: Brief['wip'] = {
      build: { count: wip.build, limit: wip.limits.build },
      review: { count: wip.review, limit: wip.limits.review },
    };
    const reason = checkBuild(wip, wip.limits, 'warn').reason;
    if (reason) briefWip.warning = reason;
    return {
      waiting,
      ready,
      blocked,
      wip: briefWip,
      sessions: s.live.map(({ sessionId, beadId, startedAt }) => ({ sessionId, beadId, startedAt })),
    };
  }

  /** WIP counts over open work items, optionally leaving one bead out. */
  private wipOf(s: Snapshot): WipCounts {
    return wipCounts(this.workItems(s));
  }

  private workItems(s: Snapshot): { id: string; stage: Stage; status: string }[] {
    return [...s.cards.values()].filter((c) => isWorkItem(s.beads.get(c.id)!));
  }

  /** A local read that degrades to `fallback` with a warning instead of failing the view. */
  private guard<T>(what: string, fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (e) {
      this.ctx.err(`strand cockpit: cannot read ${what}: ${message(e)}`);
      return fallback;
    }
  }

  /** The cached snapshot while fresh (unless forced); else one shared refresh for concurrent callers. */
  private snapshot(force = false): Promise<Snapshot> {
    if (!force && this.snap && this.now() - this.snap.at < this.ttlMs) return Promise.resolve(this.snap);
    if (!this.pending) {
      const p = this.refresh(this.generation).finally(() => {
        if (this.pending === p) this.pending = undefined;
      });
      this.pending = p;
    }
    return this.pending;
  }

  /**
   * A fresh Gitea client per refresh: the client remembers a timeout or network error for its lifetime,
   * so a shared one would leave a transient failure in place until the server restarts.
   */
  private giteaClient(): Gitea | undefined {
    const url = this.ctx.config.giteaUrl;
    if (!url) return this.ctx.gitea;
    let token = this.ctx.env.STRAND_GITEA_TOKEN;
    if (!token) {
      try {
        token = getGiteaToken();
      } catch {
        token = undefined;
      }
    }
    return token ? createGitea({ baseUrl: url, token }) : undefined;
  }

  private async refresh(generation: number): Promise<Snapshot> {
    const at = this.now();
    let listed: ListedBead[];
    try {
      listed = (await answerWithin(this.ctx.beads.listAll(), this.bdTimeoutMs)).map(sanitise);
    } catch (e) {
      throw unavailable(e);
    }

    const beads = new Map(listed.map((b) => [b.id, b]));

    const children = new Map<string, string[]>();
    const blocks = new Map<string, string[]>();
    const related = new Map<string, string[]>();
    const spawned = new Map<string, string[]>();
    for (const b of listed) {
      if (b.parent) push(children, b.parent, b.id);
      for (const d of b.dependencies) {
        const to = d.depends_on_id;
        if (d.type === 'parent-child' && !b.parent) push(children, to, b.id);
        else if (d.type === 'blocks') push(blocks, to, b.id);
        else if (d.type === 'related') {
          push(related, b.id, to);
          push(related, to, b.id);
        } else if (d.type === 'discovered-from') push(spawned, to, b.id);
      }
    }

    const live = this.guard('session index', () => liveSessions(this.ctx.config.trackerDir), []);
    const liveIds = new Set(live.map((e) => e.beadId));
    // From the same index read: beads with a live session that waits for the engineer.
    const waitingIds = new Set(live.filter((e) => e.needsYou !== undefined).map((e) => e.beadId));
    const gitea = this.giteaClient();
    // Fresh per refresh, like Gitea's: a remembered gh failure must not outlive this refresh.
    const github = this.github();
    let warned = false;
    const warn = (m: string) => {
      if (warned) return;
      warned = true;
      this.ctx.err(m);
    };
    const root = this.ctx.config.workspaceRoot;
    /** This refresh closed a bead: its snapshot is handed out but not cached, so the next read is from Beads. */
    let closedAny = false;

    // Facts start from the bead's own fields. Only a bead with a `pr:` label asks the forge, and a forge
    // error keeps the local answer (an open PR with unknown CI).
    // One `git remote get-url` per repo folder per refresh, however many beads share it.
    const origins = new Map<string, Promise<Origin | undefined>>();
    const originFor = (dir: string) => {
      let p = origins.get(dir);
      if (!p) {
        p = existsSync(dir) ? this.originOf(dir) : Promise.resolve(undefined);
        origins.set(dir, p);
      }
      return p;
    };
    const factsFor = async (b: ListedBead): Promise<{ facts: StageFacts; pr?: BeadCard['pr'] }> => {
      const facts = localFacts(b);
      const label = prsOf(b.labels).at(-1);
      if (!label) return { facts };
      let pr: BeadCard['pr'] = { ...label };
      // A closed bead is done whatever its PR says: asking the forge would only add calls per refresh.
      if (b.status === 'closed') return { facts, pr };
      const repo = repoOf(b);
      const branch = beadBranch(b);
      if (!repo || !isSafeRepoName(repo) || !branch) return { facts, pr };
      const dir = join(root, repo);
      let forge: Forge | undefined;
      try {
        const origin = await originFor(dir);
        if (!origin) return { facts, pr };
        forge = pickForge(origin.host, { giteaUrl: this.ctx.config.giteaUrl, gitea, github });
        if (!forge) return { facts, pr };
        const pull = await forge.findPullForBranch(origin.owner, origin.repo, branch);
        if (!pull) return { facts, pr };
        const state = pull.merged ? 'merged' : pull.state;
        // Close on merge (ADR 0019): only the PR the bead's own label names, in the origin repo. A merged PR
        // with another number is an older one from a reused branch name.
        if (pull.merged && pull.number === label.number && label.owner === origin.owner && label.repo === origin.repo) {
          try {
            await this.ctx.beads.close(b.id, mergedAsReason(`${origin.owner}/${origin.repo}`, pull.number));
            b.status = 'closed';
            closedAny = true;
            return { facts: localFacts(b), pr: { ...label, url: pull.url } };
          } catch (e) {
            // Not the shared `warn`: a failed close must show even when the forge already warned in this refresh.
            this.ctx.err(`strand cockpit: cannot close ${b.id} after its PR merged: ${message(e)}`);
          }
        }
        const ci = state === 'open' ? await forge.ciState(origin.owner, origin.repo, pull.headSha) : 'none';
        facts.pr = { state, ci };
        pr = { owner: origin.owner, repo: origin.repo, number: pull.number, url: pull.url };
      } catch (e) {
        warn(`strand cockpit: ${forge === github ? 'GitHub' : 'Gitea'} unavailable: ${message(e)}`);
        facts.pr = { state: 'open', ci: 'unknown' };
      }
      return { facts, pr };
    };

    // Open `blocks` dependencies each bead waits on.
    const openBlockers = new Map<string, string[]>();
    for (const b of listed) {
      openBlockers.set(
        b.id,
        b.dependencies.filter((d) => d.type === 'blocks').map((d) => d.depends_on_id).filter((to) => beads.get(to)?.status !== 'closed'),
      );
    }
    // `bd ready` also hides descendants of a blocked bead (e.g. children of an epic blocked by another epic).
    const ancestorBlocked = (b: ListedBead): boolean => {
      const seen = new Set([b.id]);
      for (let p = parentOf(b); p && !seen.has(p); ) {
        seen.add(p);
        const pb = beads.get(p);
        if (!pb) return false;
        if (openBlockers.get(p)!.length) return true;
        p = parentOf(pb);
      }
      return false;
    };

    const cardList = await mapPool(
      listed,
      GITEA_CONCURRENCY,
      async (b): Promise<BeadCard> => {
        const blockedBy = openBlockers.get(b.id)!;
        // Same rule as `bd ready`: open, nothing open blocking it or any ancestor.
        const ready = b.status === 'open' && blockedBy.length === 0 && !ancestorBlocked(b);
        const card: BeadCard = {
          id: b.id,
          title: b.title,
          type: b.issue_type,
          priority: b.priority,
          status: b.status,
          stage: 'backlog',
          ready,
          blockedBy,
          live: liveIds.has(b.id),
          needsYou: b.status !== 'closed' && waitingIds.has(b.id),
          held: isHeld(b.status),
          context: contextOf(b.labels),
          awaitingApproval: false,
          ciUnknown: false,
          labels: b.labels.filter((l) => !/^(repo|context|branch|pr):/.test(l)),
        };
        if (b.updated_at) card.updatedAt = b.updated_at;
        // One bead's failure must not break the board: show it in backlog with one warning.
        try {
          const { facts, pr } = await factsFor(b);
          card.stage = deriveStage(facts);
          if (b.status !== card.status) {
            // factsFor closed the bead: the card was filled in from the status before the close.
            card.status = b.status;
            card.needsYou = false;
            card.held = false;
          }
          card.awaitingApproval =
            card.stage === 'specify' && specReady({ type: b.issue_type, description: b.description, acceptance: b.acceptance_criteria });
          card.ciUnknown = facts.pr?.ci === 'unknown';
          if (pr) card.pr = pr;
          const branch = beadBranch(b);
          if (branch) card.branch = branch;
        } catch (e) {
          warn(`strand cockpit: cannot derive the stage of ${b.id}: ${message(e)}`);
        }
        if (b.parent) card.parent = b.parent;
        const repo = repoOf(b);
        if (repo) card.repo = repo;
        return card;
      },
    );
    const cards = new Map(cardList.sort(byPriority).map((c) => [c.id, c]));

    const snap: Snapshot = { at, beads, cards, children, blocks, related, spawned, live };
    // A write invalidated the cache while this refresh ran: hand the data to its callers, do not cache it.
    if (generation === this.generation && !closedAny) this.snap = snap;
    return snap;
  }
}
