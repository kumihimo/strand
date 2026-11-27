---
description: Approve a bead's spec (engineer only)
argument-hint: <bead-id>
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/src/cli/strand.ts" approve:*)
---

Approving a spec is the engineer's decision. Typing `/strand:approve <bead-id>` is the engineer's confirmation. Claude never approves: the gate hook refuses the CLI's approve command when Claude runs it through the Bash tool, so the approval runs here, when the engineer invokes this command:

!`node "${CLAUDE_PLUGIN_ROOT}/src/cli/strand.ts" approve $ARGUMENTS`

The line above prints `approved <id>`, maybe a `warning:` line about a WIP limit, or an `error:` line.

- `approved <id>`: run `bd -C "<tracker dir>" show <id>` (the tracker dir is on the `Tracker:` line of the bead context; ask the engineer if there is none) and tell the engineer, in two or three lines, what was approved: the bead and its acceptance criteria. The stage is now `build`. If this session is bound to the bead, load the `strand-work` skill and continue with Build.
- A `warning:` line: report it. The approval stands.
- An `error:` line: report it and change nothing. Common causes: the spec breaks a spec rule (the error lists what is missing: the story line, a criterion, or lines not in the form `- [ ] <text> (check: <command>)`), it is already approved, it is closed, or a WIP limit refuses it (WIP mode `refuse`).
- No output, or a refusal from the hook: say the command did not run, and give the engineer the other ways to approve: approve the plan in this session, press **Approve spec** in the cockpit, or run `node "${CLAUDE_PLUGIN_ROOT}/src/cli/strand.ts" approve <id>` in their own terminal.

Never retry the approval yourself.
