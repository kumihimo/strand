import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as openpgp from 'openpgp';
import {
  CHECK_DELAY_MS,
  CHECK_INTERVAL_MS,
  assetUrl,
  parseSha256sums,
  readyMessage,
  sha256File,
  shouldCheck,
  startUpdates,
  verifyDownload,
  type UpdateDeps,
  type UpdaterLike,
} from '../electron/update.ts';

const root = join(import.meta.dirname, '..');
const RELEASE_KEY = readFileSync(join(root, 'RELEASE-KEY.asc'), 'utf8');
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', 'release-0.1.0', name));
const HEX = (c: string) => c.repeat(64);

async function keypair() {
  const { privateKey, publicKey } = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ name: 'test' }], format: 'armored' });
  return { privateKey: await openpgp.readPrivateKey({ armoredKey: privateKey }), publicKey };
}

async function sign(privateKey: openpgp.PrivateKey, bytes: Uint8Array): Promise<string> {
  const message = await openpgp.createMessage({ binary: bytes });
  return (await openpgp.sign({ message, signingKeys: privateKey, detached: true, format: 'armored' })) as string;
}

// shouldCheck (AT-6)

test('AT-6 shouldCheck is true only for a packaged app without STRAND_NO_UPDATE', () => {
  assert.equal(shouldCheck({ isPackaged: true, env: {} }), true);
  assert.equal(shouldCheck({ isPackaged: false, env: {} }), false);
  assert.equal(shouldCheck({ isPackaged: true, env: { STRAND_NO_UPDATE: '1' } }), false);
  assert.equal(shouldCheck({ isPackaged: true, env: { STRAND_NO_UPDATE: '' } }), false, 'set but empty still turns it off');
  assert.equal(shouldCheck({ isPackaged: true, env: { STRAND_NO_UPDATE: '0' } }), false, 'any value turns it off');
});

// SHA256SUMS parsing

test('parseSha256sums reads sha256sum lines, text or binary mode', () => {
  const m = parseSha256sums(`${HEX('a')}  Strand-0.1.2.AppImage\n${HEX('B')} *Strand-Setup-0.1.2.exe\n`);
  assert.deepEqual([...m], [
    ['Strand-0.1.2.AppImage', HEX('a')],
    ['Strand-Setup-0.1.2.exe', HEX('b')],
  ]);
  assert.equal(parseSha256sums(fixture('SHA256SUMS').toString('utf8')).size, 3, 'the v0.1.0 release file');
});

test('parseSha256sums refuses a malformed listing rather than skipping lines', () => {
  const bad = [
    '',
    'not a sums file\n',
    `${HEX('a')} x\n`, // one space, no mode marker
    `${'a'.repeat(63)}  x\n`,
    `${HEX('g')}  x\n`,
    `${HEX('a')}  \n`,
    `${HEX('a')}  dir/x\n`,
    `${HEX('a')}  ..\n`,
    `${HEX('a')}  x\n${HEX('b')}  x\n`, // a name twice
    `\\${HEX('a')}  x\n`, // sha256sum's escaped-name form
  ];
  for (const t of bad) assert.throws(() => parseSha256sums(t), /SHA256SUMS/, JSON.stringify(t));
});

// assetUrl

test('assetUrl builds the release download URL, and refuses a version or name that is not plain', () => {
  assert.equal(assetUrl('0.1.2', 'SHA256SUMS'), 'https://github.com/kumihimo/strand/releases/download/v0.1.2/SHA256SUMS');
  for (const v of ['', '0.1', 'v0.1.2', '0.1.2/../x', '0.1.2?x', '0.1.2-beta.1']) assert.throws(() => assetUrl(v, 'SHA256SUMS'), /version/);
  for (const n of ['', 'a/b', '..', 'a?b', 'a#b', 'a b']) assert.throws(() => assetUrl('0.1.2', n), /name/);
});

// verifyDownload (AT-5)

test('AT-5 verifyDownload passes the real v0.1.0 SHA256SUMS, signed by gpg, against the committed release key', async () => {
  const sums = fixture('SHA256SUMS');
  const signature = fixture('SHA256SUMS.asc').toString('utf8');
  const hash = parseSha256sums(sums.toString('utf8')).get('Strand-0.1.0.AppImage')!;
  assert.deepEqual(await verifyDownload({ sums, signature, publicKey: RELEASE_KEY, fileName: 'Strand-0.1.0.AppImage', fileHash: hash }), { ok: true });
});

test('AT-5 verifyDownload fails a signature by another key', async () => {
  const other = await keypair();
  const sums = fixture('SHA256SUMS');
  const signature = await sign(other.privateKey, sums);
  const hash = parseSha256sums(sums.toString('utf8')).get('Strand-0.1.0.AppImage')!;
  const v = await verifyDownload({ sums, signature, publicKey: RELEASE_KEY, fileName: 'Strand-0.1.0.AppImage', fileHash: hash });
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /signature/);
});

test('AT-5 verifyDownload fails a SHA256SUMS changed after signing', async () => {
  const sums = Buffer.from(fixture('SHA256SUMS').toString('utf8').replace(/^e8/, 'f8'));
  const signature = fixture('SHA256SUMS.asc').toString('utf8');
  const hash = parseSha256sums(sums.toString('utf8')).get('Strand-0.1.0.AppImage')!;
  const v = await verifyDownload({ sums, signature, publicKey: RELEASE_KEY, fileName: 'Strand-0.1.0.AppImage', fileHash: hash });
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /signature/);
});

test('AT-5 verifyDownload fails a signature that is not a signature, or a key that is not a key', async () => {
  const sums = fixture('SHA256SUMS');
  const hash = parseSha256sums(sums.toString('utf8')).get('Strand-0.1.0.AppImage')!;
  const o = { sums, fileName: 'Strand-0.1.0.AppImage', fileHash: hash };
  assert.equal((await verifyDownload({ ...o, signature: 'junk', publicKey: RELEASE_KEY })).ok, false);
  assert.equal((await verifyDownload({ ...o, signature: '', publicKey: RELEASE_KEY })).ok, false);
  assert.equal((await verifyDownload({ ...o, signature: fixture('SHA256SUMS.asc').toString('utf8'), publicKey: 'junk' })).ok, false);
});

test('AT-5 verifyDownload fails a file that is not listed, or whose hash is not its line', async () => {
  const k = await keypair();
  const sums = Buffer.from(`${HEX('a')}  Strand-0.1.2.AppImage\n${HEX('b')}  Strand-Setup-0.1.2.exe\n`);
  const signature = await sign(k.privateKey, sums);
  const o = { sums, signature, publicKey: k.publicKey };
  assert.deepEqual(await verifyDownload({ ...o, fileName: 'Strand-0.1.2.AppImage', fileHash: HEX('a') }), { ok: true });
  const unlisted = await verifyDownload({ ...o, fileName: 'strand_0.1.2_amd64.deb', fileHash: HEX('a') });
  assert.equal(unlisted.ok, false);
  assert.match((unlisted as { reason: string }).reason, /not listed/);
  const wrong = await verifyDownload({ ...o, fileName: 'Strand-0.1.2.AppImage', fileHash: HEX('b') });
  assert.equal(wrong.ok, false);
  assert.match((wrong as { reason: string }).reason, /does not match/);
});

test('sha256File hashes a file as sha256sum does', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'strand-update-'));
  try {
    const f = join(dir, 'x.bin');
    writeFileSync(f, 'hello\n');
    assert.equal(await sha256File(f), createHash('sha256').update('hello\n').digest('hex'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readyMessage names the version and says it installs on quit', () => {
  assert.equal(readyMessage('0.1.2'), 'Strand 0.1.2 is ready. It installs when you quit.');
});

// startUpdates: the wiring, with a fake updater and clock

type Listener = (...a: never[]) => void;

function fakeUpdater() {
  const listeners = new Map<string, Listener[]>();
  const calls = { checks: 0, installs: [] as [boolean, boolean][] };
  const u: UpdaterLike & { emit(ev: string, arg: unknown): void } = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    installerPath: null,
    on(ev: string, fn: Listener) {
      listeners.set(ev, [...(listeners.get(ev) ?? []), fn]);
      return u;
    },
    emit(ev: string, arg: unknown) {
      for (const fn of listeners.get(ev) ?? []) (fn as (a: unknown) => void)(arg);
    },
    checkForUpdates: async () => {
      calls.checks++;
      return null;
    },
    quitAndInstall(isSilent: boolean, isForceRunAfter: boolean) {
      calls.installs.push([isSilent, isForceRunAfter]);
    },
  };
  return { u, calls };
}

function fakeClock() {
  const timers: { fn: () => void; ms: number; repeat: boolean }[] = [];
  return {
    timers,
    clock: {
      setTimeout: (fn: () => void, ms: number) => void timers.push({ fn, ms, repeat: false }),
      setInterval: (fn: () => void, ms: number) => void timers.push({ fn, ms, repeat: true }),
    },
  };
}

const settle = () => new Promise((r) => setImmediate(r));

async function harness(o: { verdict?: boolean; fileHash?: string } = {}) {
  const k = await keypair();
  const sums = Buffer.from(`${HEX('a')}  Strand-0.1.2.AppImage\n`);
  const goodSig = await sign(k.privateKey, sums);
  const other = await keypair();
  const badSig = await sign(other.privateKey, sums);
  const { u, calls } = fakeUpdater();
  const { timers, clock } = fakeClock();
  const fetched: string[] = [];
  const removed: string[] = [];
  const logs: string[] = [];
  const verified: string[] = [];
  const deps: UpdateDeps = {
    updater: u,
    publicKey: k.publicKey,
    fetchBytes: async (url) => {
      fetched.push(url);
      if (url.endsWith('/SHA256SUMS')) return sums;
      if (url.endsWith('/SHA256SUMS.asc')) return Buffer.from(o.verdict === false ? badSig : goodSig);
      throw new Error(`unexpected ${url}`);
    },
    hashFile: async () => o.fileHash ?? HEX('a'),
    removeFile: async (p) => void removed.push(p),
    log: (l) => void logs.push(l),
    onVerified: (v) => void verified.push(v),
    clock,
  };
  return { u, calls, timers, fetched, removed, logs, verified, deps };
}

function download(u: { emit(ev: string, arg: unknown): void; installerPath?: string | null }, version: string, file: string) {
  u.installerPath = file;
  u.emit('update-downloaded', { version, downloadedFile: file });
}

test('AT-6 startUpdates does nothing when the app is not packaged or STRAND_NO_UPDATE is set', async () => {
  for (const o of [{ isPackaged: false, env: {} }, { isPackaged: true, env: { STRAND_NO_UPDATE: '1' } }]) {
    const h = await harness();
    assert.equal(startUpdates({ ...o, deps: h.deps }), undefined);
    assert.equal(h.timers.length, 0, 'no timer');
    assert.equal(h.calls.checks, 0, 'no check');
    assert.equal(h.u.autoDownload, false, 'the updater is left alone');
  }
});

test('startUpdates sets the updater up, checks 30 s after start and every 6 h after', async () => {
  const h = await harness();
  assert.ok(startUpdates({ isPackaged: true, env: {}, deps: h.deps }));
  assert.equal(h.u.autoDownload, true);
  assert.equal(h.u.autoInstallOnAppQuit, false);
  assert.equal(h.u.allowPrerelease, false);
  assert.equal(h.calls.checks, 0, 'not at once');
  assert.equal(CHECK_DELAY_MS, 30_000);
  assert.equal(CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);
  assert.deepEqual(h.timers.map((t) => [t.ms, t.repeat]), [[CHECK_DELAY_MS, false], [CHECK_INTERVAL_MS, true]]);
  h.timers[0].fn();
  h.timers[1].fn();
  assert.equal(h.calls.checks, 2);
});

test('a failed check is logged and the next interval checks again', async () => {
  const h = await harness();
  let n = 0;
  h.u.checkForUpdates = async () => {
    n++;
    throw new Error('getaddrinfo ENOTFOUND github.com');
  };
  startUpdates({ isPackaged: true, env: {}, deps: h.deps });
  h.timers[0].fn();
  await settle();
  h.u.emit('error', new Error('getaddrinfo ENOTFOUND github.com'));
  h.timers[1].fn();
  await settle();
  assert.equal(n, 2);
  assert.ok(h.logs.some((l) => /ENOTFOUND/.test(l)));
});

test('AT-5 a verified download fetches SHA256SUMS from its own release and is marked for install', async () => {
  const h = await harness();
  const updates = startUpdates({ isPackaged: true, env: {}, deps: h.deps })!;
  download(h.u, '0.1.2', '/cache/pending/Strand-0.1.2.AppImage');
  await updates.settled();
  assert.deepEqual(h.fetched, [
    'https://github.com/kumihimo/strand/releases/download/v0.1.2/SHA256SUMS',
    'https://github.com/kumihimo/strand/releases/download/v0.1.2/SHA256SUMS.asc',
  ]);
  assert.equal(updates.verified(), '0.1.2');
  assert.deepEqual(h.verified, ['0.1.2']);
  assert.deepEqual(h.removed, []);
});

test('AT-5 a bad signature deletes the download, logs why and never installs', async () => {
  const h = await harness({ verdict: false });
  const updates = startUpdates({ isPackaged: true, env: {}, deps: h.deps })!;
  download(h.u, '0.1.2', '/cache/pending/Strand-0.1.2.AppImage');
  await updates.settled();
  assert.equal(updates.verified(), undefined);
  assert.deepEqual(h.verified, []);
  assert.deepEqual(h.removed, ['/cache/pending/Strand-0.1.2.AppImage']);
  assert.ok(h.logs.some((l) => /signature/.test(l)));
  assert.equal(h.u.autoInstallOnAppQuit, false);
  updates.onQuit(0);
  assert.deepEqual(h.calls.installs, []);
});

test('AT-5 a file whose hash is not its SHA256SUMS line is deleted and never installed', async () => {
  const h = await harness({ fileHash: HEX('c') });
  const updates = startUpdates({ isPackaged: true, env: {}, deps: h.deps })!;
  download(h.u, '0.1.2', '/cache/pending/Strand-0.1.2.AppImage');
  await updates.settled();
  assert.equal(updates.verified(), undefined);
  assert.deepEqual(h.removed, ['/cache/pending/Strand-0.1.2.AppImage']);
  updates.onQuit(0);
  assert.deepEqual(h.calls.installs, []);
});

test('AT-5 a fetch that fails, or a version that is not plain, leaves the update unmarked', async () => {
  const h = await harness();
  h.deps.fetchBytes = async () => {
    throw new Error('HTTP 404');
  };
  const updates = startUpdates({ isPackaged: true, env: {}, deps: h.deps })!;
  download(h.u, '0.1.2', '/cache/pending/Strand-0.1.2.AppImage');
  await updates.settled();
  assert.equal(updates.verified(), undefined);
  assert.ok(h.logs.some((l) => /404/.test(l)));
  download(h.u, '../../x', '/cache/pending/Strand-0.1.2.AppImage');
  await updates.settled();
  assert.equal(updates.verified(), undefined);
  updates.onQuit(0);
  assert.deepEqual(h.calls.installs, []);
});

test('AT-7 a verified update never quits or restarts by itself; a user quit installs it silently, no relaunch', async () => {
  const h = await harness();
  const updates = startUpdates({ isPackaged: true, env: {}, deps: h.deps })!;
  download(h.u, '0.1.2', '/cache/pending/Strand-0.1.2.AppImage');
  await updates.settled();
  for (const t of h.timers) t.fn();
  await settle();
  assert.deepEqual(h.calls.installs, [], 'nothing installs before the user quits');
  updates.onQuit(0);
  assert.deepEqual(h.calls.installs, [[true, false]]);
  updates.onQuit(0);
  assert.equal(h.calls.installs.length, 1, 'once');
});

test('AT-7 Restart to update installs on the quit and relaunches; a cancelled quit drops the relaunch', async () => {
  const h = await harness();
  const updates = startUpdates({ isPackaged: true, env: {}, deps: h.deps })!;
  assert.equal(updates.restartToUpdate(), false, 'nothing to restart for yet');
  download(h.u, '0.1.2', '/cache/pending/Strand-0.1.2.AppImage');
  await updates.settled();
  assert.equal(updates.restartToUpdate(), true);
  assert.deepEqual(h.calls.installs, [], 'the caller quits the app; the updater does not');
  updates.cancelRestart();
  updates.onQuit(0);
  assert.deepEqual(h.calls.installs, [[true, false]]);

  const h2 = await harness();
  const u2 = startUpdates({ isPackaged: true, env: {}, deps: h2.deps })!;
  download(h2.u, '0.1.2', '/cache/pending/Strand-0.1.2.AppImage');
  await u2.settled();
  u2.restartToUpdate();
  u2.onQuit(0);
  assert.deepEqual(h2.calls.installs, [[true, true]]);
});

test('AT-7 a quit with a non-zero exit code, or an installer that is not the verified file, installs nothing', async () => {
  const h = await harness();
  const updates = startUpdates({ isPackaged: true, env: {}, deps: h.deps })!;
  download(h.u, '0.1.2', '/cache/pending/Strand-0.1.2.AppImage');
  await updates.settled();
  updates.onQuit(1);
  assert.deepEqual(h.calls.installs, []);
  (h.u as { installerPath: string }).installerPath = '/cache/pending/other.AppImage';
  updates.onQuit(0);
  assert.deepEqual(h.calls.installs, []);
});

test('a new download unmarks the verified one at once, and a stale verification never marks it', async () => {
  const h = await harness();
  const updates = startUpdates({ isPackaged: true, env: {}, deps: h.deps })!;
  download(h.u, '0.1.2', '/cache/pending/Strand-0.1.2.AppImage');
  await updates.settled();
  assert.equal(updates.verified(), '0.1.2');
  h.deps.fetchBytes = () => new Promise(() => {}); // the new release's files never arrive
  download(h.u, '0.1.3', '/cache/pending/Strand-0.1.3.AppImage');
  assert.equal(updates.verified(), undefined, 'unmarked as soon as the new file lands');
  updates.onQuit(0);
  assert.deepEqual(h.calls.installs, [], 'the unverified new file is never installed');
});
