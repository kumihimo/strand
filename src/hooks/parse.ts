// Finds the but, git, bd and strand commands in a shell line. Pure module, no imports.
// A port of PARSER in ~/.claude/hooks/bead-workflow.sh, with a few deliberate differences
// (see the notes next to the tokenizer).

const TOOLS = new Set(['but', 'git', 'bd', 'strand']);
// The CLI's name before the rename to Strand (ADR 0021). An old install still on PATH, or an old checkout's
// sdlc.ts, reads as `strand`, so the gate keeps denying its `approve` and track still sees its `none`.
const LEGACY_CLI = 'sdlc';
// Words that run another command, so the next word may start one.
const SKIPPED_PREFIXES = new Set(['time', 'env', 'command', 'builtin', 'exec', 'nohup', 'sudo', 'xargs']);
// Shell keywords. The word after one may start a command.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}']);
// Prefix words that take flags before the command, and the flags that take a value.
const PREFIX_VALUE_FLAGS: Record<string, string[]> = {
  env: ['-u', '-C', '-S'],
  sudo: ['-u', '-g', '-h', '-p', '-C', '-U', '-r', '-t'],
  nohup: [],
  xargs: ['-I', '-n', '-P', '-d', '-L', '-s', '-E', '-a'],
};
// Global flags a tool accepts before its subcommand. Taking a value, and valueless.
// Taken from `bd --help`, `but --help` and `git --help` on this PC.
export const GLOBAL_VALUE_FLAGS: Record<string, string[]> = {
  bd: ['-C', '--directory', '--db', '--actor', '--dolt-auto-commit'],
  git: ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'],
  but: ['-C', '--current-dir'],
  strand: [],
};
const GLOBAL_BOOL_FLAGS: Record<string, string[]> = {
  bd: ['--json', '-q', '--quiet', '-v', '--verbose', '--readonly', '--sandbox', '--global', '--ignore-schema-skew', '--profile'],
  git: [
    '--no-pager', '-P', '-p', '--paginate', '--bare', '--no-replace-objects', '--no-lazy-fetch',
    '--no-optional-locks', '--no-advice', '--literal-pathspecs', '--glob-pathspecs',
    '--noglob-pathspecs', '--icase-pathspecs',
  ],
  but: ['--json'],
  strand: [],
};
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const POWERSHELLS = new Set(['pwsh', 'powershell']);
// node flags that take a value, and flags after which the next word is code, not a script.
const NODE_VALUE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader']);
const NODE_CODE_FLAGS = new Set(['-e', '--eval', '-p', '--print']);
const PUNCTUATION = ';&|()';

// bd update flags that take a value, so the bead id is the first word that is none of these.
// The bash hook's list, then the value flags it missed (from `bd update --help`).
export const UPDATE_VALUE_FLAGS: string[] = (
  '-s --status --add-label --remove-label --set-labels --title -d --description --notes ' +
  '--design --acceptance --assignee -a -p --priority --parent --session --due --defer ' +
  '-e --estimate --type -t ' +
  '--append-notes --external-ref --spec-id --metadata --set-metadata --unset-metadata ' +
  '--body-file --design-file --await-id'
).split(' ');

interface Token {
  text: string;
  separator: boolean;
}

// Drops heredoc bodies and joins the rest with newlines. A heredoc body is data, not commands.
function stripHeredocs(line: string): string {
  const kept: string[] = [];
  let ends: string | undefined;
  for (const row of line.split(/\r?\n/)) {
    if (ends !== undefined) {
      if (row.trim() === ends) ends = undefined;
      continue;
    }
    kept.push(row);
    // (?<!<) so that a here-string (<<<word) is not mistaken for a heredoc.
    const tag = /(?<!<)<<-?\s*['"]?(\w+)/.exec(row);
    if (tag) ends = tag[1];
  }
  return kept.join('\n');
}

// A POSIX-style shell tokenizer. Differences from Python shlex, on purpose:
// - Outside quotes a backslash escapes only whitespace, quotes, backslash and shell
//   punctuation. Before any other character it stays, so C:\tools\but.exe keeps its path.
// - An unquoted newline separates commands. A newline inside quotes becomes " ; " text.
// - A quoted ";" is a word, not a separator.
// - "#" starts a comment only at the start of a word, and ends at the newline.
// Returns undefined on a quoting error.
function tokenize(text: string): Token[] | undefined {
  const tokens: Token[] = [];
  let word = '';
  let inWord = false;
  const endWord = () => {
    if (inWord) tokens.push({ text: word, separator: false });
    word = '';
    inWord = false;
  };
  const heredocs: string[] = []; // delimiters waiting for the end of the line
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\n') {
      endWord();
      tokens.push({ text: ';', separator: true });
      i++;
      for (const delimiter of heredocs.splice(0)) {
        while (i < text.length) {
          let eol = text.indexOf('\n', i);
          if (eol < 0) eol = text.length;
          const row = text.slice(i, eol);
          i = eol + 1;
          if (row.trim() === delimiter) break;
        }
      }
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
    } else if (c === '#' && !inWord) {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '&' && (text[i + 1] === '>' || (inWord && /[<>]$/.test(word)))) {
      word += c; // a redirection (&>file, 2>&1, >&2), not a separator
      inWord = true;
      i++;
    } else if (c === '`') {
      endWord();
      if (text[i + 1] === '\n' || (text[i + 1] === '\r' && text[i + 2] === '\n')) {
        i += text[i + 1] === '\n' ? 2 : 3; // PowerShell line continuation
      } else {
        tokens.push({ text: '`', separator: true }); // command substitution
        i++;
      }
    } else if (PUNCTUATION.includes(c)) {
      endWord();
      let run = '';
      while (i < text.length && PUNCTUATION.includes(text[i])) run += text[i++];
      tokens.push({ text: run, separator: true });
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) return undefined;
      word += text.slice(i + 1, close);
      inWord = true;
      i = close + 1;
    } else if (c === '"') {
      i++;
      inWord = true;
      for (;;) {
        if (i >= text.length) return undefined;
        const d = text[i];
        if (d === '"') {
          i++;
          break;
        }
        if (d === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) {
          word += text[i + 1];
          i += 2;
        } else if (d === '\n') {
          word += ' ; ';
          i++;
        } else {
          word += d;
          i++;
        }
      }
    } else if (c === '\\') {
      const next = text[i + 1];
      if (next === undefined) return undefined;
      if (next === '\n' || (next === '\r' && text[i + 2] === '\n')) {
        i += next === '\n' ? 2 : 3; // line continuation
      } else if (/[\s'"\\;&|()<>$`#]/.test(next)) {
        word += next;
        inWord = true;
        i += 2;
      } else {
        word += c;
        inWord = true;
        i++;
      }
    } else {
      if (c === '<' && text[i + 1] === '<' && text[i + 2] !== '<' && text[i - 1] !== '<') {
        const tag = /^<<-?[ \t]*['"]?(\w+)/.exec(text.slice(i));
        if (tag) heredocs.push(tag[1]);
      }
      word += c;
      inWord = true;
      i++;
    }
  }
  endWord();
  return tokens;
}

function fallbackTokens(line: string): Token[] {
  return stripHeredocs(line)
    .replace(/\n/g, ' ; ')
    .split(/\s+/)
    .filter(Boolean)
    .map((text) => ({ text, separator: [...text].every((ch) => PUNCTUATION.includes(ch)) }));
}

function baseName(word: string): string {
  const base = word.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  // npm link makes strand.cmd and strand.ps1; Windows tools also come as .exe and .bat.
  return base.replace(/\.(exe|cmd|bat|ps1)$/, '');
}

function isCliScript(word: string): boolean {
  const base = word.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  return base === 'strand.ts' || base === `${LEGACY_CLI}.ts`;
}

export function parseCommands(line: string): string[][] {
  const tokens = tokenize(line) ?? fallbackTokens(line);
  const commands: string[][] = [];
  let current: string[] | undefined;
  let atStart = true;
  let wantScript = false; // after `node`, looking for strand.ts
  let skipNodeValue = false;
  let prefix: string | undefined; // env, sudo, ...: skip its flags
  let skipPrefixValue = false;
  let shell: 'posix' | 'ps' | undefined; // after bash, pwsh, ...: looking for -c
  let shellString: string[] | undefined; // the words of the -c argument
  const flushShell = () => {
    if (shellString) commands.push(...parseCommands(shellString.join(' ')));
    shellString = undefined;
  };
  const reset = () => {
    flushShell();
    current = undefined;
    atStart = true;
    wantScript = false;
    skipNodeValue = false;
    prefix = undefined;
    skipPrefixValue = false;
    shell = undefined;
  };
  for (const token of tokens) {
    if (token.separator) {
      reset();
    } else if (current) {
      current.push(token.text);
    } else if (shellString) {
      shellString.push(token.text);
      if (shell === 'posix') flushShell();
    } else if (shell) {
      const flag = token.text.toLowerCase();
      const wantsString =
        shell === 'posix'
          ? /^-[a-z]*c[a-z]*$/.test(token.text)
          : flag.length >= 2 && '-command'.startsWith(flag);
      if (wantsString) shellString = [];
    } else if (wantScript) {
      if (skipNodeValue) {
        skipNodeValue = false;
      } else if (NODE_VALUE_FLAGS.has(token.text)) {
        skipNodeValue = true;
      } else if (NODE_CODE_FLAGS.has(token.text)) {
        wantScript = false;
        atStart = false;
      } else if (!token.text.startsWith('-')) {
        wantScript = false;
        if (isCliScript(token.text)) {
          current = ['strand'];
          commands.push(current);
        } else {
          atStart = false;
        }
      }
    } else if (atStart) {
      const base = baseName(token.text);
      if (prefix && skipPrefixValue) {
        skipPrefixValue = false;
      } else if (prefix && token.text.startsWith('-')) {
        skipPrefixValue = PREFIX_VALUE_FLAGS[prefix].includes(token.text);
      } else if (token.text.includes('=') || KEYWORDS.has(token.text)) {
        // an assignment or a keyword: the next word may start a command
      } else if (SKIPPED_PREFIXES.has(base)) {
        prefix = base in PREFIX_VALUE_FLAGS ? base : undefined;
      } else if (TOOLS.has(base) || base === LEGACY_CLI) {
        current = [base === LEGACY_CLI ? 'strand' : base];
        commands.push(current);
      } else if (base === 'node') {
        wantScript = true;
      } else if (POSIX_SHELLS.has(base)) {
        shell = 'posix';
      } else if (POWERSHELLS.has(base)) {
        shell = 'ps';
      } else {
        atStart = false;
      }
    }
  }
  reset();
  return commands.map(dropGlobalFlags);
}

// [tool, ...global flags, subcommand, ...rest] becomes [tool, subcommand, ...rest].
// Only flags before the subcommand go. Idempotent.
function dropGlobalFlags(command: string[]): string[] {
  const tool = command[0];
  const withValue = GLOBAL_VALUE_FLAGS[tool] ?? [];
  const valueless = GLOBAL_BOOL_FLAGS[tool] ?? [];
  let i = 1;
  while (i < command.length) {
    const a = command[i];
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    if (withValue.includes(a)) i += 2;
    else if (valueless.includes(a) || (eq > 0 && withValue.includes(a.slice(0, eq)))) i++;
    else break;
  }
  return i === 1 ? command : [tool, ...command.slice(i)];
}

// The value of the first of the given flags in args. Also reads --flag=value.
export function flagValue(args: string[], flags: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0 && flags.includes(a.slice(0, eq))) return a.slice(eq + 1);
    }
    if (flags.includes(a)) return args[i + 1] ?? '';
  }
  return undefined;
}

// Every value of the given flags, in order. Also reads --flag=value.
export function flagValues(args: string[], flags: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    if (eq > 0 && flags.includes(a.slice(0, eq))) values.push(a.slice(eq + 1));
    else if (flags.includes(a)) values.push(args[i + 1] ?? '');
  }
  return values;
}

// The first argument that is neither a flag nor the value of one of valueFlags.
export function positional(args: string[], valueFlags: string[]): string | undefined {
  let skip = false;
  for (const a of args) {
    if (skip) skip = false;
    else if (valueFlags.includes(a)) skip = true;
    else if (!a.startsWith('-')) return a;
  }
  return undefined;
}
