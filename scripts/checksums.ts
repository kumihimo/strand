// Writes SHA256SUMS for release files in sha256sum's own format, so `sha256sum -c SHA256SUMS` checks them.
// Usage: node scripts/checksums.ts --out <SHA256SUMS path> <file>...
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * One line per file, `<sha256 hex>  <basename>` (two spaces: binary-agnostic text mode), LF endings, sorted by
 * name. Refuses an empty list, a path that is not a regular file, two files with the same name, and a name
 * that sha256sum would escape (a backslash or a line break), since `-c` would then not find the file.
 */
export function sha256sums(files: string[]): string {
  if (files.length === 0) throw new Error('no files to list');
  const seen = new Set<string>();
  const rows: [string, string][] = [];
  for (const f of files) {
    let isFile = false;
    try {
      isFile = statSync(f).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) throw new Error(`not a file: ${f}`);
    const name = basename(f);
    if (/[\\\r\n]/.test(name)) throw new Error(`name cannot be listed in SHA256SUMS: ${JSON.stringify(name)}`);
    if (seen.has(name)) throw new Error(`file name given twice: ${name}`);
    seen.add(name);
    rows.push([name, createHash('sha256').update(readFileSync(f)).digest('hex')]);
  }
  rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return rows.map(([name, hex]) => `${hex}  ${name}\n`).join('');
}

/** Computes the listing first, so nothing is written when any file is refused; returns the text written. */
export function writeSha256sums(out: string, files: string[]): string {
  const text = sha256sums(files);
  writeFileSync(out, text, 'utf8');
  return text;
}

function main(argv: string[]): number {
  const i = argv.indexOf('--out');
  const out = i >= 0 ? argv[i + 1] : undefined;
  const files = i >= 0 ? [...argv.slice(0, i), ...argv.slice(i + 2)] : argv;
  if (!out || out.startsWith('--') || files.length === 0) {
    process.stderr.write('usage: node scripts/checksums.ts --out <SHA256SUMS> <file>...\n');
    return 2;
  }
  try {
    process.stdout.write(writeSha256sums(out, files));
    return 0;
  } catch (e) {
    process.stderr.write(`checksums: ${(e as Error).message}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
