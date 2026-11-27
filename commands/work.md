---
description: Work a bead in this session, from its current stage
argument-hint: [bead-id]
---

Work bead `$ARGUMENTS` (or, when no id was given, the bead named in the injected `Strand bead` context) in this session. The UserPromptSubmit hook has already recorded the session against the bead, bound it, claimed the bead if it was open, and injected its context (type, stage, spec format, WIP, branch, criteria, spec). With no id, the hook uses the bead already bound to this session. The claim does not approve the spec: a bead with no approval is in `specify`. Do not launch a nested `claude` and do not run the CLI `work` command here; it is for starting a new terminal session.

1. Read the injected `Strand bead ...` context. If the context says `/strand:work was typed with no bead id`, ask the engineer which bead to work and stop. If the context is missing, ask the engineer for the tracker dir, run `bd -C "<tracker dir>" show <bead id>`, and tell the engineer the hook did not fire.
2. Load the `strand-work` skill and follow its routing table for the stage named in the context.
3. Respect WIP limits: with a `WIP warning:` line, tell the engineer the reason and point to the review queue (`/strand:brief`), then carry on unless they say stop. With a `Build blocked:` line, do not start Build work; give the reason and point to the review queue instead.
4. If the context starts with `Warning: this session's folder is ...`, tell the engineer this session is not in the bead's repo folder and ask whether to continue here or start the bead from its folder.
