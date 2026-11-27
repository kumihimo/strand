# Verify

Goal: prove every criterion, then open the PR. Do not skip a failing check.

## Prove the work

1. Run the full test suite via the `Test command` in the repo's `CLAUDE.md`. Never use your own runner. If none is documented, ask the engineer and stop.
2. Run the repo's other checks listed in `CLAUDE.md` (lint, type check, build), through their documented commands.
3. Docs: if structure or a significant decision changed, update `docs/architecture/` and add an ADR in `docs/adr/NNNN-<slug>.md` (Nygard format). Use an RFC (`docs/rfc/`) only for proposals made before building. Commit doc changes as in `git-conventions.md`.

## Browser checks

Hands off (ADR 0018). When a check needs the app restarted and a page looked at, you do it. Never ask the engineer to restart a server, open a browser or click through a page that a script can drive. This holds in Build too, whenever you want to see a change working.

1. Bring the stack up with the repo's documented `Run command` (the test command table, or the repo's `CLAUDE.md`). It is the only way you start a server. If the change needs a rebuild or a restart to show, run that command again yourself.
2. Drive the browser with Playwright:
   - the repo's own browser suite, through its documented command, when it covers the criterion (add a spec there when the criterion deserves a lasting test);
   - otherwise the Playwright browser tools of this session: open the page, do the steps, read the page.
3. Keep the evidence: what the script did and saw, and a screenshot saved under the bead's artefacts `scratch/` folder. Tick with `(verified: Playwright, <what it saw>)`.
4. Leave the stack as the run command leaves it. Do not start a second server on another port.

Ask the engineer only when:

- the repo documents no `Run command`: ask for one and stop, do not guess;
- a script cannot drive the check: a real payment, hardware, a sign-in you have no test account for, or a judgement of look and feel. Say exactly what to look at and where.

The stack is shared by every session in the repo and the run command may wipe its data. If another session's bead is in Build or Verify in the same repo, say so before you bring the stack up again.

## Tick the criteria

- Tick a criterion only after the check it names has passed in this session:
  ```
  - [x] <criterion> (verified: <command> passed)
  ```
- If no command can check it, ask the engineer. On a yes, write `(verified: user confirmed)`.
- Write the whole list back: `bd -C "<tracker dir>" update <id> --acceptance "<full list>"`. Change only the ticks and the evidence, never the criterion text: a text change counts as a criteria change and needs the engineer's yes.
- A tick without `(verified: ...)` does not count. The Stop hook asks once for the missing evidence.
- A criterion that fails: leave it unticked, say why, and go back to `build.md`.

When every line is ticked with evidence, the stage becomes `verify`.

- No branch: the Stop hook closes the bead. This is right only for work that changed no repo file (see `build.md`). If you changed repo files and have no branch, you ticked too early: untick the last criterion, make the branch and commit first.
- With a branch: open the PR.

## Open the PR

- Read the target repo's own PR rules first (its `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md` or PR template) and follow them for the title and body.
- No bead id in a branch name, commit message, PR title or PR body. `$STRAND pr` refuses a title or body that names a bead.
- Write the body to a temp file, then run:
  ```
  $STRAND pr <id> --title "<title>" --body-file <file>
  ```
- It pushes the branch, opens the PR on the forge (Gitea), labels the bead `pr:<owner>/<repo>#<n>` and prints the PR URL. Run again, it returns the open PR and pushes nothing.
- The stage becomes `review`. Add a checkpoint comment with the PR URL and stop: the engineer reviews.

## After the PR is open

- CI fails or the engineer asks for changes: fix on the same branch, commit with the `Commit with:` line, and push the branch with `but push <name>`. Never open a second PR.
- The bead closes itself when the PR merges: at Stop in this chat, at the next session start in the repo, or when the open cockpit sees the merge on Gitea. Do not close it yourself.
