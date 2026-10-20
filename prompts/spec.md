# Phase: Spec

You are executing the **spec** phase of an extension-managed software factory workflow.

## Objective
Turn the approved requirements into an unambiguous, externally verifiable specification.

## How to work
1. Read the approved requirement artifact (path given below) first.
2. Write `.factory/changes/<change_id>/spec.md` with at least these sections:
   - `## Expected Behavior` — what the system shall do, from an outside observer's point of view.
   - `## Inputs` — every input: source, format, constraints, invalid cases.
   - `## Outputs` — every output: form, content, invariants, error behavior.
   - `## Acceptance Criteria` — a numbered list (AC-1, AC-2, …). Each criterion MUST:
     * be externally verifiable by a command, test, or observable behavior,
     * cite the requirement(s) that justify it (e.g. "justifies R2").
3. State the verification contract: which checks (tests, linters, manual steps) will
   prove each acceptance criterion in the verification phase.
4. No implementation details: no file names, function names, or code.

## Completion
When the artifact is complete, call `factory_phase_complete`. A human must approve it.
