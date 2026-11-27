import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configPath } from '../core/config.ts';
import { renameWithRetry } from '../core/binding.ts';
import { COOKIE_NAME } from './auth.ts';

/**
 * The running cockpit, as written to `cockpit.json` beside the strand `config.json` so a second
 * `strand cockpit` can find it. It holds the per-launch key, so it is written readable
 * by the user only and removed when the server stops.
 */
export type Instance = { port: number; pid: number; key: string };

/** How long a probe waits for the running server to answer. */
export const PROBE_TIMEOUT_MS = 1500;

const KEY = /^[0-9a-f]{64}$/;

function valid(v: unknown): v is Instance {
  if (v === null || typeof v !== 'object') return false;
  const { port, pid, key } = v as Record<string, unknown>;
  return (
    Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535 &&
    Number.isInteger(pid) && (pid as number) > 0 &&
    typeof key === 'string' && KEY.test(key)
  );
}

/**
 * `cockpit.json` in the folder of the strand `config.json` (`configPath`): `<config dir>/strand/cockpit.json`, or
 * `<STRAND_CONFIG_DIR>/cockpit.json` when that override is set.
 */
export function instanceFile(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.join(p.dirname(configPath(platform, env, home)), 'cockpit.json');
}

/**
 * Write the file atomically: a temp file in the same folder, then a rename over the old one.
 * POSIX: mode 0o600. Windows has no mode bits here: the file inherits the ACL of the folder
 * under %APPDATA%, which by default only the user (plus SYSTEM and Administrators) can read.
 */
export function writeInstance(file: string, i: Instance): void {
  if (!valid(i)) throw new Error('writeInstance: invalid cockpit instance');
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  // A temp file left by a crash may carry other permissions: start from nothing.
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify({ port: i.port, pid: i.pid, key: i.key }) + '\n', { mode: 0o600, flag: 'wx' });
  renameWithRetry(tmp, file);
}

/** The instance in the file, or undefined when it is missing, unreadable or malformed. */
export function readInstance(file: string): Instance | undefined {
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!valid(v)) return undefined;
    return { port: v.port, pid: v.pid, key: v.key };
  } catch {
    return undefined;
  }
}

/** Remove the file, but only while it still names `pid`: a stopping server must not delete a newer server's file. */
export function removeInstance(file: string, pid: number): void {
  try {
    if (readInstance(file)?.pid === pid) rmSync(file, { force: true });
  } catch {
    // Called on exit: never throw.
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * True only when the pid is alive AND `GET /api/ping` on 127.0.0.1 with the key cookie answers
 * 200 with that same pid, within 1.5 s. A dead pid, a pid reused by another program, a port that
 * answers with another key or another pid, or a timeout all mean "not running".
 */
export async function probeInstance(i: Instance, fetchFn: typeof fetch = fetch): Promise<boolean> {
  if (!valid(i) || !alive(i.pid)) return false;
  try {
    const r = await fetchFn(`http://127.0.0.1:${i.port}/api/ping`, {
      headers: { cookie: `${COOKIE_NAME}=${i.key}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (r.status !== 200) {
      await r.body?.cancel().catch(() => {});
      return false;
    }
    const body: unknown = await r.json();
    return body !== null && typeof body === 'object' && (body as { pid?: unknown }).pid === i.pid;
  } catch {
    return false;
  }
}
