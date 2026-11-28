import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { electronNoticeDir, licencesPage, readNotices, type Notice } from '../electron/licences.ts';

const manifest = readFileSync(path.join(import.meta.dirname, '..', 'vendor', 'manifest.json'), 'utf8');
const CHROMIUM = 'file:///opt/Strand/LICENSES.chromium.html';

const hostile: Notice[] = [
  { name: 'Evil <script>alert(1)</script>', licence: 'MIT', text: '</pre><img src="https://x.test/p.png"><script>fetch("https://x.test")</script>' },
  { name: 'Quotes', version: '1"><a href="javascript:alert(1)">', licence: "GPL'", text: '&amp; <style>@import url(https://x.test/a.css)</style>', homepage: 'javascript:alert(1)' },
];

/** Every tag in the page, so the checks below look at markup and never at escaped text. */
const tags = (html: string) => html.match(/<[a-zA-Z][^>]*>/g) ?? [];

test('AT-9 licencesPage escapes every text it is given', () => {
  const html = licencesPage(hostile, { chromiumUrl: CHROMIUM });
  assert.ok(!html.includes('<script'), 'no script tag');
  assert.ok(!html.includes('<img'), 'no img tag');
  assert.ok(!html.includes('<style>@import'), 'no injected style');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;/pre&gt;&lt;img src=&quot;https://x.test/p.png&quot;&gt;'));
  assert.ok(html.includes('&amp;amp;'), 'an ampersand is escaped once more');
  assert.ok(!tags(html).some((t) => /javascript:/i.test(t)), 'a javascript: homepage is not linked');
});

test('AT-9 licencesPage loads nothing: a default-src none CSP, no scripts, no sources, links only to https and the Chromium notices', () => {
  const html = licencesPage(hostile, { chromiumUrl: CHROMIUM });
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">/);
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<style'), 'the CSP comes before any style');
  for (const t of tags(html)) {
    assert.doesNotMatch(t, /^<(script|img|link|iframe|object|embed|frame|base|form|video|audio|source)\b/i, t);
    assert.doesNotMatch(t, /\s(src|srcset|action|background|poster)=/i, t);
    const href = /\shref="([^"]*)"/.exec(t)?.[1];
    if (href !== undefined) assert.ok(href.startsWith('https://') || href === CHROMIUM, href);
  }
  const styles = html.match(/<style>[\s\S]*?<\/style>/g) ?? [];
  assert.equal(styles.length, 1);
  assert.doesNotMatch(styles[0]!, /url\(|@import/);
});

test('AT-8 readNotices lists Strand, Electron, Chromium, Node, bd and git from the bundled files, with git\'s source offer', () => {
  const files: Record<string, string> = {
    [path.join('/app', 'LICENSE')]: 'Apache License 2.0',
    [path.join('/app', 'NOTICE')]: 'Strand NOTICE',
    [path.join('/app', 'vendor', 'node', 'LICENSE')]: 'Node MIT',
    [path.join('/app', 'vendor', 'bd', 'LICENSE')]: 'bd MIT',
    [path.join('/app', 'vendor', 'git', 'COPYING')]: 'GPL v2 text',
    [path.join('/exe', 'LICENSE.electron.txt')]: 'Electron MIT',
  };
  const notices = readNotices({
    appRoot: '/app',
    electronDir: '/exe',
    manifest,
    platform: 'linux',
    versions: { strand: '0.2.0', electron: '45.5.0', chromium: '140.0' },
    read: (p) => files[p],
  });
  assert.deepEqual(
    notices.map((n) => n.name),
    ['Strand', 'Electron', 'Chromium', 'Node.js', 'Beads (bd)', 'Git'],
  );
  const by = (n: string) => notices.find((x) => x.name === n)!;
  assert.equal(by('Strand').text, 'Apache License 2.0\n\nStrand NOTICE');
  assert.equal(by('Strand').licence, 'Apache-2.0');
  assert.equal(by('Electron').text, 'Electron MIT');
  assert.equal(by('Node.js').version, '24.22.3');
  assert.equal(by('Beads (bd)').text, 'bd MIT');
  const git = by('Git');
  assert.equal(git.licence, 'GPL-2.0-only');
  assert.equal(git.text, 'GPL v2 text');
  const offer = git.offer!.join('\n');
  assert.match(offer, /git v2\.56\.1/);
  assert.match(offer, /dugite-native v2\.56\.1/);
  assert.match(offer, /three years/);
  assert.ok(git.links!.some((l) => l.url === 'https://github.com/git/git/tree/v2.56.1'));
  assert.ok(git.links!.some((l) => l.url === 'https://github.com/desktop/dugite-native/tree/v2.56.1'));
  assert.ok(!git.links!.some((l) => l.url.includes('git-for-windows')), 'Git for Windows only on Windows');
});

test('AT-8 on Windows git names the Git for Windows tag and its licence file', () => {
  const files: Record<string, string> = { [path.join('C:/app', 'vendor', 'git', 'LICENSE.txt')]: 'GfW licence', [path.join('C:/app', 'vendor', 'git', 'COPYING')]: 'GPL' };
  const notices = readNotices({ appRoot: 'C:/app', electronDir: 'C:/exe', manifest, platform: 'win32', versions: { strand: '1', electron: '1', chromium: '1' }, read: (p) => files[p] });
  const git = notices.find((n) => n.name === 'Git')!;
  assert.match(git.offer!.join('\n'), /Git for Windows v2\.56\.1\.windows\.1/);
  assert.ok(git.links!.some((l) => l.url === 'https://github.com/git-for-windows/git/tree/v2.56.1.windows.1'));
  assert.match(git.text, /GPL[\s\S]*GfW licence/);
});

test('a notice file that is missing says so instead of failing the window', () => {
  const notices = readNotices({ appRoot: '/a', electronDir: '/e', manifest, platform: 'linux', versions: { strand: '1', electron: '1', chromium: '1' }, read: () => undefined });
  assert.equal(notices.length, 6);
  for (const n of notices.filter((x) => x.name !== 'Chromium')) assert.match(n.text, /not found/);
});

test('electronNoticeDir is beside the executable when packaged and Electron\'s dist folder in a checkout', () => {
  assert.equal(electronNoticeDir({ packaged: true, execPath: '/opt/Strand/strand', appRoot: '/opt/Strand/resources/app' }), '/opt/Strand');
  assert.equal(electronNoticeDir({ packaged: false, execPath: '/x/electron', appRoot: '/src/strand' }), path.join('/src/strand', 'node_modules', 'electron', 'dist'));
});

test('AT-9 the licences window opens only the Chromium notices in place, https links outside, and nothing else', async () => {
  const { licencesNavigation, licencesRequestAllowed } = await import('../electron/licences.ts');
  assert.deepEqual(licencesNavigation(CHROMIUM, CHROMIUM), { allow: true });
  assert.deepEqual(licencesNavigation('https://github.com/git/git/tree/v2.56.1', CHROMIUM), { allow: false, external: 'https://github.com/git/git/tree/v2.56.1' });
  for (const u of ['http://x.test/', 'file:///etc/passwd', 'javascript:alert(1)', 'https://u:p@x.test/', 'not a url', 'data:text/html,x']) {
    assert.deepEqual(licencesNavigation(u, CHROMIUM), { allow: false }, u);
  }
  const page = 'file:///home/u/.config/strand-desktop/licences.html';
  assert.equal(licencesRequestAllowed(page, [page, CHROMIUM]), true);
  assert.equal(licencesRequestAllowed('https://x.test/a.png', [page, CHROMIUM]), false);
  assert.equal(licencesRequestAllowed('file:///etc/passwd', [page, CHROMIUM]), false);
});
