// The app is Strand (ADR 0021): no shipped file still calls it sdlc, outside the read-old fallbacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/** What ships or is read as current: code, plugin, installer, scripts and the live docs. Tests and history are out. */
const SHIPPED = [
  'src', 'ui', 'commands', 'skills', 'hooks', '.claude-plugin', 'installer', 'scripts',
  'README.md', 'AGENTS.md', 'CLAUDE.md', 'package.json',
  'docs/architecture', 'docs/design', 'docs/roadmap.md', 'docs/known-issues.md', 'docs/cutover-checklist.md',
];
const SKIP_DIRS = new Set(['node_modules', 'dist']);

/**
 * An old name: any lowercase `sdlc` (command, path, plugin prefix, folder, service, cookie), an `SDLC_` env var,
 * `$SDLC`, or "SDLC bead/cockpit". "SDLC" alone names the concept (software development lifecycle) and is fine.
 */
const OLD = /sdlc|SDLC_|\$SDLC|SDLC (?:bead|[Cc]ockpit)/;

/** The fallback code that must name the old state, as exact text per file. */
const ALLOWED: Record<string, string[]> = {
  'src/core/config.ts': ["LEGACY_ENV_PREFIX = 'SDLC_'", '`SDLC_<X>`', "userConfigFile(platform, env, home, 'sdlc')", 'SDLC_*', '`sdlc/config.json`', 'sdlc/'],
  'src/core/secrets.ts': ["LEGACY_SERVICE = 'sdlc'", 'SDLC_GITEA_TOKEN', '`sdlc`'],
  'src/core/snapshot.ts': ['`sdlc-`'],
  'src/core/state.ts': ["LEGACY_STATE_DIR = '.sdlc'", '`.sdlc/`'],
  'src/core/binding.ts': ['`.sdlc/`'],
  'src/core/sessions.ts': ['`.sdlc/`'],
  'src/hooks/parse.ts': ["LEGACY_CLI = 'sdlc'", 'sdlc.ts'],
  'src/hooks/prompt.ts': ['sdlc:', '`/sdlc:work <id>`'],
  'src/hooks/runtime.ts': ['`sdlc work`', 'SDLC_BEAD_ID', 'SDLC_SPEC_FORMAT'],
  'src/cli/strand.ts': ['SDLC_*'],
  'installer/setup.ts': ["LEGACY_PLUGIN = 'sdlc@sdlc-cockpit'", "LEGACY_MARKETPLACE = 'sdlc-cockpit'", "'.sdlc/'", '.pre-sdlc', 'sdlc@sdlc-cockpit'],
  'ui/vite.config.ts': ['SDLC_COCKPIT_URL'],
};

/** Links to accepted ADRs and RFCs, whose file names are history and stay as they are. */
const HISTORY_LINKS = ['0001-sdlc-system.md', '0017-terminals-run-only-sdlc-work.md'];

/** In docs a line about the rename, or any line in a section about it, names the old state on purpose. */
const DOC_LINE_OK = /rename|ADR 0021|pre-Strand/i;
const DOC_SECTION_OK = /^#+ .*(?:renam|ADR 0021)/i;

function files(rel: string): string[] {
  const abs = join(ROOT, rel);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return [];
  }
  if (!st.isDirectory()) return [rel];
  return readdirSync(abs, { withFileTypes: true })
    .filter((d) => !SKIP_DIRS.has(d.name))
    .flatMap((d) => files(relative(ROOT, join(abs, d.name)).replace(/\\/g, '/')));
}

const all = SHIPPED.flatMap(files);

test('no shipped file or folder is named after sdlc', () => {
  assert.deepEqual(all.filter((f) => /sdlc/i.test(f)), []);
});

test('no shipped file names the app sdlc outside the allowed fallback text', () => {
  const hits: string[] = [];
  for (const f of all) {
    const isDoc = f.endsWith('.md') || f.startsWith('docs/');
    let inRenameSection = false;
    readFileSync(join(ROOT, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (isDoc && /^#+ /.test(line)) inRenameSection = DOC_SECTION_OK.test(line);
      if (inRenameSection) return;
      let rest = line;
      for (const ok of [...HISTORY_LINKS, ...(ALLOWED[f] ?? [])]) rest = rest.split(ok).join('');
      if (!OLD.test(rest)) return;
      if (isDoc && DOC_LINE_OK.test(line)) return;
      hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('the sweep does look at the shipped tree', () => {
  for (const f of ['src/cli/strand.ts', 'skills/strand-work/SKILL.md', '.claude-plugin/plugin.json', 'README.md']) {
    assert.ok(all.includes(f), f);
  }
});
