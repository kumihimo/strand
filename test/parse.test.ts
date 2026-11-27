import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GLOBAL_VALUE_FLAGS, UPDATE_VALUE_FLAGS, flagValue, flagValues, parseCommands, positional } from '../src/hooks/parse.ts';

const rows: Array<[string, string, string[][]]> = [
  ['plain but commit', 'but commit --branch a/b -m "x"', [['but', 'commit', '--branch', 'a/b', '-m', 'x']]],
  [
    'cd hides a command, message keeps the semicolon',
    "cd repo && but commit -b a/b -m 'fix; thing'",
    [['but', 'commit', '-b', 'a/b', '-m', 'fix; thing']],
  ],
  ['VAR=x then env', 'FOO=1 env git commit -m x', [['git', 'commit', '-m', 'x']]],
  ['env with assignment', 'env A=1 git commit -m x', [['git', 'commit', '-m', 'x']]],
  ['time and command prefixes', 'time command git status', [['git', 'status']]],
  [
    'heredoc body is data',
    "git commit -F - <<'EOF'\ngit commit -m sub-abc\nEOF\necho done",
    [['git', 'commit', '-F', '-', '<<EOF']],
  ],
  ['heredoc with only a body command', "cat <<EOF\ngit commit -m sub-abc\nEOF", []],
  ['command after a heredoc', 'cat <<-EOF\n\tbut push\n\tEOF\nbd ready', [['bd', 'ready']]],
  ['here-string is not a heredoc', 'cat <<<hi\ngit status', [['git', 'status']]],
  ['pipe', 'bd update sub-1 --claim | cat', [['bd', 'update', 'sub-1', '--claim']]],
  ['subshell', '(git switch -c a/b)', [['git', 'switch', '-c', 'a/b']]],
  ['two commands', 'git add x; git commit -m y', [['git', 'add', 'x'], ['git', 'commit', '-m', 'y']]],
  ['newline separates', 'git add x\nbut status', [['git', 'add', 'x'], ['but', 'status']]],
  ['CRLF separates', 'git add x\r\nbut status', [['git', 'add', 'x'], ['but', 'status']]],
  ['newline in a quoted message', 'git commit -m "a\nb"', [['git', 'commit', '-m', 'a ; b']]],
  ['comment ends at newline', 'git status # note; git push\nbd ready', [['git', 'status'], ['bd', 'ready']]],
  ['other first word ends command start', 'echo git commit', []],
  ['unquoted windows path', 'C:\\tools\\but.exe branch new a/b', [['but', 'branch', 'new', 'a/b']]],
  ['quoted windows path', '"C:\\tools\\but.exe" branch new a/b', [['but', 'branch', 'new', 'a/b']]],
  ['quoted git.exe with spaces', '"C:\\Program Files\\Git\\cmd\\git.exe" status', [['git', 'status']]],
  ['bd.exe upper case', 'C:\\x\\BD.EXE ready', [['bd', 'ready']]],
  ['posix path', '/usr/bin/git log', [['git', 'log']]],
  ['strand binary', 'strand approve sub-1', [['strand', 'approve', 'sub-1']]],
  ['strand.exe', 'C:\\bin\\strand.exe approve sub-1', [['strand', 'approve', 'sub-1']]],
  ['strand.cmd (npm link shim)', 'strand.cmd none', [['strand', 'none']]],
  ['strand.ps1 (npm link shim)', 'C:\\npm\\strand.ps1 none', [['strand', 'none']]],
  ['legacy sdlc binary reads as strand', 'sdlc approve sub-1', [['strand', 'approve', 'sub-1']]],
  ['legacy sdlc.cmd shim reads as strand', 'C:\\npm\\sdlc.cmd none', [['strand', 'none']]],
  ['legacy node sdlc.ts reads as strand', 'node "C:/x/src/cli/sdlc.ts" approve sub-1', [['strand', 'approve', 'sub-1']]],
  ['but.cmd', 'but.cmd commit -m x', [['but', 'commit', '-m', 'x']]],
  ['bd.bat upper case', 'BD.BAT ready', [['bd', 'ready']]],
  ['other extension is not stripped', 'but.txt commit', []],
  ['node strand.ts quoted', 'node "C:/x/src/cli/strand.ts" approve sub-1', [['strand', 'approve', 'sub-1']]],
  [
    'node strand.ts with plugin root',
    'node "${CLAUDE_PLUGIN_ROOT}/src/cli/strand.ts" status --json',
    [['strand', 'status', '--json']],
  ],
  ['node strand.ts windows path', 'node "C:\\x\\src\\cli\\strand.ts" approve sub-1', [['strand', 'approve', 'sub-1']]],
  ['node with flag', 'node --no-warnings src/cli/strand.ts approve x', [['strand', 'approve', 'x']]],
  ['node other script', 'node build.ts git commit', []],
  ['quoted separator is a word', 'git commit -m ";"', [['git', 'commit', '-m', ';']]],
  ['double quote escapes', 'git commit -m "say \\"hi\\""', [['git', 'commit', '-m', 'say "hi"']]],
  ['empty line', '', []],
  ['bd -C dir', 'bd -C "C:/dev/beads" update sub-1 --claim', [['bd', 'update', 'sub-1', '--claim']]],
  ['bd -C dir with a space', 'bd -C "C:/My Beads/db" close sub-1', [['bd', 'close', 'sub-1']]],
  ['bd --db and -q', 'bd --db x.db -q close sub-1', [['bd', 'close', 'sub-1']]],
  [
    'bd --directory= form',
    'bd --directory=C:/t update sub-1 --acceptance "- [ ] a (check: b)"',
    [['bd', 'update', 'sub-1', '--acceptance', '- [ ] a (check: b)']],
  ],
  ['bd many globals', 'bd --actor me --dolt-auto-commit=on --json --readonly -v list', [['bd', 'list']]],
  ['bd flag after subcommand stays', 'bd update sub-1 --json', [['bd', 'update', 'sub-1', '--json']]],
  ['bd -C after subcommand stays', 'bd update -C d sub-1', [['bd', 'update', '-C', 'd', 'sub-1']]],
  ['git -C and -c', 'git -C repo -c user.name=x commit -m y', [['git', 'commit', '-m', 'y']]],
  ['git --no-pager -C', 'git --no-pager -C repo checkout -b a/b', [['git', 'checkout', '-b', 'a/b']]],
  ['git --git-dir= form', 'git --git-dir=.git --bare status', [['git', 'status']]],
  ['git -p after subcommand stays', 'git log -p', [['git', 'log', '-p']]],
  ['but -C', 'but -C repo commit --branch a/b -m y', [['but', 'commit', '--branch', 'a/b', '-m', 'y']]],
  ['but --current-dir and --json', 'but --json --current-dir repo status', [['but', 'status']]],
  ['globals through bash -c', 'bash -c "bd -C d close x"', [['bd', 'close', 'x']]],
  ['env -u skips its value', 'env -u BEADS_DIR git commit -m x', [['git', 'commit', '-m', 'x']]],
  ['env -i with assignment', 'env -i A=1 git status', [['git', 'status']]],
  ['sudo -u', 'sudo -u bob git status', [['git', 'status']]],
  ['command -v is not a git call', 'command -v git', []],
  ['if then fi', 'if x; then git commit -m y; fi', [['git', 'commit', '-m', 'y']]],
  ['for do done', 'for f in a b; do but commit -b a/b -m y; done', [['but', 'commit', '-b', 'a/b', '-m', 'y']]],
  ['while do done', 'while true; do bd close x; done', [['bd', 'close', 'x']]],
  ['negation and braces', '! git diff --quiet || { git commit -m z; }', [['git', 'diff', '--quiet'], ['git', 'commit', '-m', 'z']]],
  ['exec, nohup, builtin', 'nohup git push; exec but status; builtin command bd ready', [['git', 'push'], ['but', 'status'], ['bd', 'ready']]],
  ['bash -c', 'bash -c "git commit -m x"', [['git', 'commit', '-m', 'x']]],
  ['sh -lc', "sh -lc 'cd r && but commit -b a/b -m y'", [['but', 'commit', '-b', 'a/b', '-m', 'y']]],
  ['pwsh -Command', 'pwsh -NoProfile -Command "git commit -m x"', [['git', 'commit', '-m', 'x']]],
  ['powershell -c unquoted', 'powershell -c git commit -m x', [['git', 'commit', '-m', 'x']]],
  ['xargs', 'echo a | xargs -n1 git commit -m', [['git', 'commit', '-m']]],
  ['$( ) substitution', 'echo $(git commit -m x)', [['git', 'commit', '-m', 'x']]],
  ['backtick substitution', 'echo `bd close x`', [['bd', 'close', 'x']]],
  ['quoted << is not a heredoc', 'git commit -m "a << b"\ngit commit -m x', [['git', 'commit', '-m', 'a << b'], ['git', 'commit', '-m', 'x']]],
  ['quoted 1<<2', 'echo "1<<2"\ngit commit -m x', [['git', 'commit', '-m', 'x']]],
  ['real heredoc still hides body', 'cat <<EOF\ngit push\nEOF\ngit status', [['git', 'status']]],
  ['backslash CRLF continuation', 'but commit \\\r\n-b a/b -m x', [['but', 'commit', '-b', 'a/b', '-m', 'x']]],
  ['powershell backtick continuation', 'but commit `\r\n-b a/b -m x', [['but', 'commit', '-b', 'a/b', '-m', 'x']]],
  ['powershell backtick LF continuation', 'but commit `\n-b a/b -m x', [['but', 'commit', '-b', 'a/b', '-m', 'x']]],
  ['2>&1 does not split', 'git commit 2>&1 -m x', [['git', 'commit', '2>&1', '-m', 'x']]],
  ['&> does not split', 'git commit &>out -m x', [['git', 'commit', '&>out', '-m', 'x']]],
  ['>&2 does not split', 'git commit >&2 -m x', [['git', 'commit', '>&2', '-m', 'x']]],
  ['node -r value', 'node -r x strand.ts approve y', [['strand', 'approve', 'y']]],
  ['node --import value', 'node --import x src/cli/strand.ts approve y', [['strand', 'approve', 'y']]],
  ['node -e is not a script', 'node -e "1" strand.ts approve y', []],
];

for (const [name, line, expected] of rows) {
  test(`parseCommands: ${name}`, () => {
    assert.deepEqual(parseCommands(line), expected);
  });
}

test('parseCommands: an unbalanced quote does not throw', () => {
  assert.doesNotThrow(() => parseCommands('git commit -m "oops'));
  assert.deepEqual(parseCommands('git commit -m "oops'), [['git', 'commit', '-m', '"oops']]);
  assert.deepEqual(parseCommands("cd x && but commit -m 'oops"), [['but', 'commit', '-m', "'oops"]]);
});

test('flagValue reads a flag, its = form, and reports absence', () => {
  const args = ['commit', '-b', 'a/b', '--message=hi'];
  assert.equal(flagValue(args, ['-b', '--branch']), 'a/b');
  assert.equal(flagValue(args, ['-m', '--message']), 'hi');
  assert.equal(flagValue(args, ['-A']), undefined);
  assert.equal(flagValue(['-b'], ['-b']), '');
});

test('flagValues returns every value', () => {
  assert.deepEqual(flagValues(['-m', 'a', '-m', 'b', '--message=c'], ['-m', '--message']), ['a', 'b', 'c']);
  assert.deepEqual(flagValues(['x'], ['-m']), []);
});

test('positional skips flags and the values of value flags', () => {
  assert.equal(positional(['new', '-A', 'p/q', 'a/b'], ['-A', '--above']), 'new');
  assert.equal(positional(['-A', 'p/q', 'a/b'], ['-A', '--above']), 'a/b');
  assert.equal(positional(['--claim'], []), undefined);
  assert.equal(positional(['-s', 'open', '--claim', 'sub-1'], UPDATE_VALUE_FLAGS), 'sub-1');
});

test('UPDATE_VALUE_FLAGS holds the bash hook list plus the value flags it missed', () => {
  const bash =
    '-s --status --add-label --remove-label --set-labels --title -d --description --notes --design ' +
    '--acceptance --assignee -a -p --priority --parent --session --due --defer -e --estimate --type -t';
  const added =
    '--append-notes --external-ref --spec-id --metadata --set-metadata --unset-metadata --body-file --design-file --await-id';
  assert.deepEqual(UPDATE_VALUE_FLAGS, [...bash.split(' '), ...added.split(' ')]);
  assert.equal(positional(['--external-ref', 'R149', 'sub-a1b', '--claim'], UPDATE_VALUE_FLAGS), 'sub-a1b');
  assert.equal(positional(['--append-notes', 'x', 'sub-a1b', '--claim'], UPDATE_VALUE_FLAGS), 'sub-a1b');
});

test('GLOBAL_VALUE_FLAGS lists the value flags per tool', () => {
  assert.ok(GLOBAL_VALUE_FLAGS.bd.includes('-C'));
  assert.ok(GLOBAL_VALUE_FLAGS.git.includes('-c'));
  assert.deepEqual(GLOBAL_VALUE_FLAGS.strand, []);
});
