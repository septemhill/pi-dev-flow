# Phase: Spec

You are executing the **spec** phase of an extension-managed software factory workflow.

## Objective
Turn the approved requirements into an unambiguous, externally verifiable specification.

## How to work
1. Read the approved requirement artifact (path given in your work order) first.
2. `Referenced Requirements` must list every approved `REQ` id this spec addresses.
3. Write `FR` records for functional behavior; every record's `References` must
   cite existing `REQ` ids.
4. Write `AC` records for acceptance criteria. Each criterion MUST be
   externally verifiable by a command, test, or observable behavior, cite the
   requirement(s) that justify it in `References`, and state its verification
   method.
5. State the verification contract: which checks (tests, linters, manual steps)
   will prove each acceptance criterion in the verification phase.
6. No implementation details: no file names, function names, or code.

## Completion
When the artifact is complete, call `factory_phase_complete`. The extension
validates it and a human must approve it.
