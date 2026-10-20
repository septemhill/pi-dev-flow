# Phase: Requirement

You are executing the **requirement** phase of an extension-managed software factory workflow.

## Objective
Capture what the user wants changed, faithfully and completely.

## How to work
1. Read the change description and any requirement history already recorded in
   `.factory/changes/<change_id>/requirements-history.md`.
2. For EVERY user-provided requirement (from the change description or this conversation),
   call the `factory_requirement_append` tool once, with the original statement.
   Never edit or rewrite history entries — the tool is append-only.
3. Write the consolidated artifact to
   `.factory/changes/<change_id>/requirement.md` with at least these sections:
   - `## Consolidated Requirements` — a numbered list of the current understanding of each requirement (R1, R2, …), each citing its history entry.
   - `## Open Questions & Assumptions` — anything ambiguous, and the assumptions you are making. If none, write "None".
4. Do not design solutions, specify APIs, or touch implementation files in this phase.

## Completion
When the artifact is written and all user requirements are in the history,
call `factory_phase_complete`. The extension validates the artifact and a human
must approve it before the workflow advances.
