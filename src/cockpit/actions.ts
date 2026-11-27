import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, win32 } from 'node:path';
import { assertSafeSegment } from '../core/sessions.ts';
import { BEAD_ID } from '../core/create-bead.ts';

/** Types POST /api/open may launch; everything else is refused. */
const OPEN_ALLOWED = new Set(['.html', '.htm', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf', '.mp4', '.webm', '.mov', '.md', '.txt', '.json', '.csv', '.pptx', '.docx', '.xlsx', '.gz']);
const BLOCKED_EXT = new Set(['.exe', '.bat', '.cmd', '.com', '.ps1', '.sh', '.msi', '.lnk', '.app', '.js', '.vbs']);

function refuse(reason: string): never {
  throw new Error(`refused: ${reason}`);
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** Real path of a kept file under `<trackerDir>/artefacts/<beadId>/`, or throw `Error('refused: …')`. */
export function resolveArtefact(trackerDir: string, beadId: string, rel: string, opts: { forOpen?: boolean } = {}): string {
  if (typeof beadId !== 'string' || !BEAD_ID.test(beadId)) refuse('invalid bead id');
  try {
    assertSafeSegment(beadId, 'bead id');
  } catch {
    refuse('invalid bead id');
  }
  if (typeof rel !== 'string' || !rel) refuse('a relative file path is required');
  if (rel.includes('\0')) refuse('invalid path');
  if (isAbsolute(rel) || win32.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.startsWith('/') || rel.startsWith('\\')) {
    refuse('path must be relative');
  }
  const parts = rel.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
  if (parts.length === 0) refuse('a relative file path is required');
  if (parts.includes('..')) refuse('path must not contain ..');
  // Win32 strips trailing dots/spaces and treats ':' as an alternate data stream, so the extension could lie.
  if (parts.some((p) => p.includes(':') || p.endsWith('.') || p.endsWith(' '))) refuse('invalid file name');
  if (BLOCKED_EXT.has(extOf(parts[parts.length - 1]))) refuse('executable and script files cannot be opened');

  const base = join(trackerDir, 'artefacts', beadId);
  let root: string;
  let real: string;
  try {
    // Per-bead root: a symlink from one bead's folder into another's must not pass.
    root = realpathSync.native(base);
    real = realpathSync.native(join(base, ...parts));
  } catch {
    return refuse('file not found');
  }
  const back = relative(fold(root), fold(real));
  if (!back || back.startsWith('..') || isAbsolute(back)) refuse('path escapes the artefacts folder');
  // The extension is judged again on the real name: a symlink must not launder a script.
  if (BLOCKED_EXT.has(extOf(basename(real)))) refuse('executable and script files cannot be opened');
  const st = statSync(real);
  if (!st.isFile()) refuse('not a regular file');
  if (opts.forOpen) {
    if (!OPEN_ALLOWED.has(extOf(basename(real)))) refuse("this file type can't be opened from the cockpit");
    if (process.platform !== 'win32' && (st.mode & 0o111) !== 0) refuse("this file type can't be opened from the cockpit");
  }
  return real;
}

/** Only http(s) links may be opened. */
export function checkUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return refuse('only http and https links can be opened');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') refuse('only http and https links can be opened');
  return u;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf', '.gz': 'application/gzip',
};

export function contentTypeFor(name: string): string {
  return TYPES[extOf(name)] ?? 'application/octet-stream';
}
