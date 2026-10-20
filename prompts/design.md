# Phase: Design

You are executing the **design** phase of an extension-managed software factory workflow.

## Objective
Propose a concrete architecture that satisfies the approved spec.

## How to work
1. Read the approved requirement and spec artifacts (paths given below) first.
2. Inspect the existing repository (structure, conventions, tooling) before proposing.
3. Write `.factory/changes/<change_id>/design.md` with at least these sections:
   - `## Architecture` — proposed components/modules and their responsibilities.
   - `## Constraints` — relevant infrastructure, framework, library, and policy constraints you will respect.
   - `## Decisions & Trade-offs` — each important decision (D1, D2, …) with alternatives considered and why this one wins.
   - `## Affected Areas` — the existing parts of the repository this change touches, and how.
4. The design must map every acceptance criterion to a component or decision.

## Completion
When the artifact is complete, call `factory_phase_complete`. A human must approve it.
