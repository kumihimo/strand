import type { ListedBead } from '../core/bd.ts';
import { dequeue, enqueue, freeSlots, prune, remove, reorder } from '../core/queue.ts';
import { readQueue, writeQueue } from '../core/queue-store.ts';
import { localStage } from '../core/snapshot.ts';
import { isHeld } from '../core/stage.ts';
import { TerminalLimitError, oneLine, type TerminalInfo, type TerminalMode } from './pty.ts';

/** How often the runner looks for room when nothing else wakes it. */
export const TICK_MS = 15_000;

/** A bead may be queued, and stays queued, only while it is in Backlog and not on hold. */
export function queueable(b: ListedBead): boolean {
  return !isHeld(b.status) && localStage(b) === 'backlog';
}

export type QueueErrorCode = 'not-found' | 'not-backlog' | 'bad-order';

/** A refused queue edit. The routes map `code` to a status. */
export class QueueError extends Error {
  code: QueueErrorCode;
  constructor(code: QueueErrorCode, message: string) {
    super(message);
    this.name = 'QueueError';
    this.code = code;
  }
}

export type WorkQueueDeps = {
  /** queue.json. */
  file: string;
  /** Most beads in progress at once (wip.build). Read on every tick. */
  limit: () => number;
  /** Every bead by id, from one `bd list`. */
  beads: () => Promise<Map<string, ListedBead>>;
  /** The bead's repo folder; throws when it has none. */
  cwdFor: (b: ListedBead) => string;
  terminals: {
    list: () => TerminalInfo[];
    start: (o: { beadId: string; cwd: string; mode: TerminalMode }) => TerminalInfo;
  };
  comment: (id: string, text: string) => Promise<void>;
  /** Called after the queue or the beads changed, so the read model drops its cache. */
  onChange?: () => void;
  warn?: (line: string) => void;
};

/**
 * The cockpit's work queue (ADR 0023). Edits and ticks run one at a time, in the order called, so a tick never
 * overlaps another tick or an edit. A tick drops queued beads that left Backlog, then starts the front bead in a
 * Specify terminal while fewer than `limit` beads are in progress.
 */
export class WorkQueue {
  readonly deps: WorkQueueDeps;
  #ids: string[];
  #chain: Promise<unknown> = Promise.resolve();
  #timer?: NodeJS.Timeout;
  /** Set by stop(): a tick in flight starts nothing more (the cockpit is closing). */
  #stopped = false;

  constructor(deps: WorkQueueDeps) {
    this.deps = deps;
    this.#ids = readQueue(deps.file, this.#warn);
  }

  #warn = (line: string) => (this.deps.warn ?? ((l: string) => console.error(l)))(line);

  /** Run `f` after everything already queued; a failure of one step does not stop the next. */
  #serial<T>(f: () => Promise<T>): Promise<T> {
    const p = this.#chain.then(f, f);
    this.#chain = p.catch(() => undefined);
    return p;
  }

  #save(ids: string[]): void {
    if (ids.length === this.#ids.length && ids.every((id, i) => id === this.#ids[i])) return;
    writeQueue(this.deps.file, ids);
    this.#ids = ids;
    this.deps.onChange?.();
  }

  /** The queued ids, front first. */
  ids(): string[] {
    return [...this.#ids];
  }

  /** Resolves once every edit and tick called so far has finished. */
  idle(): Promise<void> {
    return this.#serial(async () => undefined);
  }

  /** Append Backlog beads in the order given. Any id that is unknown or not in Backlog refuses the whole call. */
  add(ids: readonly string[]): Promise<{ ids: string[] }> {
    const r = this.#serial(async () => {
      const beads = await this.deps.beads();
      for (const id of ids) {
        const b = beads.get(id);
        if (!b) throw new QueueError('not-found', `bead ${id} not found`);
        if (!queueable(b)) throw new QueueError('not-backlog', `bead ${id} is not in Backlog`);
      }
      this.#save(enqueue(this.#ids, ids));
      return { ids: this.ids() };
    });
    void r.then(() => this.tick(), () => undefined);
    return r;
  }

  /** Put the queue in this order: some or all of the queued ids. One left out leaves the queue. */
  setOrder(ids: readonly string[]): Promise<{ ids: string[] }> {
    return this.#serial(async () => {
      let next: string[];
      try {
        next = reorder(this.#ids, ids);
      } catch (e) {
        throw new QueueError('bad-order', (e as Error).message);
      }
      this.#save(next);
      return { ids: this.ids() };
    });
  }

  /** Take one bead off the queue. An id not queued changes nothing. */
  remove(id: string): Promise<{ ids: string[] }> {
    return this.#serial(async () => {
      this.#save(remove(this.#ids, id));
      return { ids: this.ids() };
    });
  }

  /** One pass. Resolves to the ids started, in order. Never rejects: a Beads outage skips the pass. */
  tick(): Promise<string[]> {
    return this.#serial(() => this.#tick()).catch((e: unknown) => {
      this.#warn(`strand: the work queue did not advance: ${oneLine(e)}`);
      return [];
    });
  }

  async #tick(): Promise<string[]> {
    // Nothing queued: no bd call.
    if (this.#ids.length === 0 || this.#stopped) return [];
    const beads = await this.deps.beads();
    let q = prune(this.#ids, (id) => {
      const b = beads.get(id);
      return b !== undefined && queueable(b);
    });
    const live = this.deps.terminals.list().filter((t) => !t.exited);
    const claimed = [...beads.values()].filter((b) => b.status === 'in_progress');
    // A terminal started on an open bead holds a slot before its hook claims the bead.
    const pending = new Set(live.map((t) => t.beadId).filter((id) => beads.get(id)?.status === 'open'));
    let free = freeSlots(claimed.length + pending.size, this.deps.limit());
    const started: string[] = [];
    while (free > 0 && q.length > 0 && !this.#stopped) {
      const { id, rest } = dequeue(q);
      const b = beads.get(id!)!;
      try {
        this.deps.terminals.start({ beadId: b.id, cwd: this.deps.cwdFor(b), mode: 'specify' });
      } catch (e) {
        // The cockpit's own terminal cap is passing: keep the bead at the front and try on a later tick.
        if (e instanceof TerminalLimitError) break;
        q = rest;
        const reason = oneLine(e);
        this.#warn(`strand: queued bead ${b.id} did not start: ${reason}`);
        await this.deps.comment(b.id, `queue: could not start: ${reason}`).catch((c: unknown) => this.#warn(`strand: could not comment on ${b.id}: ${oneLine(c)}`));
        continue;
      }
      q = rest;
      started.push(b.id);
      free--;
    }
    this.#save(q);
    if (started.length) this.deps.onChange?.();
    return started;
  }

  /** Tick now and every `ms` until stop(). The timer does not keep the process alive. */
  start(ms = TICK_MS): void {
    clearInterval(this.#timer);
    this.#stopped = false;
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), ms);
    this.#timer.unref();
  }

  /** No more ticks, and a tick in flight starts nothing more. Edits still work. */
  stop(): void {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
