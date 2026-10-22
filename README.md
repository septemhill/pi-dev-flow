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
| 3. **Traceability** | Upstream integrity + id resolution (see layer 3 of the table below) **and** the coverage gate: the traceability graph is extracted from the pinned artifacts, the deterministic coverage engine assesses the stage(s) this phase is responsible for, and every uncovered mandatory item blocks the phase (fail-closed). Waivers are explicit, auditable exceptions — never silent | `src/artifacts/traceability-validator.ts` + `src/traceability/*` |
| 4. **Semantics** | Phase rules against *persisted* state: metadata binding (change id, contract version, expected revision, `Status: complete`), requirement source citations, task plan ↔ recorded plan mirror (count, ids, titles), acyclic backward-only task dependencies, implementation task results ↔ recorded tasks with real evidence, verification checks ↔ recorded checks with recomputed verdict (never trusted from the document), pinned upstream revisions + sha256 | `src/artifacts/semantic-validator.ts` |

A candidate with **any ERROR** is rejected: nothing is recorded, no approval is requested,
and the full diagnostics (code, location, message, suggested fix) are returned to the model.
Every validation run — pass or fail — is persisted to the `validation_results` table for
audit. `/factory validate` re-runs the pipeline on the current phase's artifact with no side
effects.

## Traceability & coverage

Coverage is **explicit, deterministic, and fail-closed**. The extension never infers
relationships from free text and never treats "referenced" as "covered": a reference proves
only that a relationship was *declared*; whether the downstream item actually addresses the
upstream obligation is a separate, explicitly-attested review (below). The traceability
graph is **derived, not stored** — it is recomputed on every validation and report from the
immutable, content-hashed artifact files, which remain the single source of truth.

### The relationship contract (pinned in code)

Links always point **downstream → upstream** (the later-phase item declares the link to the
upstream obligation it addresses). Only these pairs exist (`src/traceability/relations.ts`);
anything else is a `TRACE_INVALID_RELATION` error — the LLM cannot invent relationships:

| Relation | Source → Target | Contributes to coverage stage |
|---|---|---|
| `SATISFIES` | FR / AC → REQ | requirement → spec |
| `DERIVED_FROM` | AC → FR | — (spec-internal provenance) |
| `REALIZES` | DES → FR / AC | spec → design |
| `IMPLEMENTS` | TASK → REQ / FR / AC / DES | spec → tasks |
| `VERIFIES` | CHK → REQ / FR / AC | acceptance → verification (needs real evidence) |
| `DEPENDS_ON` | TASK → TASK | — (same-plan ordering only) |

Each record field has a pinned projection of this contract (e.g. an FR may cite only `REQ`
ids, a DES only `FR/AC`, a CHK only `REQ/FR/AC`). Citing a prefix a field may not cite is a
hard error with a suggested fix. Ids compare zero-padding-agnostically (`AC-1` ≡ `AC-001`).

### Coverage stages & states

The deterministic coverage engine (`src/traceability/coverage.ts`) assesses exactly the
stage(s) each phase gate is responsible for, using only validated graph data:

| Stage (gate phase) | Item is covered ⇔ |
|---|---|
| requirement → spec *(spec)* | ≥ 1 `SATISFIES` link from an FR or AC. `MUST` requirements are mandatory; `SHOULD`/`COULD` gaps warn but do not block. |
| spec → design *(design)* | ≥ 1 `REALIZES` link from a DES record. |
| spec → tasks *(task_planning)* | ≥ 1 `IMPLEMENTS` link from a TASK. |
| tasks → implementation *(implementation)* | the task's Task Result is `COMPLETED` **with evidence**. |
| acceptance → verification *(verification)* | ≥ 1 `VERIFIES` link from a check with **PASS** status. FAILED ⇒ the item is `FAILED` (blocking). SKIPPED/absent ⇒ uncovered — a skipped mandatory check never counts as success. NEEDS_HUMAN-only ⇒ explicitly unresolved (`humanPending`), warned at approval, never promoted. |

States: `UNCOVERED`, `PARTIAL`, `COVERED`, `VERIFIED`, `FAILED`, `WAIVED`. `VERIFIED`
requires passing evidence, not just a link; artifact approval is never equated with
successful implementation or verification; waived items **stay in the denominator** and are
reported as waived — never silently excluded.

### Bounded semantic coverage review

Spec and design carry a `Coverage Review` section (`SR-###` records) where the model may
*attest* that a declared relationship actually covers the upstream obligation. The extension
validates every attestation deterministically: unknown ids, attested-but-undeclared links,
stage mismatches, and `PARTIAL`/`NEEDS_REVIEW` without named missing obligations are errors
or surfaced warnings. A `COVERED` attestation **never** overrides a missing reference —
deterministic findings always win (`TRACE_SEMANTIC_CONFLICT`). An inconclusive attestation
is surfaced at approval for a human; it is never auto-rejected, auto-accepted, or retried in
an unbounded loop.

### Waivers (explicit, auditable, reversible)

An uncovered *mandatory* item can be waived per item × stage with a rationale — a recorded
exception, **not** a coverage claim:

```text
/factory waive REQ-002 requirement_to_spec "Deferred to a follow-up change; user decision 2026-01-02"
/factory revoke-waiver wv-<id>
```

* Only items that exist in the recorded traceability graph at that stage can be waived —
  waivers cannot fabricate coverage for phantom ids or override already-covered items.
* A waiver **pins the current revision of every recorded artifact**; any of them advancing
  makes the waiver **STALE** — it stops applying and the gap blocks again.
* The gate reports waived items as `WAIVED` (with `TRACE_WAIVER_ACTIVE`) and the approval
  screen shows them; the workflow may proceed, but the audit trail distinguishes exception
  from verification success everywhere, including `/factory traceability`.

### Inspecting coverage

```text
/factory traceability
```

prints the deterministic report for the active change: recorded artifact revisions (with
legacy markers), graph findings, per-stage coverage percentages and per-item states, and all
waivers (active vs stale). It reads only recorded artifacts — it never invents links or
status, and a green report means exactly what the gates enforced.

### Traceability diagnostic codes

| Code | Severity | Meaning |
|---|---|---|
| `TRACE_UPSTREAM_MISSING` / `TRACE_UPSTREAM_MODIFIED` | ERROR | a pinned upstream file is gone or changed on disk (tamper/staleness) |
| `TRACE_UPSTREAM_LEGACY` | ERROR | an upstream artifact predates template-driven validation — re-run that phase (single actionable error, no per-id flood) |
| `TRACE_STALE_UPSTREAM_REVISION` | ERROR | the document pins an older upstream revision than the recorded one |
| `TRACE_UNKNOWN_ITEM` | ERROR | an id mentioned in the document does not exist in the pinned upstream documents |
| `TRACE_INVALID_RELATION` | ERROR | a reference/attestation violates the relationship contract (endpoint, field, or stage) |
| `TRACE_DUPLICATE_ITEM_ID` | ERROR | one id used for two different items (graph-level backstop; per-section duplicates are `STRUCT_DUPLICATE_RECORD_ID`) |
| `TRACE_MISSING_SPEC_COVERAGE` | ERROR / WARNING | requirement not addressed by any FR/AC (MUST ⇒ error) |
| `TRACE_MISSING_DESIGN_COVERAGE` | ERROR | FR/AC not realized by any design decision |
| `TRACE_MISSING_TASK_COVERAGE` | ERROR | FR/AC not implemented by any task |
| `TRACE_MISSING_IMPLEMENTATION_EVIDENCE` | ERROR | task without a COMPLETED result + evidence |
| `TRACE_MISSING_VERIFICATION` | ERROR / WARNING | AC without a passing check (humanPending ⇒ warning) |
| `TRACE_REQUIRED_CHECK_FAILED` | ERROR | a check that verifies an AC FAILED — verification cannot be successful |
| `TRACE_WAIVER_ACTIVE` | INFO | an explicit waiver applies (auditable exception) |
| `TRACE_REVIEW_UNKNOWN_ID` / `TRACE_REVIEW_STAGE_MISMATCH` | ERROR | coverage-review record cites unknown items or a wrong stage |
| `TRACE_REVIEW_INCONSISTENT` | ERROR | `PARTIAL`/`NEEDS_REVIEW` without naming missing obligations |
| `TRACE_SEMANTIC_CONFLICT` | ERROR | a `COVERED` attestation contradicts deterministic coverage (deterministic wins) |
| `TRACE_SEMANTIC_REVIEW` | WARNING | `PARTIAL`/`NEEDS_REVIEW` attestation — human review at approval |

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
| `/factory init <description>` | Create a new change + workflow. Refused while another change is active (`ACTIVE_CHANGE_EXISTS`) — existing work is never silently replaced. Also accepts file input: `/factory init --file <path> [--file <path> …]` (see below). |
| `/factory status` | Current phase, status, artifact revisions, tasks, checks, recent review events. |
| `/factory run` | Start (or re-start after rejection) the current phase, sending the phase work order to the agent. **Refused while an approval is pending** — the gate cannot be bypassed. On an interrupted RUNNING phase it safely re-prompts the same phase. |
| `/factory approve [comment]` | Approve the pending review. Advances **exactly one phase** (or completes the workflow). |
| `/factory reject <reason>` | Reject the pending review with a mandatory reason. Stays on the same phase; the agent must revise and re-request review. |
| `/factory resume` | Explicit recovery after a crash/failure. Reconciles persisted state, flags integrity problems, and only then allows the workflow to continue. Never bypasses an approval gate. |
| `/factory tasks` | Show the implementation task plan and per-task evidence. |
| `/factory changes` | List all changes and their state. |
| `/factory validate` | Re-run the full four-layer artifact validation on the current phase's artifact and print the result. **No side effects** — it never records, advances, or requests approval. Handy to check a draft before calling `factory_phase_complete`. |
| `/factory traceability` | Print the deterministic coverage report: recorded revisions, per-stage coverage with per-item states, uncovered items, graph findings, waivers (active/stale), legacy markers. |
| `/factory waive <item-id> <stage> <rationale…>` | Grant an explicit, auditable coverage waiver for one item at one stage (rationale ≥ 10 chars; item must exist in the recorded graph and not already be covered). Pins current artifact revisions — upstream changes STALE the waiver. |
| `/factory revoke-waiver <waiver-id>` | Revoke an active waiver; the deterministic coverage assessment stands again immediately. |

### `/factory init` input

```text
/factory init Implement a user authentication feature
/factory init --file requirements/authentication.md
/factory init --file requirements/authentication.md --file requirements/security.md
/factory init @requirements/authentication.md @requirements/security.md
```

- **Inline vs. files.** Use inline text for a short, self-contained change
  description. Use `--file` / `@<path>` when the requirement content lives in
  one or more existing documents — the files are read verbatim (no
  summarizing or merging by the command) and fed into the same
  requirement-understanding entry point as inline text. Inline text and file
  inputs cannot be combined in one invocation (`INVALID_INIT_INPUT`) — put
  extra context into a file instead.
- **Multiple files.** `--file` is repeatable, and `@<path>` is a shorthand
  for `--file <path>` (both repeatable, and usable in the same invocation).
  Files are combined in the order the references appear, with a
  `# Input File N: <path>` header and a `---` separator between files so
  their contents stay distinct. Each file's content (headings, lists, code
  blocks) is preserved verbatim. Note: `--file @foo.md` names the literal
  file `@foo.md` — only bare `@<path>` tokens are shorthand.
- **Path resolution.** Relative paths resolve against the working directory
  the extension runs in; absolute paths work as-is. No directory traversal,
  wildcards, or remote input. Provenance labels use the project-relative path
  when available, absolute otherwise.
- **Validation before state.** All files are read and validated (exist,
  regular file, readable, valid UTF-8, non-whitespace) *before* any workflow
  state is created. A missing, unreadable, or empty file aborts initialization
  with an error naming that file (`INVALID_INIT_INPUT`) and leaves no partial
  change behind. Duplicate paths are rejected. No input at all prints usage
  without initializing. (File paths must not contain spaces — the pi command
  line has no quote layer.)

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
* A failed required check (FAILED or SKIPPED) blocks verification completion — the coverage
gate reports `TRACE_REQUIRED_CHECK_FAILED` at the acceptance → verification stage (and a
phase-invariant backstop raises `VERIFICATION_FAILED`), so a "successful" verification is
impossible on red checks.
* Every refused transition leaves persisted state **byte-identical** (no partial writes:
  all mutations happen in single SQLite transactions with optimistic revision checks).

## Persistence

Everything lives under `<project>/.factory/`:

```
.factory/
  factory.db                      # SQLite: workflows, artifacts, approvals, tasks, checks, waivers, review events
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
  contract versions, full result JSON, timestamp) for audit. Waivers live in the `waivers`
table (item × stage, rationale, status, pinned revisions) — exactly one active waiver per
item×stage; grants/revocations are audit events.
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
npm test              # vitest run (96 tests: workflow, approval, recovery, parser, schema, semantic, traceability, coverage, approval-validation, legacy)
npm run test:watch    # vitest in watch mode
```

Live smoke test:

```bash
mkdir /tmp/factory-smoke && cd /tmp/factory-smoke
pi -p --extension /path/to/pi-ai-factory/index.ts "/factory init hello"
```

## Layout

```
index.ts                                # extension entry: /factory command + 6 tools + widget
src/engine.ts                           # FactoryEngine — the only code that mutates workflow state
src/workflow/phases.ts                  # phase order, artifact files
src/workflow/transitions.ts             # pure, total transition functions (the whole state machine)
src/workflow/errors.ts                  # typed WorkflowError + human-readable descriptions
src/workflow/state.ts                   # record types
src/persistence/database.ts             # node:sqlite schema + transactional access
src/artifacts/artifact-registry.ts      # pinned contracts: template id/version + schema id per phase
src/artifacts/artifact-types.ts         # shared artifact/issue/record types
src/artifacts/template-loader.ts        # load the pinned template for a contract
src/artifacts/markdown-parser.ts        # 1. deterministic template → JSON parse
src/artifacts/schema-validator.ts       # 2. JSON Schema (draft 2020-12, Ajv) validation
src/artifacts/traceability-validator.ts # 3. upstream integrity + cross-artifact id resolution
src/artifacts/semantic-validator.ts     # 4. phase rules vs. persisted state
src/artifacts/artifact-validator.ts     # pipeline orchestrator + result formatting
src/traceability/types.ts               # trace item/link/graph + coverage state types
src/traceability/relations.ts           # the relationship contract (pinned, validated)
src/traceability/items.ts               # deterministic graph extraction from parsed artifacts
src/traceability/coverage.ts            # the deterministic coverage engine (5 stages)
src/traceability/issues.ts              # coverage → gate diagnostics mapping
src/traceability/semantic-review.ts     # bounded semantic (model) review validation
src/traceability/waivers.ts             # shared waiver resolution (gates and report agree)
src/traceability/report.ts              # /factory traceability report (build + render)
src/artifacts/artifact-store.ts         # path-safe artifact file I/O + sha256
src/templates/*.template.md             # the six pinned artifact templates
src/schemas/*.schema.json               # the six pinned JSON Schemas (draft 2020-12)
src/approvals/approval-manager.ts       # approval preconditions (pending, hash-still-matches)
src/execution/phase-executor.ts         # builds the per-phase LLM work order from persisted state
src/commands/factory.ts                 # /factory command handler
prompts/*.md                            # the six phase instruction templates
tests/                                  # test suites (workflow, approval, recovery, template-parser,
                                        # schema-validation, semantic-validation, traceability,
                                        # coverage, approval-validation, legacy) + shared fixtures
```
