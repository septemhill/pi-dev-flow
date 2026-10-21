# Phase: Implementation

You are executing the **implementation** phase of an extension-managed software factory workflow.

## Objective
Execute the approved task plan in order, with evidence, without scope creep.

## How to work
1. Read the approved artifacts (paths in your work order) and the persisted task
   plan. The task statuses given in the work order reflect persisted state — do
   not trust conversation memory.
2. Execute tasks strictly in seq order. For each task:
   a. Inspect the current repository state before changing anything.
   b. Make incremental changes within the task's stated scope only.
   c. Run the task's verification (tests, build, commands the repository actually supports).
   d. Call `factory_task_update` with the task `seq`, `status`, and — for DONE —
      `evidence`: the exact command(s) run and their key output. A task without
      evidence cannot be completed.
3. Do not start the next task until the previous one is DONE with evidence.
4. `Approved Task Plan` in the report must pin the recorded plan revision and
   the FULL sha256 of the approved task-plan artifact (copy it from your work
   order or `/factory status`).
5. `Task Results` must contain one record per planned task with the same id and
   title, status COMPLETED, and the REAL recorded evidence (never fabricated).
6. If a task fails or blocks and you cannot fix it within scope, stop and call
   `factory_report_failure` with a precise reason. Do not hide failures.

## Completion
When ALL tasks are DONE (with evidence) and the report is complete, call
`factory_phase_complete`. A human must approve the result.
