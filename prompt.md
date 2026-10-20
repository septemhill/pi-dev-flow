# Task: Implement an MVP AI Software Factory as a pi Extension

## 1. Objective

Implement a working MVP of an AI Software Factory as a single pi Extension in the current repository.

The Extension must orchestrate a fixed software development workflow, persist its state, and require explicit human approval before advancing from one phase to the next.

This is an implementation task, not a design-only task. Inspect the existing repository, implement the Extension, run the available tests, and fix any issues discovered during verification.

Do not build a standalone agent runtime, a separate Go service, or a cross-agent compatibility layer. The entire MVP must run inside the pi Extension.

## 2. Mandatory Workflow

Implement the following six phases in exactly this order:

1. `requirement`
2. `spec`
3. `design`
4. `task_planning`
5. `implementation`
6. `verification`

The workflow must be controlled by Extension code, not solely by instructions in an LLM prompt.

The LLM generates and modifies phase artifacts. The Extension owns workflow state, transition validation, persistence, and approval enforcement.

The LLM must never be treated as the authoritative source of workflow state.

### Phase responsibilities

#### Requirement
- Maintain the change's requirement document.
- Append each new user-provided requirement to the requirement history.
- Preserve the original statements rather than silently replacing or discarding them.
- Produce a consolidated requirement artifact for review.
- Record unresolved questions and assumptions.

#### Spec
- Define expected behavior.
- Define inputs and outputs.
- Define acceptance criteria.
- Define externally verifiable behavior and verification contracts.
- Reference the requirements that justify each important criterion.

#### Design
- Define the proposed architecture and component responsibilities.
- Record relevant infrastructure, framework, library, and implementation constraints.
- Explain important design decisions and trade-offs.
- Identify affected parts of the existing repository.

#### Task Planning
- Produce a small, ordered set of implementation tasks.
- Every task must belong to the current `change_id`.
- Each task must reference the relevant specification or design criteria.
- Tasks must have clear scope, expected outputs, and verification criteria.
- Avoid oversized tasks that combine unrelated changes.
- Do not begin implementation until the task plan has been approved.

#### Implementation
- Execute the approved tasks in order.
- Inspect the repository before changing code.
- Make changes incrementally.
- Run relevant tests and checks.
- Record modified files, commands executed, results, and unresolved problems.
- Do not mark a task complete without the required verification evidence.

For the MVP, implement a simple sequential task runner or task checklist. Do not implement a distributed scheduler, parallel execution, lease renewal, or worker coordination.

#### Verification
- Evaluate the implementation against the approved specification.
- Run applicable automated tests, linters, build checks, and other repository-defined verification commands.
- Record each check, its result, and relevant output or evidence.
- Distinguish passed checks, failed checks, skipped checks, and checks requiring human verification.
- Do not report overall verification success if required checks failed or were not executed.

Do not invent repository commands. Discover the project's actual tooling and use commands supported by the repository.

## 3. Repository Inspection Before Implementation

Before writing code:

1. Inspect the repository structure and existing development conventions.
2. Identify the installed pi version and the Extension API available in that version.
3. Inspect existing Extension examples, configuration, package manager, TypeScript settings, and test framework.
4. Determine how the Extension is loaded and how commands, tools, events, and user interactions are registered.
5. Identify any existing state-management or SQLite dependencies that can reasonably be reused.
6. Report any material compatibility constraints discovered during inspection.

Use the actual installed pi API. Do not invent methods, event names, command signatures, or UI capabilities based on assumptions.

Preserve existing project conventions where reasonable. Do not overwrite unrelated user changes or perform destructive repository operations.

After inspection, proceed with implementation without waiting for approval of the proposed architecture unless a genuine blocker requires clarification.

## 4. MVP Architecture

Implement one pi Extension with internally separated modules. Keep the architecture simple and avoid unnecessary abstractions.

A suggested structure is:

```text
pi-ai-software-factory/
├── package.json
├── tsconfig.json
├── index.ts
├── src/
│   ├── workflow/
│   │   ├── phases.ts
│   │   ├── controller.ts
│   │   └── transitions.ts
│   ├── artifacts/
│   │   ├── artifact-store.ts
│   │   └── artifact-types.ts
│   ├── approvals/
│   │   └── approval-manager.ts
│   ├── persistence/
│   │   ├── database.ts
│   │   └── migrations.ts
│   ├── execution/
│   │   └── phase-executor.ts
│   └── commands/
│       └── factory.ts
├── prompts/
│   ├── requirement.md
│   ├── spec.md
│   ├── design.md
│   ├── task-planning.md
│   ├── implementation.md
│   └── verification.md
└── tests/
    ├── workflow.test.ts
    ├── approval.test.ts
    └── recovery.test.ts
```

This layout is a suggestion, not a requirement. Adapt it to the current repository and pi Extension conventions.

Do not create empty modules merely to match this tree.

### Separation of responsibilities

- **Extension entry point:** registers pi commands, tools, and necessary lifecycle hooks.
- **Workflow controller:** determines the current phase and validates transitions.
- **Phase executor:** prepares the context and invokes the LLM using the supported pi API.
- **Artifact store:** manages phase outputs, revisions, and content hashes.
- **Approval manager:** creates and resolves human approval requests.
- **Persistence layer:** stores workflow state and approval history.
- **Prompts:** provide phase-specific instructions without controlling authoritative workflow state.

Keep workflow logic independently testable, even though the deliverable is a single pi Extension.

## 5. Workflow State and Transition Rules

Implement an explicit workflow state machine.

At minimum, support:

```ts
type WorkflowStatus =
  | "IDLE"
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "REJECTED"
  | "COMPLETED"
  | "FAILED";

type Phase =
  | "requirement"
  | "spec"
  | "design"
  | "task_planning"
  | "implementation"
  | "verification";
```

A workflow record should contain at least:

- `workflow_id`
- `change_id`
- `current_phase`
- `status`
- `revision`
- `pending_approval_id`
- `created_at`
- `updated_at`

Add fields where necessary to support recovery and integrity.

### Required invariants

1. A new change starts at `requirement`.
2. Only the defined phase sequence is legal.
3. A phase cannot advance until its required artifact has been generated and validated.
4. A completed phase must create an approval request.
5. The workflow enters `AWAITING_APPROVAL` and stops.
6. Only an explicit, valid approval can advance the workflow.
7. A rejection preserves the artifact, rejection reason, and review history.
8. After rejection, the same phase must be revised and reviewed again.
9. A rejected phase must not advance merely because `/factory run` is called.
10. A completed workflow cannot restart implicitly.
11. Invalid transitions must return an actionable error without modifying workflow state.
12. Every state-changing operation must be persisted before reporting success.

Use explicit transition functions, such as:

```ts
completePhase(...)
approvePhase(...)
rejectPhase(...)
resumeWorkflow(...)
failWorkflow(...)
```

Do not expose an unrestricted operation that lets an LLM assign arbitrary workflow states.

Do not rely on the LLM to remember the current phase or approval status.

## 6. Human Approval Gates

Require human approval after every phase in the MVP.

The approval lifecycle is:

1. Execute the current phase.
2. Validate its output against the phase's minimum artifact contract.
3. Save the artifact and its revision.
4. Calculate and persist a content hash.
5. Create an approval record bound to the exact artifact revision and hash.
6. Set the workflow to `AWAITING_APPROVAL`.
7. Stop automatic progression.
8. Display the artifact location, summary, and approval instructions.
9. Wait for explicit human input.
10. On approval, validate the approval record and artifact hash before advancing.
11. On rejection, preserve the rejection feedback and request a revision of the same phase.

An approval record should include:

- `approval_id`
- `workflow_id`
- `change_id`
- `phase`
- `artifact_revision`
- `artifact_hash`
- `status`
- `reviewer` or an appropriate local user identifier, if available
- `review_comment`
- `created_at`
- `resolved_at`

Approval statuses should distinguish at least `PENDING`, `APPROVED`, and `REJECTED`.

If the artifact changes after the approval request was created, the old approval must become invalid. Require a new review.

An approval must not be inferred from an LLM response, a successful tool call, or the completion of a phase.

Use pi's supported interactive UI where appropriate. Also provide explicit commands so that approvals remain possible without relying on a particular UI feature.

## 7. Persistence and Artifacts

Persist workflow state and approval history across pi sessions and process restarts.

Prefer SQLite if it can be used reliably with the installed pi runtime. Otherwise, choose the simplest reliable local persistence mechanism supported by the repository and document the trade-off.

Do not introduce a separate database service.

Use transactions for operations that must update workflow state and approval records consistently.

Store substantial artifacts as files in a dedicated, repository-local directory. Keep metadata, revisions, hashes, and workflow relationships in the database.

Use a layout similar to:

```text
.factory/
├── factory.db
└── changes/
    └── <change_id>/
        ├── requirement.md
        ├── spec.md
        ├── design.md
        ├── task-plan.md
        ├── implementation-report.md
        └── verification-report.md
```

Adapt this layout if the repository has a better established convention.

Requirements:

- Resolve artifact paths from the current repository root.
- Avoid path traversal and unsafe artifact paths.
- Do not overwrite unrelated files.
- Track artifact revisions and hashes.
- Keep historical approval records.
- Handle missing or corrupted persistence data explicitly.
- Do not silently reset a workflow when loading fails.
- Ensure `.factory/` is excluded from version control only where appropriate; document which files should or should not be committed.

If filesystem and database updates cannot be atomic together, implement a recoverable write sequence and document its failure modes.

## 8. pi Commands

Provide the following user-facing commands, using the syntax supported by the installed pi version.

### `/factory init <description>`

Create a new change and initialize the workflow at `requirement`.

Generate a stable `change_id`. Do not silently replace an existing change.

### `/factory status`

Display:

- Current change ID
- Current phase
- Workflow status
- Current artifact revision
- Pending approval, if any
- Tasks and task progress, when available
- Most recent execution or verification result

### `/factory run`

Execute or resume the current phase.

Behavior must depend on persisted workflow state:

- `IDLE`: start the current phase.
- `RUNNING`: resume safely or explain why resumption is unsafe.
- `AWAITING_APPROVAL`: refuse to execute the next phase.
- `REJECTED`: revise the current phase using saved rejection feedback.
- `COMPLETED`: report that the workflow is complete.
- `FAILED`: require an explicit, safe recovery path.

A `/factory run` invocation must never bypass a pending approval.

### `/factory approve [comment]`

Approve the pending phase only after validating the approval request and artifact hash.

Advance the workflow to the next phase, or mark it completed after final approval.

Do not automatically execute the next phase in the same approval operation. Keep approval and phase execution as separate explicit actions.

### `/factory reject <reason>`

Reject the pending artifact, preserve the review feedback, and return the workflow to a state that requires revision of the same phase.

Do not advance the phase.

### `/factory resume`

Reload persisted state and resume only if the current state permits it.

Never bypass an approval gate during recovery.

### `/factory tasks`

Display the task plan and task progress for the current change, when available.

If pi's command interface cannot support an optional argument or interaction exactly as written, adapt to the actual API and document the syntax.

## 9. LLM Execution

Use the pi-supported mechanism for requesting model execution and managing Extension context.

Do not assume that an Extension can directly invoke another agent or recursively call the pi agent loop unless the installed API explicitly supports that behavior.

Build each phase's context from persisted artifacts, not from conversational memory alone.

For each execution, provide:

- Current change ID and revision
- Current phase and its objective
- Relevant previously approved artifacts
- Rejection feedback, if this is a revision
- Required output artifact path or output format
- Explicit constraints on scope and behavior
- The phase's completion criteria

The LLM may propose content and implementation changes, but it must not authoritatively update workflow state or approve its own output.

Validate model-generated artifacts before accepting them. If generation fails, preserve existing data and record the failure.

Prompts must not contain secrets or unnecessary environment information.

## 10. Error Handling and Recovery

Implement explicit handling for at least:

- Missing or invalid change ID
- No active change
- Illegal phase transition
- Pending approval
- Stale approval due to changed artifact hash
- LLM execution failure
- Invalid or incomplete phase artifact
- Database read/write failure
- Missing artifact file
- Interrupted phase execution
- Failed test or verification command
- Repeated command invocation
- pi session restart

Operations should be idempotent where appropriate. A repeated approval must not advance two phases. A repeated initialization must not overwrite an existing change.

Do not automatically rerun potentially destructive implementation commands after interruption. Determine what is safe to resume and explain when human intervention is needed.

## 11. Security and Enforcement Boundaries

The Extension must enforce its own workflow transitions and approval rules.

However, do not claim that Extension hooks alone provide a complete security boundary against an agent that can use arbitrary shell commands or directly modify repository files or the database.

Document:

- Which operations are enforced by Extension code
- Which operations can potentially be bypassed by unrestricted shell or filesystem access
- How artifact hash checks detect unauthorized or stale modifications
- What additional isolation would be needed for stronger enforcement

Do not implement a custom sandbox as part of this MVP.

## 12. Testing Requirements

Write automated tests for the workflow controller and approval logic.

At minimum, test the following:

1. A new change starts at `requirement`.
2. The six phases follow the required order.
3. A phase cannot advance without approval.
4. `/factory run` cannot bypass a pending approval.
5. Approval advances exactly one phase.
6. Rejection preserves feedback and keeps the same phase.
7. A revised artifact invalidates the old approval.
8. Repeated approval does not advance the workflow twice.
9. An invalid transition leaves persisted state unchanged.
10. Workflow state survives reloading from persistence.
11. Missing or corrupted persistence data produces an explicit error.
12. An interrupted execution does not silently skip work.
13. Failed required verification checks prevent a successful verification result.
14. Existing user changes are not overwritten during initialization.

Use the repository's existing test framework where possible.

Prefer unit tests that do not require starting an interactive pi session. Add a small integration test or documented manual smoke test for the Extension entry point.

## 13. Acceptance Criteria

The MVP is complete only when all of the following are true:

- The Extension loads successfully in the target pi version.
- The commands are registered and documented.
- A change can be created and inspected.
- The workflow progresses through all six phases in order.
- Every phase requires explicit human approval.
- A pending approval blocks execution of the next phase.
- Rejection triggers revision of the same phase.
- Artifacts and workflow state survive process restarts.
- Task planning produces a reviewable, small task list.
- Implementation and verification record real execution evidence.
- Required verification failures are not reported as success.
- Automated tests pass, or any failures are explicitly documented with their causes.
- The README explains installation, commands, storage, recovery, limitations, and a complete example workflow.

## 14. Out of Scope

Do not implement the following in this MVP:

- Support for Codex, Claude Code, or other agent runtimes
- A standalone Workflow Engine service
- A standalone Go Task Engine
- Distributed task scheduling
- Parallel task execution
- Multi-worker Claim/Lease coordination
- Lease renewal and fencing-token protocols
- Dynamic workflow definitions or hot-reloadable state machines
- A generic plugin framework for arbitrary phases
- Autonomous iteration without a bounded stopping condition
- A custom sandbox
- A web dashboard
- Unnecessary abstraction layers

Keep the implementation focused on correctness, recoverability, and a demonstrable end-to-end workflow.

## 15. Implementation Procedure

Execute the work in this order:

1. Inspect the repository and target pi API.
2. Implement the minimum Extension entry point and command registration.
3. Implement workflow state transitions and persistence.
4. Implement artifact storage and phase contracts.
5. Implement human approval and rejection gates.
6. Implement the six phase prompts and execution integration.
7. Implement task planning and the sequential task checklist.
8. Implement verification reporting.
9. Add automated tests and a manual smoke-test procedure.
10. Run formatting, type checking, tests, and any relevant build checks.
11. Fix discovered defects and rerun the affected checks.
12. Update the README with actual behavior and limitations.

Do not stop after generating a plan or scaffolding. Continue until the MVP is implemented and verified to the extent possible in the current environment.

At the end, report:

- What was implemented
- Important architectural decisions
- Files created or changed
- Commands executed and their actual results
- Tests passed and failed
- Known limitations
- Exact instructions to load and try the Extension in pi
- Any remaining blockers

Do not claim that a command, test, or feature works unless it was actually verified.
