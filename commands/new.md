---
description: File a bead in the tracker, bound to this repo, with a title and a parent epic; story and criteria optional
argument-hint: "<title>" --type <type> --parent <epic-id> [--description "<story>"] [--acceptance "<criteria>"] [--priority n] [--repo <folder>] [--context <folder>]...
---

The filing rules are in the `strand-work` skill's `filing.md`. Filing needs only a title of at most 60 characters, a type, and a parent epic for everything but an epic. The description and the acceptance criteria are optional free text at creation. The spec rules are checked at approval: a description that opens `As a ..., I want ..., so that ...` (not for `chore` or `epic`), and at least one criterion (not for `chore`), every line in the form `- [ ] <text> (check: <command>)`. Suggest those forms when the engineer gives a story or criteria, but do not invent criteria. The CLI refuses a bead that breaks a filing rule and prints it.

The bead is bound to its primary repo with a `repo:<folder>` label; the work and pr commands need it. Without `--repo`, the CLI uses this session's folder when it sits directly in the workspace root (e.g. `C:\dev\orders-service` gives `repo:orders-service`); from anywhere else, pass `--repo <folder name>` (spaces are fine; quote it). `--context <folder>` adds a context folder the session can read; repeat it for more. Context folders need a primary repo.

Run this command and show its output to the engineer:

```
node "${CLAUDE_PLUGIN_ROOT}/src/cli/strand.ts" new $ARGUMENTS
```

If it prints `error:`, report the message and stop. If the bead has no `repo:` label (use `--json` to see labels), warn that it is not bound to a repo yet and cannot start a session until one is set. Otherwise state the new bead id and offer `/strand:work <id>` as the next step. Do not start work on the bead and do not claim it.
