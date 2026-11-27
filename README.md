# Strand

An LLM-assisted SDLC system for a single engineer: a Claude Code plugin (`strand`) that ties every task to a Beads bead, plus a local cockpit web app that shows it all.

- A bead is captured with a title, a type and a parent epic. Before its spec is approved it gets a user story and acceptance criteria that name their checks. A spec format is chosen per bead.
- The engineer approves the spec: by approving the plan in the session, with **Approve spec** in the cockpit, or with `/strand:approve`. Claude never approves.
- Claude ticks each criterion with `(verified: ...)` evidence, opens the PR with `strand pr`, and the bead closes when the PR merges.
- Branch and PR are linked to the bead by labels. Bead ids never appear in a branch, commit or PR.
- Six Claude Code hooks enforce this and fail open. WIP limits warn by default.

**Picking up development?** Start with [AGENTS.md](AGENTS.md) (how to work in this repo, for people and coding agents).

## Cockpit

A local web UI over the same data the CLI uses (Beads, the artefacts folder, Gitea), with Claude Code sessions running inside it. It holds no state of its own; close it and nothing is lost.

Run it:

```
npm run build:ui     # once, and after UI changes
strand cockpit         # or: npm run cockpit
```

- It prints `Cockpit: http://127.0.0.1:<port>/` and opens the Strand desktop app, an Electron window that finds the server and gets its key itself. In a source checkout that is `npm run app` (after `npm install` and `npm run build:ui`); `npm run package` builds the app into `release/`. Without the app it prints a link with the key, `http://127.0.0.1:<port>/?key=...`, and opens it in a normal tab in your default browser.
- The app needs Node 24 on PATH, or `STRAND_NODE` set to it, to run the server. On Ubuntu 24.04 and later, an unpacked build needs its `chrome-sandbox` helper owned by root with mode 4755 (`sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox`), or Chromium refuses to start.
- The console keeps running: it is the server. Ctrl+C there stops it and ends any live terminals.
- Run `strand cockpit` again, or start the app again, and it brings the running app to the front (`Cockpit already running: <link>`) instead of starting a second server. Quitting an app that started its own server stops that server; an app opened on a server started from a console leaves it running.
- The **Sessions** button in the header lists the live terminals across beads and opens the one you pick.
- Options: `--port <n>` (default 4747, or `STRAND_COCKPIT_PORT`), `--window app|tab|none` for this run, `--no-open` (print the link only). Config: `cockpit.window` (`app`, `tab`, `none`), `cockpit.maxSessions` (default 4); env `STRAND_COCKPIT_WINDOW`, `STRAND_COCKPIT_MAX_SESSIONS`. An old `cockpit.browserPath` is ignored.

What it does:

- Brief, Board (six columns: Backlog, Specify, Build, Verify, Review, Done), bead detail (relations, Criteria panel with checks and evidence, spec, branch and PR, repo and context folders, activity, artefacts), Epics, Review queue and New bead.
- Approve spec and Request changes for a bead in Specify. When the spec does not meet the approval rules, Approve spec is disabled and the reasons are listed beside it. A card whose spec is ready shows an "awaiting approval" pill.

### Creating a bead

- Capture first. A bead needs a title (at most 60 characters), a type and, unless it is an epic, a parent epic. That is the rule for the New bead form and for `strand new`.
- The description and acceptance criteria are optional free text. The forms `As <role>, I want ..., so that ...` and `- [ ] <text> (check: <command>)` show as suggestions.
- The spec rules are checked at approval (**Approve spec**, `strand approve`, `/strand:approve`): the story line (not for a chore or an epic), at least one criterion (not for a chore), and every acceptance line in the criterion form with a check. A refusal lists what is missing. Approval by plan or by a claim does not check them.
- **Repos.** Tick the repos the bead needs. The first ticked is the **primary repo**: the session's folder, where the branch and the PR live. The others are **context folders**, passed to Claude with `--add-dir` when the session starts. **Make primary** changes the primary; **Refresh** reads the workspace folders again. A bead with no repo cannot start a session until one is set. On the CLI: `--repo <folder>` and `--context <folder>` (repeatable).
- Open artefacts and links in your default app, from an allowlist.

### The terminal pane

- The Session pane in the bead detail runs a real Claude Code session for the bead: **Start specifying** (Backlog: starts with `/strand:work <id>`; Claude asks its questions, saves the story and criteria to the bead and stops for **Approve spec**, with no plan mode), **Start session**, **Resume** (a session of the bead, also one ended by **Stop** or by stopping the cockpit; one the tracker lists as live in another window is marked "(live elsewhere)") and **Stop**. Each starts `strand work`, so the WIP check, claim, binding and hooks are the same as from a terminal.
- Drag a Backlog card onto Specify to claim it and start specifying. Drag a Specify card back to Backlog (or press **Release**) to give the claim back; stop its session first. Other drops are refused with the reason on the column, because the stage is derived.
- **Approve spec** types `Spec approved. Start Build.` into the bead's live session; **Request changes** types `Changes requested: <note>`.
- Sessions belong to the server: reload the page or close the window and they reattach with recent output. At most 4 live terminals, one per bead. A card with a live terminal shows a "Terminal open" dot.
- Ctrl+Shift+F6 moves the keyboard focus out of the terminal; Tab and Escape go to Claude.
- If `node-pty` cannot load, the pane shows the `strand work <id>` command to copy into a terminal, with the reason.
- Sessions started by `strand work` (new, specify and resume, in the cockpit or a terminal) run the latest Opus model at high effort. Change them in the strand config with `claudeModel` (env `STRAND_CLAUDE_MODEL`, default `opus`) and `claudeEffort` (env `STRAND_CLAUDE_EFFORT`, default `high`; one of `low`, `medium`, `high`, `xhigh`, `max`). The value `default` passes no flag, so Claude Code's own default applies. A bad value is ignored with a warning and the default is used. A config without these keys gets the defaults. They are never taken from a bead or a request. `STRAND_DRY_RUN_CLAUDE=1 strand work <id>` prints the command.

With a bead open, two drawers make room. **Hide details** folds the details column to a thin strip so the terminal takes the full width. **Collapse** folds the whole lower panel to its title bar so the board takes the full height. Collapsing closes nothing: a live session and an unsaved edit stay. While the details column is folded, its strip shows an "Unsaved edits" dot for a draft in the edit form. Starting a session expands the panel again. The browser remembers the drawers. The details column is compact, and long text is clamped with a **Show more** toggle.

### Sorting and filtering

- Board and Epics have Sort (priority, status, stage, type, updated, title; ascending or descending) and Filters (status, stage, type, repo, label, epic, ready, blocked, and a text box over id and title). Filters combine with AND.
- Board columns show `<shown> of <total>` while a filter hides cards. Epics can hide epics with no matching child.
- Each view remembers its choice in the browser. **Clear** resets it.

### Editing a bead

- **Edit** in the bead detail changes title, description, acceptance criteria, spec body, type, priority, parent and repos of any bead that is not closed. Before approval the criteria are free text, stored as typed. After approval the spec rules apply and every line must be a criterion. The primary repo cannot change once the bead has a branch.
- A criterion keeps its tick and evidence only while its text and check are unchanged.
- If the bead changed since the form opened, the save is refused and the form shows the newer text for each clashing field, to take or overwrite.
- **Save and approve** saves, then approves (Specify only). Changing the criteria after approval re-records the criteria baseline and adds a bead comment. A bound session is told on its next prompt to re-read the spec.

Security: it listens on localhost only and needs the per-launch key, which is also kept in a user-only file while the server runs. It checks the Host and Origin of every request, the terminal WebSocket included. The terminal endpoint runs only `strand work <id>` with `--session-id <uuid>` (made by the server, plus `--specify`) or `--resume <uuid>`. Only `http` and `https` links open, and only allow-listed artefact types.

Not yet: a Quit button in the UI (stop the server with Ctrl+C in its console) and review tiers (Phase 2).

Release notes:

- RFC 0003: the label workflow. No gate records; `strand gate1` is gone; `strand approve` approves the spec; new commands `criteria accept`, `pr --title --body-file`, `none`, `audit` and `migrate`. `strand new` enforces the filing rules: title at most 60 characters, a user-story description, criteria lines `- [ ] <criterion> (check: ...)`, a parent epic. (Superseded by capture first, below: the story and criteria rules now apply at approval.)
- `strand new` validates its input: the type must be lowercase `a` to `z`, `0` to `9` and `-`, and repo names may not contain `,`.
- Capture first: `strand new` needs only a title, a type and a parent epic. The story and criteria rules moved to approval. Beads gain context folders (`context:` labels, `strand new --context`).

### Try it with demo data

```
node scripts/seed-demo.ts /path/to/demo-dir
```

This builds a throwaway workspace (a tracker with sample beads, a small repo and artefacts) and prints the exact command to start the cockpit against it, for a POSIX shell and for PowerShell. The command points the cockpit at the demo folder through environment variables, so it never touches your real config: `STRAND_WORKSPACE` for the workspace and `STRAND_CONFIG_DIR` for the strand config folder (it holds `config.json` and the cockpit key file). `APPDATA` and `XDG_CONFIG_HOME` stay real, so Claude Code in a demo terminal keeps its own login. It also sets `STRAND_PLUGIN_DIR` to this checkout, so each demo session loads the plugin with `--plugin-dir` and the slash commands and hooks work without setup.

## Installing

Clone this repo, then run the installer from the checkout: `installer/install.sh` (macOS, Linux) or `installer\install.ps1` (Windows). It:

- checks prerequisites and finds `claude` even when it is not on PATH (stored as `claudePath`);
- writes the config, asking for the workspace root, the Gitea URL and your branch prefix (`branchPrefix`, used as `<prefix>/<topic>`); `--tracker-dir <path>` points it at an existing Beads database;
- sets up the tracker and docs folders (it never runs `bd init` on an existing database);
- runs `npm install` if `node_modules` is missing or older than `package-lock.json`, builds the cockpit UI, and puts `strand` on your PATH with `npm link` (if that fails, it prints the command to run by hand);
- installs the `strand` Claude Code plugin from this checkout;
- backs up Claude Code's `settings.json` to `settings.json.pre-strand` and removes the hook entries of the old `bead-workflow.sh`;
- lists the workspace repos whose `CLAUDE.md` has no `Test command`.

### Desktop app packages

Each `v*` tag builds the desktop app as a Windows installer (`Strand-Setup-<version>.exe`), a `.deb` and an AppImage for x64 Linux, with `SHA256SUMS` and its signature `SHA256SUMS.asc`, and attaches them to a draft GitHub Release that is published by hand. Download them from the [Releases page](https://github.com/kumihimo/strand/releases). Until Node, bd and git ship inside the app, it needs Node 24 on PATH.

The Windows installer is not code-signed yet, so Windows SmartScreen shows "Windows protected your PC" when you run it. Check the download against `SHA256SUMS` first (below; on Windows, `Get-FileHash Strand-Setup-<version>.exe` gives the SHA-256), then choose **More info** and **Run anyway**.

On Ubuntu 23.10 and later, use the `.deb`: it installs an AppArmor profile so Electron's sandbox works under the default `kernel.apparmor_restrict_unprivileged_userns=1`. The AppImage cannot set that up, so there it stops at start-up.

Verify a download before installing it:

```sh
gpg --import RELEASE-KEY.asc
gpg --verify SHA256SUMS.asc SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
```

`gpg --verify` must report a good signature from the release key, `Strand release signing`, with this fingerprint:

```
9B0B 04DF 2033 A161 CFAA  EA62 9CAF 8A0C E880 3C2C
```

### Moving an existing tracker onto this workflow

Run once, in this order, against the real tracker: installer dry run with `--tracker-dir`, the installer, `strand migrate`, `strand migrate --apply`, a new Claude Code session, `strand audit`. Do not start a Claude Code session between the installer and `strand migrate --apply`.

The installer stops before any write if `BEADS_DIR` names another tracker, or if the folder has no `.beads` (add `--init-tracker` only for a new database).

## Updating

1. In the checkout: `git pull`.
2. Rerun the installer (`installer/install.sh` or `installer\install.ps1`). It is idempotent: it keeps your config, installs dependencies only if `node_modules` is missing or older than `package-lock.json`, rebuilds the UI, re-links `strand` and refreshes the plugin (`claude plugin update`).
3. Start a new Claude Code session (or run `/reload-plugins`) to load the new plugin version.

If `package.json` dependencies changed, run `npm install` in the checkout before step 2.

### Renamed from sdlc

The app used to be called sdlc (the `sdlc` CLI, the `sdlc` plugin, the `sdlc-cockpit` repo). It is Strand now. After the rename Strand still reads the old state: `<config dir>/sdlc/config.json`, the `sdlc` keychain entry, `SDLC_*` env vars (for one release, with a warning) and the tracker's `.sdlc/` folder. It writes only the new names. The installer replaces the old plugin registration.

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Copyright 2026 The Strand Authors.
