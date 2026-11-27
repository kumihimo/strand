import { randomBytes, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = 'strand_key';
export const HEADER_NAME = 'x-strand-key';

/** A fresh per-launch token: 32 random bytes as hex. */
export function newToken(): string {
  return randomBytes(32).toString('hex');
}

/** Constant-time comparison; a missing value or a different length is a mismatch. */
export function tokenMatches(given: string | undefined, token: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The value of one cookie from a Cookie header, or undefined. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}
