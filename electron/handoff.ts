import path from 'node:path';
import { COOKIE_NAME } from '../src/cockpit/auth.ts';
import { externalUrl } from '../src/core/links.ts';

/**
 * The pure half of the Electron shell (ADR 0022): what the main process accepts from the server child, the
 * cookie it sets, and the window's navigation, permission and quit rules. No `electron` import, so the tests
 * run it under plain Node.
 */

/** What the server child sends once over IPC: it started a server (and stays), or found one (and exits). */
export type Ready = { kind: 'started' | 'attached'; port: number; key: string };

/** How long main waits for the child's ready message before it shows the error page. */
export const READY_TIMEOUT_MS = 30_000;
/** How long an owned server gets to stop after `stop` before main kills it. */
export const STOP_GRACE_MS = 5000;

/** The one message main sends: stop the server (as on SIGTERM). */
export const STOP_MESSAGE = { kind: 'stop' } as const;

const KEY = /^[0-9a-f]{64}$/;
const validPort = (p: unknown): p is number => Number.isInteger(p) && (p as number) >= 1 && (p as number) <= 65535;

/** The ready message, or undefined for anything but exactly `{kind, port, key}`. Reject, never repair. */
export function parseReady(m: unknown): Ready | undefined {
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return undefined;
  const keys = Object.keys(m).sort();
  if (keys.join(',') !== 'key,kind,port') return undefined;
  const { kind, port, key } = m as Record<string, unknown>;
  if (kind !== 'started' && kind !== 'attached') return undefined;
  if (!validPort(port) || typeof key !== 'string' || !KEY.test(key)) return undefined;
  return { kind, port, key };
}

export function cockpitOrigin(port: number): string {
  if (!validPort(port)) throw new Error('cockpitOrigin: invalid port');
  return `http://127.0.0.1:${port}`;
}

export type CookieDetails = { url: string; name: string; value: string; httpOnly: true; sameSite: 'strict'; secure: false };

/**
 * The session cookie the server's `?key=` bootstrap would set, set by main instead, so the key is never in a
 * URL. No `expirationDate`: a session cookie, and the partition is in memory, so it is never on disk.
 */
export function cookieDetails(port: number, key: string): CookieDetails {
  if (!KEY.test(key)) throw new Error('cookieDetails: invalid key');
  return { url: `${cockpitOrigin(port)}/`, name: COOKIE_NAME, value: key, httpOnly: true, sameSite: 'strict', secure: false };
}

/** True only for an http URL on the server's own origin. Fail closed on anything that does not parse. */
export function navigationAllowed(url: string, port: number): boolean {
  try {
    const u = new URL(url);
    return u.username === '' && u.password === '' && u.origin === cockpitOrigin(port);
  } catch {
    return false;
  }
}

/**
 * What the window does with a window.open (a terminal link): never open a child window. An http(s) link is
 * handed to the default browser as `external`; anything else is dropped.
 */
export function windowOpenDecision(url: string): { action: 'deny'; external?: string } {
  const external = externalUrl(url);
  return external === undefined ? { action: 'deny' } : { action: 'deny', external };
}

/** Every permission is denied except writing to the clipboard (the terminal's copy). */
export function permissionAllowed(permission: string): boolean {
  return permission === 'clipboard-sanitized-write';
}

/** The server child: the strand CLI in `--ipc` mode, under `STRAND_NODE` or `node` from PATH. No key, ever. */
export function serverCommand(appRoot: string, env: NodeJS.ProcessEnv): { cmd: string; args: string[] } {
  return { cmd: env.STRAND_NODE || 'node', args: [path.join(appRoot, 'src', 'cli', 'strand.ts'), 'cockpit', '--ipc'] };
}

/** The child's env: Electron's own, minus the `ELECTRON_*` variables that would change how Node runs. */
export function serverEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.toUpperCase().startsWith('ELECTRON_')));
}

/**
 * Electron's profile folder. Its default would be `<appData>/strand`, the strand config folder itself (and on
 * Windows `Strand` is the same folder), so it gets a name of its own.
 */
export function userDataDir(appData: string): string {
  const p = /^[A-Za-z]:\\/.test(appData) ? path.win32 : path.posix;
  return p.join(appData, 'strand-desktop');
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The page shown when the server child fails: what went wrong, what to do, and its last stderr lines. */
export function errorPage(reason: string, stderr: readonly string[]): string {
  const log = stderr.length ? `<p>The server's last lines:</p><pre>${stderr.map(escapeHtml).join('\n')}</pre>` : '';
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    '<title>Strand</title>',
    '<style>body{font:15px system-ui,sans-serif;margin:2rem;max-width:48rem;color:#222;background:#fff}',
    'pre{background:#f4f4f4;padding:1rem;overflow:auto;white-space:pre-wrap}',
    '@media (prefers-color-scheme: dark){body{color:#ddd;background:#1b1b1b}pre{background:#2a2a2a}}</style>',
    `</head><body><h1>Strand could not start the cockpit</h1><p>${escapeHtml(reason)}</p>${log}`,
    '<p>Fix it and start Strand again.</p></body></html>',
  ].join('');
}

/** The last `max` lines of a stream, with any 64-hex run (a key) redacted before it is kept. */
export class StderrTail {
  #max: number;
  #lines: string[] = [];
  #partial = '';
  constructor(max: number) {
    this.#max = max;
  }
  push(chunk: string): void {
    const parts = (this.#partial + chunk).split(/\r?\n/);
    this.#partial = parts.pop() ?? '';
    for (const l of parts) this.#keep(l);
  }
  #keep(line: string): void {
    this.#lines.push(line.replace(/[0-9a-fA-F]{64,}/g, '<redacted>'));
    if (this.#lines.length > this.#max) this.#lines.shift();
  }
  lines(): string[] {
    const out = [...this.#lines];
    if (this.#partial !== '') out.push(this.#partial.replace(/[0-9a-fA-F]{64,}/g, '<redacted>'));
    return out.slice(-this.#max);
  }
}
