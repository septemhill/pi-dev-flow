# pi-ai-factory — AI Software Factory for pi

A single [pi](https://github.com/badlogic/pi-mono) extension that runs a **human-approved,
six-phase AI software development workflow** for your repository. The LLM proposes content;
this extension owns the state machine. Every phase transition is validated in code, persisted
in SQLite, and gated behind an explicit human approval that is cryptographically bound to the
exact artifact it reviews.

> The LLM is never the authoritative source of workflow state. It can *propose* artifacts,
> tasks, and check results through narrow tools; it **cannot** set workflow status, skip
> phases, advance without approval, approve its own output, or bypass artifact validation.

Every phase artifact is **template-driven and schema-validated**: it must follow a pinned,
versioned Markdown template, parse deterministically, and pass a four-layer validation
pipeline (structure → JSON Schema → cross-artifact traceability → phase semantics) before it
is recorded and offered for approval. An invalid candidate is rejected with an actionable
diagnostic list, recorded nowhere, and the workflow does not move. Validation cannot be
skipped, reconfigured, or extended from the conversation.

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

Each phase produces one artifact that must conform to its **artifact contract** (below);
`factory_phase_complete` runs the full validation pipeline and fails with an actionable list
of every problem, so nothing invalid is ever recorded or put up for approval.

## Artifact contracts & validation

Every phase is bound in code (`src/artifacts/artifact-registry.ts`) to a pinned contract:
a versioned Markdown **template** (`src/templates/<phase>.template.md`), a JSON Schema
(draft 2020-12, `src/schemas/<phase>.schema.json`), and a parser version. The LLM is handed
the exact template plus the rules it must satisfy, but it **cannot change any part of the
contract** — the template, schema, parser, and validation rules are pinned in code, loaded
from the extension's own directory, and fail closed: if a template or schema cannot be
loaded, validation is refused (`CONTRACT_ERROR`) rather than skipped.

### The four-layer pipeline (all layers always run)

| Layer | What it checks | Enforced by |
|---|---|---|
| 1. **Structure** | The file parses as the pinned template: exact section names/order, `## Metadata` key-values, `### PREFIX-NNN: Title` records with allowed fields, not-applicable markers only where allowed, no unknown sections/fields, no duplicate ids, code fences never parsed as structure | `src/artifacts/markdown-parser.ts` |
| 2. **Schema** | The parsed JSON document validates against the pinned JSON Schema (draft 2020-12, Ajv + ajv-formats, pinned in code): required metadata, enums, id formats, record field types, `additionalProperties: false` | `src/artifacts/schema-validator.ts` |
| 3. **Traceability** | Every approved upstream artifact still exists on disk with exactly its recorded sha256 (tamper/staleness → `TRACE_UPSTREAM_MODIFIED`/`_MISSING`); every `REQ/FR/AC/DES` id mentioned anywhere in the document (outside code fences) resolves to a record in the pinned upstream artifact; ids are compared zero-padding-agnostically (`AC-1` ≡ `AC-001`); legacy upstreams are flagged (`TRACE_UPSTREAM_LEGACY`) | `src/artifacts/traceability-validator.ts` |
| 4. **Semantics** | Phase rules against *persisted* state: metadata binding (change id, contract version, expected revision, `Status: complete`), requirement source citations, AC/requirement coverage, task plan ↔ recorded plan mirror (count, ids, titles), acyclic backward-only task dependencies, implementation task results ↔ recorded tasks with real evidence, verification checks ↔ recorded checks with recomputed verdict (never trusted from the document), pinned upstream revisions + sha256 | `src/artifacts/semantic-validator.ts` |

A candidate with **any ERROR** is rejected: nothing is recorded, no approval is requested,
and the full diagnostics (code, location, message, suggested fix) are returned to the model.
Every validation run — pass or fail — is persisted to the `validation_results` table for
audit. `/factory validate` re-runs the pipeline on the current phase's artifact with no side
effects.

### Deterministic & testable

The entire pipeline is pure: `(candidate file, persisted workflow state) → result`. No pi
runtime imports, no network, no randomness. The same candidate always yields the same result
for the same workflow state, which is what makes the gate un-bypassable and the whole thing
unit-testable without a pi session.

### Legacy artifacts

Artifacts recorded before template-driven validation existed have `contract = NULL` in the
artifact registry. They are **marked, not trusted**: `/factory status` flags them as legacy,
and while such an artifact is the upstream of a running phase, downstream validation fails
with a single actionable `TRACE_UPSTREAM_LEGACY` error — re-run that phase to regenerate a
conformant, re-approved artifact. Every artifact recorded now stores the pinned contract it
was validated against.

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
| `/factory validate` | Re-run the full four-layer artifact validation on the current phase's artifact and print the result. **No side effects** — it never records, advances, or requests approval. Handy to check a draft before calling `factory_phase_complete`. |

## Tools (LLM-callable, narrowly scoped)

| Tool | Phase | What it can do — and nothing more |
|---|---|---|
| `factory_requirement_append` | requirement (RUNNING) | Append one verbatim requirement to the **append-only** history. No edits, no deletes. |
| `factory_set_task_plan` | task_planning (RUNNING) | Record 1–15 tasks, each with title, scope, references, verification. |
| `factory_task_update` | implementation (RUNNING) | Move one task PENDING → IN_PROGRESS → DONE. DONE requires evidence. |
| `factory_check_record` | verification (RUNNING) | Record one check: name, required, PASSED/FAILED/SKIPPED/MANUAL, output. |
| `factory_phase_complete` | any (RUNNING) | Run the full artifact validation pipeline; only if it passes, record the phase artifact (sha256 + contract), create the approval request, and pause at AWAITING_APPROVAL. Any error → nothing recorded, diagnostics returned. |
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
  source of truth for content (re-hashed on every approval). Each recorded artifact row stores
  the pinned **contract** (`templateId@templateVersion`) it was validated against — `NULL`
  marks a legacy, pre-contract artifact. Every validation run is persisted to the
  `validation_results` table (change, phase, candidate sha256, pass/fail, issue counts,
  contract versions, full result JSON, timestamp) for audit.
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
npm test              # node --test (63 tests: workflow, approval, recovery, parser, schema, semantic, traceability, approval-validation, legacy)
```

Live smoke test:

```bash
mkdir /tmp/factory-smoke && cd /tmp/factory-smoke
pi -p --extension /path/to/pi-ai-factory/index.ts "/factory init hello"
```

## Layout

```
index.ts                          # extension entry: /factory command + 6 tools + widget
src/engine.ts                     # FactoryEngine — the only code that mutates workflow state
src/workflow/phases.ts            # phase order, artifact files
src/workflow/transitions.ts       # pure, total transition functions (the whole state machine)
src/workflow/errors.ts            # typed WorkflowError + human-readable descriptions
src/workflow/state.ts             # record types
src/persistence/database.ts       # node:sqlite schema + transactional access
src/artifacts/artifact-registry.ts# pinned contracts: template id/version + schema id per phase
src/artifacts/artifact-types.ts   # shared artifact/issue/record types
src/artifacts/template-loader.ts  # load the pinned template for a contract
src/artifacts/markdown-parser.ts  # 1. deterministic template → JSON parse
src/artifacts/schema-validator.ts # 2. JSON Schema (draft 2020-12, Ajv) validation
src/artifacts/traceability-validator.ts # 3. upstream integrity + cross-artifact id resolution
src/artifacts/semantic-validator.ts     # 4. phase rules vs. persisted state
src/artifacts/artifact-validator.ts     # pipeline orchestrator + result formatting
src/artifacts/artifact-store.ts   # path-safe artifact file I/O + sha256
src/templates/*.template.md       # the six pinned artifact templates
src/schemas/*.schema.json         # the six pinned JSON Schemas (draft 2020-12)
src/approvals/approval-manager.ts # approval preconditions (pending, hash-still-matches)
src/execution/phase-executor.ts   # builds the per-phase LLM work order from persisted state
src/commands/factory.ts           # /factory command handler
prompts/*.md                      # the six phase instruction templates
tests/                           # test suites (workflow, approval, recovery, template-parser,
                                  #   schema-validation, semantic-validation, traceability,
                                  #   approval-validation, legacy) + shared fixtures
```
