# pi-ai-factory — AI Software Factory for pi

A single [pi](https://github.com/badlogic/pi-mono) extension that runs a **human-approved,
six-phase AI software development workflow** for your repository. The LLM proposes content;
this extension owns the state machine. Every phase transition is validated in code, persisted
in SQLite, and gated behind an explicit human approval that is cryptographically bound to the
exact artifact it reviews.

> The LLM is never the authoritative source of workflow state. It can *propose* artifacts,
> tasks, and check results through narrow tools; it **cannot** set workflow status, skip
> phases, advance without approval, or approve its own output.

## The six phases

```
requirement → spec → design → task_planning → implementation → verification → COMPLETED
     ▲          │          │          │             │               │
     └──────────┴──────────┴──────────┴─────────────┴───────────────┘
                     every arrow requires: /factory approve
```

| # | Phase          | Artifact (in the change dir)                          | Human reviews…                                |
|---|----------------|-------------------------------------------------------|-----------------------------------------------|
| 1 | requirement    | `requirement.md` (+ append-only `requirements-history.md`) | goal, user stories, out-of-scope, acceptance criteria |
| 2 | spec           | `spec.md`                                              | functional behavior, inputs/outputs, edge cases |
| 3 | design         | `design.md`                                            | architecture, components, data, interfaces     |
| 4 | task_planning  | `task-plan.md` (+ structured tasks in SQLite)          | small, independently verifiable tasks          |
| 5 | implementation | `implementation-report.md` (+ per-task evidence)       | code matches plan, tasks DONE with evidence    |
| 6 | verification   | `verification-report.md` (+ recorded checks)           | every required check PASSED                    |

Each phase artifact must contain the required sections for its phase (enforced in code);
`factory_phase_complete` fails with an actionable list of everything that is missing.

## Install

No build step — pi loads TypeScript directly:

```bash
cd /path/to/your/project
pi --extension /path/to/pi-ai-factory/index.ts
```

Or install it permanently for one project (`.pi/extensions/`) or for all projects
(`~/.pi/agent/extensions/`) by copying/symlinking the `pi-ai-factory` directory there.

Requires Node ≥ 22.5 (built-in `node:sqlite`).

## Quick start

```text
/factory init add a greeting CLI tool     # 1. create the change (requirement, IDLE)
/factory run                              #    start the requirement phase
#   → the agent interviews you, writes requirement.md, requests approval
/factory status                           #    (check progress any time)
/factory approve requirement looks right  # 2. human approval → advances to spec (IDLE)
/factory run                              # 3. explicitly run the spec phase
#   → the agent writes spec.md, requests approval
#   → repeat approve + run per phase;
#   → after verification is approved the workflow is COMPLETED
```

## Commands (human only — the LLM cannot call these)

| Command | Effect |
|---|---|
| `/factory init <description>` | Create a new change + workflow. Refused while another change is active (`ACTIVE_CHANGE_EXISTS`) — existing work is never silently replaced. |
| `/factory status` | Current phase, status, artifact revisions, tasks, checks, recent review events. |
| `/factory run` | Start (or re-start after rejection) the current phase, sending the phase work order to the agent. **Refused while an approval is pending** — the gate cannot be bypassed. On an interrupted RUNNING phase it safely re-prompts the same phase. |
| `/factory approve [comment]` | Approve the pending review. Advances **exactly one phase** (or completes the workflow). |
| `/factory reject <reason>` | Reject the pending review with a mandatory reason. Stays on the same phase; the agent must revise and re-request review. |
| `/factory resume` | Explicit recovery after a crash/failure. Reconciles persisted state, flags integrity problems, and only then allows the workflow to continue. Never bypasses an approval gate. |
| `/factory tasks` | Show the implementation task plan and per-task evidence. |
| `/factory changes` | List all changes and their state. |

## Tools (LLM-callable, narrowly scoped)

| Tool | Phase | What it can do — and nothing more |
|---|---|---|
| `factory_requirement_append` | requirement (RUNNING) | Append one verbatim requirement to the **append-only** history. No edits, no deletes. |
| `factory_set_task_plan` | task_planning (RUNNING) | Record 1–15 tasks, each with title, scope, references, verification. |
| `factory_task_update` | implementation (RUNNING) | Move one task PENDING → IN_PROGRESS → DONE. DONE requires evidence. |
| `factory_check_record` | verification (RUNNING) | Record one check: name, required, PASSED/FAILED/SKIPPED/MANUAL, output. |
| `factory_phase_complete` | any (RUNNING) | Validate + record the phase artifact (sha256), create the approval request, pause at AWAITING_APPROVAL. |
| `factory_report_failure` | any (RUNNING) | Mark execution FAILED with a reason. Requires `/factory resume` to continue. |

There is deliberately **no** `factory_approve` tool and no tool that sets workflow status.

## State model

Workflow status is a closed machine — the only transitions that exist:

```
IDLE ──run──▶ RUNNING ──complete──▶ AWAITING_APPROVAL
  ▲              ▲  ▲                    │
  │              │  └────────resume──────┤
  │              │                       ├─approve─▶ IDLE(next phase) | COMPLETED
  └──reject──────┴───────────────────────└─reject──▶ REJECTED ──run──▶ RUNNING
  │                          ▲
  │                          └── /factory run reopens the phase when the pending
  │                              approval is no longer PENDING (it was invalidated by an
  │                              artifact change) — a live PENDING approval always blocks
  └──────────▶ FAILED (explicit failure) ──resume──▶ IDLE
```

* `PENDING_APPROVAL` — `/factory run` while an approval is pending is an error, not a bypass.
* `STALE_APPROVAL` — approvals store the artifact's `revision` + `sha256`. If the file changed
  after the request, the approval is **INVALIDATED** (persisted, with an event) and must be
  re-requested. A stale approval can never advance the workflow.
* Repeated approve/reject of an already-resolved approval is refused (`ILLEGAL_TRANSITION`).
* A failed required check (FAILED or SKIPPED) blocks verification completion
  (`VERIFICATION_FAILED`) — a "successful" verification is impossible on red checks.
* Every refused transition leaves persisted state **byte-identical** (no partial writes:
  all mutations happen in single SQLite transactions with optimistic revision checks).

## Persistence

Everything lives under `<project>/.factory/`:

```
.factory/
  factory.db                      # SQLite: workflows, artifacts, approvals, tasks, checks, review events
  changes/<change-id>/
    requirement.md                # phase artifacts (the human-readable record)
    requirements-history.md       # append-only raw requirement statements
    spec.md  design.md  task-plan.md
    implementation-report.md
    verification-report.md
```

* The **database is the single source of truth** for workflow status; artifacts are the
  source of truth for content (re-hashed on every approval).
* A workflow mid-phase (`RUNNING`) that survives a crash is not silently skipped: `/factory
  resume` recovers it to the same phase and `/factory run` re-prompts it, explicitly flagged
  as a possibly-interrupted re-run.
* A corrupted/missing database produces an explicit `PERSISTENCE_ERROR` with recovery
  guidance — never a silent reset. Existing change files are never overwritten by
  re-initialization.
* Every state change appends to an append-only `review_events` audit log
  (`CHANGE_CREATED`, `PHASE_STARTED`, `APPROVAL_INVALIDATED`, `PHASE_APPROVED`, …).

## Development

```bash
npm install
npm run typecheck     # strict tsc --noEmit
npm test              # node --test (24 tests: workflow, approval gates, recovery)
```

Live smoke test:

```bash
mkdir /tmp/factory-smoke && cd /tmp/factory-smoke
pi -p --extension /path/to/pi-ai-factory/index.ts "/factory init hello"
```

## Layout

```
index.ts                     # extension entry: /factory command + 6 tools + widget
src/engine.ts                # FactoryEngine — the only code that mutates workflow state
src/workflow/phases.ts       # phase order, artifact files, required sections
src/workflow/transitions.ts  # pure, total transition functions (the whole state machine)
src/workflow/errors.ts       # typed WorkflowError + human-readable descriptions
src/workflow/state.ts        # record types
src/persistence/database.ts  # node:sqlite schema + transactional access
src/artifacts/artifact-store.ts # path-safe artifact file I/O + sha256
src/approvals/approval-manager.ts # approval preconditions (pending, hash-still-matches)
src/execution/phase-executor.ts   # builds the per-phase LLM work order from persisted state
src/commands/factory.ts      # /factory command handler
prompts/*.md                 # the six phase instruction templates
tests/*.test.ts              # workflow / approval / recovery test suites
```
