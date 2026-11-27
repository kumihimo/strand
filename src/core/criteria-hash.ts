// Server only: uses node:crypto. facts.ts is the UI-safe half.
import { createHash } from 'node:crypto';
import { parseCriteria } from './facts.ts';

/** First 12 hex chars of sha256 over the criteria texts, so ticking a box does not change it. */
export function criteriaHash(text: string | undefined): string {
  const joined = parseCriteria(text).map((c) => c.text).join('\n');
  return createHash('sha256').update(joined).digest('hex').slice(0, 12);
}
