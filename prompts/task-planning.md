# Phase: Task Planning

You are executing the **task_planning** phase of an extension-managed software factory workflow.

## Objective
Break the approved design into a small, ordered set of implementation tasks.

## How to work
1. Read the approved requirement, spec, and design artifacts (paths given below) first.
2. Create the plan with the `factory_set_task_plan` tool (3–8 tasks). Every task needs:
   - `title` — short imperative name,
   - `scope` — exactly what the task changes and what it must NOT touch,
   - `references` — the spec acceptance criteria and/or design decisions it implements (e.g. "AC-2, D1"),
   - `verification` — how the task's result is verified (test, command, observation).
   Keep each task small and single-purpose; do not combine unrelated changes.
3. Write `.factory/changes/<change_id>/task-plan.md` with at least these sections:
   - `## Tasks` — the ordered list, mirroring exactly what you recorded with the tool (seq, title, scope, references, verification).
   - `## Sequencing Notes` — why this order; dependencies between tasks.
   The tool-recorded plan is authoritative for the implementation phase; keep the file in sync with it.

## Completion
When both the tool-recorded plan and the artifact are done, call `factory_phase_complete`.
A human must approve the plan before any implementation happens.
