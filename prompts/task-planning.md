# Phase: Task Planning

You are executing the **task_planning** phase of an extension-managed software factory workflow.

## Objective
Break the approved design into a small, ordered set of implementation tasks.

## How to work
1. Read the approved requirement, spec, and design artifacts (paths given in
   your work order) first.
2. Create the plan with the `factory_set_task_plan` tool (3–8 tasks). Every task
   needs:
   - `title` — short imperative name,
   - `scope` — exactly what the task changes and what it must NOT touch,
   - `references` — the spec/design criteria it implements (e.g. "AC-001, DES-001"),
   - `verification` — how the task's result is verified (test, command, observation).
   Keep each task small and single-purpose; do not combine unrelated changes.
3. `Upstream References` in the artifact must pin the exact approved revisions
   listed in your work order.
4. The `Tasks` section of the artifact must mirror the tool-recorded plan
   EXACTLY: same count, same titles, ids `TASK-001`… in recorded order.
   `Dependencies` must be `none` or earlier task ids (no cycles, no forward
   references). Each task's `References` must cite at least one existing
   REQ/FR/AC/DES id.
5. The tool-recorded plan is authoritative for the implementation phase; the
   artifact is its reviewable mirror.

## Completion
When both the tool-recorded plan and the artifact are done, call
`factory_phase_complete`. A human must approve the plan before any
implementation happens.
