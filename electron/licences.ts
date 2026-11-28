import path from 'node:path';

/**
 * Help > Licences (ADR 0031): the notices of Strand and of everything the app carries, built from the files
 * shipped beside them. Pure, with no `electron` import, so the tests run it under plain Node. main.ts shows the
 * page in a window of its own with JavaScript off and no network.
 */

export type Link = { label: string; url: string };
export type Notice = {
  name: string;
  version?: string;
  /** SPDX id. */
  licence: string;
  text: string;
  homepage?: string;
  links?: Link[];
  /** git's GPLv2 written offer, one paragraph per entry. */
  offer?: string[];
  /** Chromium: its notices are Electron's own HTML file, linked rather than copied in. */
  chromium?: boolean;
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Only an https URL becomes a link; anything else is dropped. */
const httpsUrl = (u: string | undefined): string | undefined => {
  if (u === undefined) return undefined;
  try {
    return new URL(u).protocol === 'https:' ? u : undefined;
  } catch {
    return undefined;
  }
};

const link = (url: string, label: string) => `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;

/**
 * The licences page. Every text is escaped; the page has no script and loads nothing (CSP `default-src 'none'`,
 * inline style only). Links go to https pages, which main opens in the default browser, and to `chromiumUrl`.
 */
export function licencesPage(notices: readonly Notice[], o: { chromiumUrl: string }): string {
  const sections = notices.map((n) => {
    const head = `<h2>${escapeHtml(n.name)}${n.version ? ` <span class="v">${escapeHtml(n.version)}</span>` : ''}</h2>`;
    const home = httpsUrl(n.homepage);
    const meta = `<p class="meta">Licence: ${escapeHtml(n.licence)}${home ? ` · ${link(home, home)}` : ''}</p>`;
    const offer = n.offer?.length ? `<div class="offer">${n.offer.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}</div>` : '';
    const links = (n.links ?? []).flatMap((l) => {
      const u = httpsUrl(l.url);
      return u ? [`<li>${link(u, l.label)}</li>`] : [];
    });
    const linkList = links.length ? `<ul>${links.join('')}</ul>` : '';
    const chromium = n.chromium ? `<p>${link(o.chromiumUrl, 'Open the Chromium licences and third-party notices')}</p>` : '';
    const text = n.text ? `<details><summary>Licence text</summary><pre>${escapeHtml(n.text)}</pre></details>` : '';
    return `<section>${head}${meta}${offer}${linkList}${chromium}${text}</section>`;
  });
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    '<title>Strand licences</title>',
    '<style>body{font:14px system-ui,sans-serif;margin:1.5rem 2rem;max-width:56rem;color:#222;background:#fff}',
    'h1{font-size:1.4rem}h2{font-size:1.1rem;margin:1.6rem 0 .2rem}.v,.meta{color:#666;font-weight:normal}',
    '.offer{border-left:3px solid #999;padding-left:.8rem}',
    'pre{background:#f4f4f4;padding:.8rem;overflow:auto;white-space:pre-wrap;font-size:12px}',
    '@media (prefers-color-scheme: dark){body{color:#ddd;background:#1b1b1b}pre{background:#2a2a2a}.v,.meta{color:#aaa}a{color:#8ab4f8}}</style>',
    '</head><body><h1>Licences</h1>',
    '<p>Strand and the tools it carries, with their licences.</p>',
    ...sections,
    '</body></html>',
  ].join('');
}

type ManifestTool = { name: string; version: string; licence: string; homepage?: string; source?: Record<string, { tag?: string; url?: string } | string> };

/** Where Electron's own LICENSE and LICENSES.chromium.html are: beside the executable once packaged. */
export function electronNoticeDir(o: { packaged: boolean; execPath: string; appRoot: string }): string {
  return o.packaged ? path.dirname(o.execPath) : path.join(o.appRoot, 'node_modules', 'electron', 'dist');
}

/** git's written source offer (GPLv2 section 3(b)), naming the exact tags this build came from. */
function gitOffer(t: ManifestTool, platform: NodeJS.Platform): { offer: string[]; links: Link[] } {
  const src = (k: string) => (typeof t.source?.[k] === 'object' ? (t.source[k] as { tag?: string; url?: string }) : undefined);
  const git = src('git');
  const dugite = src('dugiteNative');
  const gfw = platform === 'win32' ? src('gitForWindows') : undefined;
  const includes = typeof t.source?.includes === 'string' ? t.source.includes : undefined;
  const from = [`git ${git?.tag ?? t.version}`, ...(gfw?.tag ? [`Git for Windows ${gfw.tag}`] : []), `as built by dugite-native ${dugite?.tag ?? '(unknown)'}`].join(', ');
  const offer = [
    `Strand carries Git, licensed under the GNU General Public License version 2. This copy is ${from}.${includes ? ` It includes ${includes}.` : ''}`,
    'The complete corresponding source code is published at the links below.',
    'For three years from the date you received this copy of Strand, The Strand Authors will also give anyone who asks a copy of the complete corresponding source code of this Git build, on a medium customarily used for software interchange, for no more than the cost of making and sending it. Ask at https://github.com/kumihimo/strand/issues.',
  ];
  const links: Link[] = [
    ...(git?.url ? [{ label: `git ${git.tag ?? ''} source`.replace(/\s+/g, ' '), url: git.url }] : []),
    ...(gfw?.url ? [{ label: `Git for Windows ${gfw.tag ?? ''} source`, url: gfw.url }] : []),
    ...(dugite?.url ? [{ label: `dugite-native ${dugite.tag ?? ''} build scripts`, url: dugite.url }] : []),
  ];
  return { offer, links };
}

/**
 * The notices to show, read through `read` (undefined for a file that is not there): Strand's LICENSE and
 * NOTICE, Electron's licence, Chromium's notices (linked), and Node, bd and git from `vendor/` with the versions
 * pinned in the manifest. A missing file is named in place of its text, so the window still opens.
 */
export function readNotices(o: {
  appRoot: string;
  electronDir: string;
  manifest: string;
  platform: NodeJS.Platform;
  versions: { strand: string; electron: string; chromium: string };
  read: (p: string) => string | undefined;
}): Notice[] {
  const text = (...files: string[]) => {
    const found = files.map((f) => o.read(f)).filter((t): t is string => t !== undefined);
    return found.length ? found.map((t) => t.trimEnd()).join('\n\n') : `Licence file not found: ${files.join(' or ')}`;
  };
  const first = (...files: string[]) => {
    for (const f of files) {
      const t = o.read(f);
      if (t !== undefined) return t.trimEnd();
    }
    return `Licence file not found: ${files.join(' or ')}`;
  };
  let tools: Record<string, ManifestTool> = {};
  try {
    tools = (JSON.parse(o.manifest) as { tools: Record<string, ManifestTool> }).tools ?? {};
  } catch {
    tools = {};
  }
  const vendor = (k: string) => path.join(o.appRoot, 'vendor', k);
  const strandLicence = o.read(path.join(o.appRoot, 'LICENSE'));
  const strandNotice = o.read(path.join(o.appRoot, 'NOTICE'));
  const notices: Notice[] = [
    {
      name: 'Strand',
      version: o.versions.strand,
      licence: 'Apache-2.0',
      homepage: 'https://github.com/kumihimo/strand',
      text:
        strandLicence === undefined && strandNotice === undefined
          ? `Licence file not found: ${path.join(o.appRoot, 'LICENSE')}`
          : [strandLicence, strandNotice].filter((t): t is string => t !== undefined).map((t) => t.trimEnd()).join('\n\n'),
    },
    {
      name: 'Electron',
      version: o.versions.electron,
      licence: 'MIT',
      homepage: 'https://www.electronjs.org/',
      text: first(path.join(o.electronDir, 'LICENSE.electron.txt'), path.join(o.electronDir, 'LICENSE')),
    },
    { name: 'Chromium', version: o.versions.chromium, licence: 'BSD-3-Clause and others', homepage: 'https://www.chromium.org/', text: '', chromium: true },
  ];
  const tool = (k: string, files: string[]) => {
    const t = tools[k];
    if (!t) return;
    notices.push({ name: t.name, version: t.version, licence: t.licence, ...(t.homepage ? { homepage: t.homepage } : {}), text: text(...files.map((f) => path.join(vendor(k), f))) });
  };
  tool('node', ['LICENSE']);
  tool('bd', ['LICENSE']);
  tool('git', o.platform === 'win32' ? ['COPYING', 'LICENSE.txt'] : ['COPYING']);
  const git = notices.find((n) => n.name === tools.git?.name);
  if (git && tools.git) Object.assign(git, gitOffer(tools.git, o.platform));
  return notices;
}

/**
 * What the licences window does with a navigation: the Chromium notices open in place, an https link goes to
 * the default browser, and anything else is dropped. Fail closed on what does not parse.
 */
export function licencesNavigation(url: string, chromiumUrl: string): { allow: boolean; external?: string } {
  if (url === chromiumUrl) return { allow: true };
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.username === '' && u.password === '' ? { allow: false, external: u.href } : { allow: false };
  } catch {
    return { allow: false };
  }
}

/** The licences window's session fetches only its own page and the Chromium notices: never the network. */
export function licencesRequestAllowed(url: string, pages: readonly string[]): boolean {
  return pages.includes(url);
}
