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

## Project Knowledge discovery

While capturing requirements, also watch the user's ORIGINAL statements for
project-level knowledge that would outlive this change:

- a restriction or prohibited behavior future changes must also respect →
  possible **Constraint**;
- a reusable development practice or project standard → possible
  **Convention**;
- an explicit or implied technology/architecture choice → possible
  **Tech Decision**.

Rules for candidate handling:

- Distinguish change-specific requirements (REQ records, as usual) from
  reusable project knowledge. Do not force an ambiguous statement into one
  category.
- Check the existing Project Knowledge listed in your work order BEFORE
  proposing anything; reuse an existing record's id rather than creating a
  duplicate with different wording.
- Never silently change the project baseline: present a candidate and ask the
  user whether it should be added to Project Knowledge.
- To persist a candidate, call the `factory_knowledge_draft` tool (it stores a
  DRAFT; only the user can make it effective via `/factory knowledge approve
  <id>`). An inferred candidate is NEVER approved by you — a confident
  classification is not authorization.
- Preserve traceability: note each candidate in the "Open Questions" section
  of the artifact as `[knowledge-candidate] <type>: <summary> — drafted as
  <ID>, pending approval (source R<n>)`, and pass the change id / requirement
  entry to the tool.
- Knowledge discovery does not move the workflow: phases and approval gates
  are exactly as before.

## Completion
When the artifact is written and all user requirements are in the history,
call `factory_phase_complete`. The extension validates the artifact against the
artifact contract and a human must approve it before the workflow advances.
