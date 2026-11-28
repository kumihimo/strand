import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const build = pkg.build;

function targets(t: unknown): { target: string; arch: string[] }[] {
  const list = Array.isArray(t) ? t : [t];
  return list.map((x) => (typeof x === 'string' ? { target: x, arch: [] } : x));
}

test('Windows builds a per-user NSIS installer for x64 that shows the install folder', () => {
  assert.deepEqual(targets(build.win.target), [{ target: 'nsis', arch: ['x64'] }]);
  assert.equal(build.nsis.oneClick, false);
  assert.equal(build.nsis.perMachine, false);
  assert.equal(build.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(build.nsis.artifactName, '${productName}-Setup-${version}.${ext}');
});

test('Linux builds a .deb and an AppImage for x64, with a maintainer for the .deb', () => {
  assert.deepEqual(targets(build.linux.target), [
    { target: 'deb', arch: ['x64'] },
    { target: 'AppImage', arch: ['x64'] },
  ]);
  assert.match(build.linux.maintainer, /^The Strand Authors <[^>]+>$/);
  assert.equal(build.appImage.artifactName, '${productName}-${version}.${ext}');
});

test('the packaging config names the GitHub release feed for the updater, but no build publishes', () => {
  assert.deepEqual(build.publish, { provider: 'github', owner: 'kumihimo', repo: 'strand' });
  for (const name of ['dist:win:unpacked', 'dist:win:installer', 'dist:linux']) {
    assert.match(pkg.scripts[name], /--publish never/, `${name} passes --publish never`);
  }
});

test('the release key is packaged into the app, for the updater to verify SHA256SUMS.asc', () => {
  assert.ok(build.files.includes('RELEASE-KEY.asc'));
});

const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const job = (name: string) => {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name}`);
  const next = workflow.slice(start + 1).search(/\n  [a-z]+:\n/);
  return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
};

test('AT-1 the release workflow carries the update feed files from the builds to the draft release', () => {
  const linux = job('linux');
  assert.match(linux, /release\/latest-linux\.yml/);
  const windows = job('windows');
  assert.match(windows, /release\/latest\.yml/);
  assert.match(windows, /release\/Strand-Setup-\$\{\{ env\.VERSION \}\}\.exe\.blockmap/);
  for (const name of ['checksums', 'publish']) {
    const j = job(name);
    for (const f of [/latest\.yml/, /latest-linux\.yml/, /\.exe\.blockmap/]) assert.match(j, f, `${name} carries ${f}`);
  }
});

test('the dist scripts build the unpacked tree, then the installer over it, and the Linux packages', () => {
  assert.match(pkg.scripts['dist:win:unpacked'], /electron-builder --win --x64 --dir\b/);
  assert.match(pkg.scripts['dist:win:installer'], /electron-builder --win nsis --x64 --prepackaged release[/\\]win-unpacked\b/);
  assert.match(pkg.scripts['dist:linux'], /electron-builder --linux deb AppImage --x64\b/);
  assert.match(pkg.scripts.package, /electron-builder --dir\b/, 'npm run package stays the dev build');
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test('no code or build option turns off the Chromium sandbox', () => {
  const flag = 'no-' + 'sandbox';
  assert.ok(!JSON.stringify(build).includes(flag), 'build options');
  assert.ok(!JSON.stringify(pkg.scripts).includes(flag), 'scripts');
  for (const f of [...walk(join(root, 'electron')), ...walk(join(root, 'src'))]) {
    assert.ok(!readFileSync(f, 'utf8').includes(flag), f);
  }
});
