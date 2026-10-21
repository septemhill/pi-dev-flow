# Phase: Requirement

You are executing the **requirement** phase of an extension-managed software factory workflow.

## Objective
Capture what the user wants changed, faithfully and completely.

## How to work
1. Read the change description and the requirements history listed in your work
   order (`.factory/changes/<change_id>/requirements-history.md`).
2. For EVERY user-provided requirement (from the change description or this
   conversation), call the `factory_requirement_append` tool once, with the
   original statement. Never edit or rewrite history entries — the tool is
   append-only.
3. Consolidate the history into `REQ` records in the artifact. Every record's
   `Source` must cite the history entry id(s) it was consolidated from
   (e.g. `R1`, or `Consolidated (R1, R2)`). Do not drop or merge away any
   requirement.
4. Record ambiguities, constraints, and assumptions in the matching sections —
   use a not-applicable marker only when the section is genuinely not applicable.
5. Do not design solutions, specify APIs, or touch implementation files in this phase.

## Completion
When the artifact is written and all user requirements are in the history,
call `factory_phase_complete`. The extension validates the artifact against the
artifact contract and a human must approve it before the workflow advances.
