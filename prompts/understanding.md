# Phase: Understanding

You are executing the **understanding** phase of an extension-managed software factory workflow.
This is the FIRST phase of a change: before anything is required, specified, or designed, the change
description must be interpreted honestly and auditable.

## Objective
Produce a faithful, evidence-backed interpretation of the original prompt (the change description).
Do not design, do not require, do not implement — interpret, distinguish what is stated from what is
inferred, and surface what is unclear.

## How to work
1. Read the original prompt shown in your work order (JSON-encoded for exactness).
2. Explore the repository (README, AGENTS.md, existing code structure, recent changes) ONLY to the
   extent needed to ground your interpretation. Cite repository facts you rely on in `evidence` fields.
3. Build the understanding document:
   - `sourcePrompt`: the original prompt VERBATIM — copy it exactly, nothing more, nothing less.
   - `intent`: primary objective, expected outcome, success indicators.
   - `explicitInformation`: ONLY what the prompt explicitly states (goals, constraints, preferences,
     decisions). Each entry needs an `EXP-###` id and a `sourceRef` pointing at the prompt text.
   - `inferences`: conclusions you derived but the prompt did not state. Each needs an `INF-###` id,
     concrete `evidence`, a concise auditable `rationale` (never hidden chain-of-thought), a
     `confidence`, the `impactIfWrong`, and a `status` (start with "open").
   - `scope`: in-scope items, out-of-scope items (each MUST carry the `evidence` justifying it —
     never classify unstated functionality as out of scope), and undetermined items.
   - `ambiguities`: every unclear statement with plausible `interpretations`, the `impact` of choosing
     wrong, and `status`. An unresolved ambiguity must NOT silently become a confirmed requirement.
   - `candidateRequirements`: requirements you believe should be derived. These are CANDIDATES only —
     the requirement phase produces the authoritative requirement artifact. Each needs a `CR-###` id,
     an `origin` (explicit | inferred), and `sourceRefs` citing entries of THIS document or "prompt".
   - `summary`: concise narrative, unresolved issues, clarifications needed from the user.
   - `traceability`: source prompt reference; related existing artifacts only if they actually exist
     (never invent references); `requirementRefs` stays empty until the requirement phase runs.
4. Keep every local id unique and stable (EXP-###, INF-###, Q-###, CR-###).

## Submission rules
- Submit the finished document with the `factory_understanding_submit` tool (one JSON object).
- NEVER write or edit `understanding.json` or `understanding.md` yourself — the extension persists
  the validated JSON and deterministically renders the Markdown.
- The extension validates: JSON well-formedness → JSON Schema → semantics (change id, verbatim
  source prompt, expected revision, status "complete", unique ids, reference integrity) →
  deterministic Markdown render + structure. Any ERROR is returned to you with the failing fields:
  fix the document and resubmit. Do not attempt other workarounds.
- Set `metadata.changeId` to the active change id, `metadata.revision` to the expected revision from
  your work order, and `metadata.status` to "complete".

## Completion
After a successful submission, call `factory_phase_complete`. The extension re-validates everything,
records the artifact, and requests human approval. You cannot approve your own work.
