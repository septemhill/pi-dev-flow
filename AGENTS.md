# AGENTS.md — working agreement for agents in this repository

This repository is **pi-ai-factory**: a pi Extension that runs a human-approved,
six-phase development workflow (`/factory`). The LLM proposes content; the
Extension enforces the state machine, artifact contracts, and approval gates.
Never claim a phase is approved, a transition happened, or a gate passed unless
the extension reported it.

## Fixed workflow (never bypass)

`requirement → spec → design → task planning → implementation → verification`

Every phase artifact must pass the extension's pinned contract (structure →
JSON Schema → traceability → semantics) and a human approval before the
workflow advances. Use the `factory_*` tools only within their documented
phase gates.

## Project Knowledge Discovery

The extension manages three reusable, project-level knowledge records:

- **Constraint** (`CON-###`) — a restriction applicable implementations must not violate.
- **Convention** (`CVN-###`) — a reusable development practice or project standard.
- **Tech Decision** (`ADR-###`) — an explicit technology/architecture decision with context, rationale, alternatives, and consequences.

Canonical JSON lives in `.factory/knowledge/`, generated Markdown in
`.factory/generated/knowledge/` (projection only — never edit it by hand).
Schemas live in the extension's `src/schemas/project-knowledge/`.

During **Requirement Understanding** (the requirement phase), you MUST:

1. **Identify** potential project-level constraints, conventions, and
   technology decisions in the user's original prompt — a restriction or
   prohibited behavior, a reusable practice, or an explicit/implied
   technology choice.
2. **Distinguish** change-specific requirements (which stay as REQ records in
   the change artifacts) from reusable project knowledge. Do not force an
   ambiguous statement into one category; record it as an Open Question and
   flag it as a candidate.
3. **Check existing Project Knowledge first** (it is listed in your work
   order; or run `/factory knowledge list`). Reuse an existing id when a
   record already states the same rule or decision — do not create duplicates
   merely because the wording differs.
4. **Present ambiguous candidates for confirmation**: never silently change
   the project baseline. If the user explicitly asks for a project-wide rule
   or decision, you may prepare the draft directly — it still goes through
   validation and the approval gate.
5. **Preserve traceability**: note each candidate in the requirement
   artifact's Open Questions as
   `[knowledge-candidate] <type>: <summary> — drafted as <ID>, pending
   approval (source R<n>)`, and pass the change id / requirement entry to the
   draft tool.
6. **Use extension-managed operations only**: persist drafts with the
   `factory_knowledge_draft` tool; everything else (listing, inspecting,
   validating, approving, deprecating) goes through `/factory knowledge …`.
7. **Never mark inferred knowledge as approved.** Drafts enter as `draft`;
   only the human command `/factory knowledge approve <id>` makes a record
   effective. A confident classification is not authorization, and knowledge
   discovery never moves any workflow phase or approval gate.
