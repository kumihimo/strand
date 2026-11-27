import type { FastifyInstance, FastifyReply } from 'fastify';
import { BdError } from '../core/bd.ts';
import { BEAD_ID } from '../core/create-bead.ts';
import { QueueError, type WorkQueue } from './queue-runner.ts';

/** Most ids one request may carry. */
export const MAX_QUEUE_IDS = 200;

const STATUS: Record<QueueError['code'], number> = { 'not-found': 404, 'not-backlog': 409, 'bad-order': 409 };

/** `{ ids }` with bead ids only, each once, or the reason it is refused. An empty list only when `allowEmpty`. */
function parseIds(b: unknown, allowEmpty: boolean): string[] | string {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return 'body must be { ids: [bead ids] }';
  const o = b as Record<string, unknown>;
  // Never echo the key back: it is whatever the caller sent.
  if (Object.keys(o).some((k) => k !== 'ids')) return 'unknown field in body';
  const ids = o.ids;
  if (!Array.isArray(ids)) return 'ids must be a list';
  if (ids.length === 0 && !allowEmpty) return 'ids must not be empty';
  if (ids.length > MAX_QUEUE_IDS) return `at most ${MAX_QUEUE_IDS} ids`;
  if (!ids.every((id) => typeof id === 'string' && BEAD_ID.test(id))) return 'every id must be a bead id';
  return ids as string[];
}

/**
 * The work queue's routes (ADR 0023). They sit behind the server's Host, Origin and key checks. Every id is
 * checked against BEAD_ID here, and against the tracker by the queue: only Backlog beads go in.
 */
export function registerQueueRoutes(app: FastifyInstance, queue: WorkQueue | undefined): void {
  const unavailable = 'the queue needs terminals, which are not available';
  const refuse = (reply: FastifyReply, e: unknown) => {
    if (e instanceof QueueError) return reply.code(STATUS[e.code]).send({ error: e.message });
    if (e instanceof BdError) return reply.code(503).send({ error: `Beads unavailable: ${e.firstStderrLine}` });
    throw e;
  };

  app.get('/api/queue', async () => (queue ? { available: true, ids: queue.ids() } : { available: false, reason: unavailable, ids: [] }));

  app.post('/api/queue', async (req, reply) => {
    const ids = parseIds(req.body, false);
    if (typeof ids === 'string') return reply.code(400).send({ error: ids });
    if (!queue) return reply.code(503).send({ error: unavailable });
    return queue.add(ids).catch((e: unknown) => refuse(reply, e));
  });

  app.put('/api/queue', async (req, reply) => {
    const ids = parseIds(req.body, true);
    if (typeof ids === 'string') return reply.code(400).send({ error: ids });
    if (!queue) return reply.code(503).send({ error: unavailable });
    return queue.setOrder(ids).catch((e: unknown) => refuse(reply, e));
  });

  app.delete('/api/queue/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!BEAD_ID.test(id)) return reply.code(404).send({ error: 'bead not found' });
    if (!queue) return reply.code(503).send({ error: unavailable });
    return queue.remove(id);
  });
}
