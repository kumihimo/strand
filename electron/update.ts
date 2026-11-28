import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as openpgp from 'openpgp';

/**
 * The pure half of auto-update (ADR 0025): when to check, how a downloaded update is verified against the
 * release's GPG-signed SHA256SUMS, and when it installs. No `electron` import: main.ts hands in the updater,
 * the network and the clock, so the tests run this under plain Node.
 *
 * An update installs only on a quit the user starts, never on its own: a restart would end the cockpit's
 * Claude Code sessions. electron-updater's own install-on-quit is kept off, since it registers its quit handler
 * when the download lands, before the file is verified; onQuit here installs the verified file instead.
 */

export const RELEASE = { owner: 'kumihimo', repo: 'strand' } as const;
/** The first check runs this long after start, so it never slows the window opening. */
export const CHECK_DELAY_MS = 30_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** SHA256SUMS lists three files; anything near this size is not one. */
export const MAX_SUMS_BYTES = 64 * 1024;

/** Checks run only in a packaged app, and never while STRAND_NO_UPDATE is set (to any value). */
export function shouldCheck(o: { isPackaged: boolean; env: NodeJS.ProcessEnv }): boolean {
  return o.isPackaged && o.env.STRAND_NO_UPDATE === undefined;
}

const VERSION = /^\d+\.\d+\.\d+$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The download URL of a release asset. Only a plain x.y.z version and a plain file name; reject, never repair. */
export function assetUrl(version: string, name: string): string {
  if (!VERSION.test(version)) throw new Error(`assetUrl: not a plain version: ${JSON.stringify(version)}`);
  if (!NAME.test(name) || name.includes('..')) throw new Error(`assetUrl: not a plain file name: ${JSON.stringify(name)}`);
  return `https://github.com/${RELEASE.owner}/${RELEASE.repo}/releases/download/v${version}/${name}`;
}

const LINE = /^([0-9a-fA-F]{64}) [ *](.+)$/;

/** name -> lower-case hex, from sha256sum's output. Any line that is not exactly that refuses the whole file. */
export function parseSha256sums(text: string): Map<string, string> {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) throw new Error('SHA256SUMS is empty');
  const out = new Map<string, string>();
  for (const l of lines) {
    const m = LINE.exec(l.replace(/\r$/, ''));
    if (!m) throw new Error(`SHA256SUMS has a malformed line: ${JSON.stringify(l.slice(0, 120))}`);
    const [, hex, name] = m;
    if (!NAME.test(name) || name.includes('..')) throw new Error(`SHA256SUMS lists a name that is not plain: ${JSON.stringify(name)}`);
    if (out.has(name)) throw new Error(`SHA256SUMS lists ${name} twice`);
    out.set(name, hex.toLowerCase());
  }
  return out;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/**
 * Pass only when `signature` is a valid detached signature over `sums` by `publicKey`, and `sums` lists
 * `fileName` with exactly `fileHash`. Every error is a failure: closed on error.
 */
export async function verifyDownload(o: {
  sums: Uint8Array;
  signature: string;
  publicKey: string;
  fileName: string;
  fileHash: string;
}): Promise<Verdict> {
  try {
    const verificationKeys = await openpgp.readKey({ armoredKey: o.publicKey });
    const signature = await openpgp.readSignature({ armoredSignature: o.signature });
    const message = await openpgp.createMessage({ binary: o.sums });
    const { signatures } = await openpgp.verify({ message, signature, verificationKeys, expectSigned: true, format: 'binary' });
    if (signatures.length === 0) return { ok: false, reason: 'SHA256SUMS.asc holds no signature' };
    await Promise.all(signatures.map((s) => s.verified));
  } catch (e) {
    return { ok: false, reason: `SHA256SUMS signature did not verify against the release key: ${e instanceof Error ? e.message : String(e)}` };
  }
  let sums: Map<string, string>;
  try {
    sums = parseSha256sums(Buffer.from(o.sums).toString('utf8'));
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const want = sums.get(o.fileName);
  if (want === undefined) return { ok: false, reason: `${o.fileName} is not listed in SHA256SUMS` };
  if (want !== o.fileHash.toLowerCase()) return { ok: false, reason: `${o.fileName} does not match its SHA256SUMS line` };
  return { ok: true };
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')));
  });
}

export function readyMessage(version: string): string {
  return `Strand ${version} is ready. It installs when you quit.`;
}

const basename = (p: string) => p.split(/[\\/]/).pop() ?? '';

/** The part of electron-updater's AppUpdater this module uses. */
export type UpdaterLike = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  /** The file electron-updater would run on install. */
  readonly installerPath?: string | null;
  on(event: 'update-downloaded', fn: (e: { version: string; downloadedFile: string }) => void): unknown;
  on(event: 'error', fn: (e: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
};

export type UpdateDeps = {
  updater: UpdaterLike;
  /** The armored release key, RELEASE-KEY.asc as packaged with the app. */
  publicKey: string;
  fetchBytes(url: string): Promise<Uint8Array>;
  hashFile(file: string): Promise<string>;
  removeFile(file: string): Promise<void>;
  log(line: string): void;
  /** A download passed verification: notify and offer "Restart to update". */
  onVerified(version: string): void;
  clock: { setTimeout(fn: () => void, ms: number): unknown; setInterval(fn: () => void, ms: number): unknown };
};

export type Updates = {
  /** The version marked for install on quit, if any. */
  verified(): string | undefined;
  /** Ask for a relaunch after the install. The caller quits the app. False when nothing is verified. */
  restartToUpdate(): boolean;
  /** The quit was cancelled (the unload guard): a later quit installs without a relaunch. */
  cancelRestart(): void;
  /** Called from the app's `quit` event. Installs the verified file, once, on a clean quit. */
  onQuit(exitCode: number): void;
  /** Resolves when the verifications in flight have finished (for tests and logs). */
  settled(): Promise<void>;
};

/** Sets the updater up and starts the checks, or does nothing and returns undefined when shouldCheck is false. */
export function startUpdates(o: { isPackaged: boolean; env: NodeJS.ProcessEnv; deps: UpdateDeps }): Updates | undefined {
  if (!shouldCheck(o)) return undefined;
  const d = o.deps;
  const u = d.updater;
  u.autoDownload = true;
  u.autoInstallOnAppQuit = false;
  u.allowPrerelease = false;

  let marked: { version: string; file: string } | undefined;
  let generation = 0;
  let restart = false;
  let installed = false;
  let inFlight: Promise<void> = Promise.resolve();

  const check = () => {
    u.checkForUpdates().catch((e: unknown) => d.log(`update check failed, retrying at the next interval: ${e instanceof Error ? e.message : String(e)}`));
  };
  u.on('error', (e) => d.log(`updater error: ${e?.message ?? String(e)}`));

  async function verify(gen: number, version: string, file: string): Promise<void> {
    let verdict: Verdict;
    try {
      const sums = await d.fetchBytes(assetUrl(version, 'SHA256SUMS'));
      if (sums.byteLength > MAX_SUMS_BYTES) throw new Error('SHA256SUMS is too large');
      const signature = Buffer.from(await d.fetchBytes(assetUrl(version, 'SHA256SUMS.asc'))).toString('utf8');
      const fileHash = await d.hashFile(file);
      verdict = await verifyDownload({ sums, signature, publicKey: d.publicKey, fileName: basename(file), fileHash });
    } catch (e) {
      verdict = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    if (gen !== generation) return; // A newer download landed meanwhile; its own verification decides.
    if (verdict.ok) {
      marked = { version, file };
      d.log(`update ${version} verified; it installs when Strand quits`);
      d.onVerified(version);
      return;
    }
    d.log(`update ${version} failed verification and will not be installed: ${verdict.reason}`);
    await d.removeFile(file).catch((e: unknown) => d.log(`could not delete the failed update ${file}: ${(e as Error).message}`));
  }

  // Synchronous on purpose: the new file is unmarked before anything else can run.
  u.on('update-downloaded', (e) => {
    marked = undefined;
    const gen = ++generation;
    const job = verify(gen, String(e?.version), String(e?.downloadedFile));
    inFlight = Promise.all([inFlight, job]).then(() => {});
  });

  d.clock.setTimeout(check, CHECK_DELAY_MS);
  d.clock.setInterval(check, CHECK_INTERVAL_MS);

  return {
    verified: () => marked?.version,
    restartToUpdate() {
      if (!marked) return false;
      restart = true;
      return true;
    },
    cancelRestart() {
      restart = false;
    },
    onQuit(exitCode) {
      if (installed || !marked || exitCode !== 0) return;
      if (u.installerPath !== marked.file) {
        d.log(`not installing: the pending installer ${u.installerPath} is not the verified ${marked.file}`);
        return;
      }
      installed = true;
      d.log(`installing update ${marked.version}${restart ? ' and relaunching' : ''}`);
      u.quitAndInstall(true, restart);
    },
    settled: () => inFlight,
  };
}
