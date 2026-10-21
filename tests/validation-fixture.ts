/**
 * Shared fixtures for artifact-contract validation tests.
 *
 * The documents below are static, template-conformant artifacts for a
 * fictional change ("chg-fixture") with one requirement (REQ-001 ← R1),
 * one functional requirement (FR-001), one acceptance criterion (AC-001)
 * and one design decision (DES-001). `runValidation` feeds a candidate
 * through the full 4-layer pipeline against a PhaseContext built from
 * these upstream documents — the same pipeline the engine uses.
 */
import { getContract } from "../src/artifacts/artifact-registry.ts";
import { sha256 } from "../src/artifacts/artifact-store.ts";
import { validateArtifact } from "../src/artifacts/artifact-validator.ts";
import type { PhaseContext, UpstreamArtifactRef } from "../src/artifacts/validation-context.ts";
import type { Phase } from "../src/workflow/phases.ts";
import type { ArtifactValidationResult } from "../src/artifacts/artifact-types.ts";
import type { CheckRecord, TaskRecord } from "../src/workflow/state.ts";

export const CHANGE_ID = "chg-fixture";

export const REQ_DOC = `# Requirement

## Metadata
- Artifact Type: requirement
- Contract Version: 1.0.0
- Change ID: ${CHANGE_ID}
- Revision: 1
- Status: complete

## Context
The change introduces the requested behavior into the repository.

## Goals
- Deliver the requested behavior.

## Non-Goals
None identified

## Requirements

### REQ-001: Do the thing

- Priority: MUST
- Source: R1
- Rationale: The user asked for it in the requirements history.
- Acceptance Intent: The tool performs the requested behavior.

The tool must do the thing.

## Constraints
None identified

## Assumptions
None identified

## Open Questions
None identified

## Stakeholders
Not applicable

## Change History
Not applicable
`;

export const SPEC_DOC = `# Specification

## Metadata
- Artifact Type: spec
- Contract Version: 1.0.0
- Change ID: ${CHANGE_ID}
- Revision: 1
- Status: complete

## Scope
External behavior of the change: the tool performs the requested operation.

## Referenced Requirements
- REQ-001

## Expected Behavior
The system performs the requested behavior when invoked.

## Functional Requirements

### FR-001: Perform the thing

- References: REQ-001

Executes the requested operation and reports the outcome.

## Inputs
- A user invocation of the tool.

## Outputs
- Exit code 0 on success, non-zero on failure.

## Error Behavior
Errors are reported on stderr with a non-zero exit code.

## Boundary Conditions
None identified

## Acceptance Criteria

### AC-001: The thing works

- References: REQ-001
- Verification: npm test runs the scenario and exits 0.

Running the tool performs the requested behavior.

## External Verification Contract
- The unit-tests check covers AC-001; the typecheck check covers the build.

## Non-Functional Requirements
Not applicable

## Unresolved Questions
None identified
`;

export const DESIGN_DOC = `# Design

## Metadata
- Artifact Type: design
- Contract Version: 1.0.0
- Change ID: ${CHANGE_ID}
- Revision: 1
- Status: complete

## Context
Design for the approved specification of this change.

## Referenced Artifacts
Requirement REQ-001 and acceptance criterion AC-001 of the approved spec.

## Repository Findings
The repository runs on node with node:sqlite persistence and node --test.

## Architecture
A single feature module performs the thing.

## Component Responsibilities
- The feature module owns the requested behavior.

## Data Model & Persistence
Not applicable — no new persistent state is introduced.

## Interfaces & Interactions
Not applicable — internal call only.

## Runtime & Infrastructure
Not applicable — runs inside the existing process.

## Library Choices
Not applicable — plain node, no new dependencies.

## Security & Trust Boundaries
Not applicable — no untrusted input is handled.

## Error Handling & Recovery
Not applicable — errors propagate to the caller.

## Testing Strategy
Unit tests cover AC-001; the typecheck check covers the build.

## Design Decisions

### DES-001: Implement as a single module

- Rationale: The simplest structure that satisfies AC-001.
- Consequences: Easy to test; harder to scale later.
- Alternatives: Multi-module split, rejected as overkill.

The single module keeps the change small and reviewable.

## Risks
None identified

## Open Questions
None identified
`;

export const TASK_PLAN_DOC = `# Task Plan

## Metadata
- Artifact Type: task-plan
- Contract Version: 1.0.0
- Change ID: ${CHANGE_ID}
- Revision: 1
- Status: complete

## Upstream References
- Requirement: 1
- Spec: 1
- Design: 1

## Strategy
Small, independently verifiable tasks that implement the design in order.

## Tasks

### TASK-001: Add feature

- Scope: src/feature.ts
- Expected Output: the task's stated result
- Verification: npm test
- Dependencies: none
- References: AC-001

### TASK-002: Wire it up

- Scope: src/index.ts
- Expected Output: the task's stated result
- Verification: manual smoke test
- Dependencies: TASK-001
- References: AC-001

## Dependencies
Each task depends only on the tasks listed in its record.

## Expected Outputs
- Working code implementing AC-001.

## Verification Criteria
- npm test passes.

## Risks & Blockers
None identified

## Deferred Work
None identified
`;

export const IMPL_DOC = `# Implementation Report

## Metadata
- Artifact Type: implementation-report
- Contract Version: 1.0.0
- Change ID: ${CHANGE_ID}
- Revision: 1
- Status: complete

## Approved Task Plan
- Revision: 1
- Hash: sha256:${sha256(TASK_PLAN_DOC)}

## Task Results

### TASK-001: Add feature

- Status: COMPLETED
- Evidence: Ran: npm test — ok

### TASK-002: Wire it up

- Status: COMPLETED
- Evidence: Ran: manual smoke test — ok

## Modified Files
- src/feature.ts — feature implementation
- src/index.ts — wiring

## Commands Executed
- npm test — full suite

## Test & Build Results
All tests pass; the build is clean.

## Deviations
None identified

## Known Limitations
None identified

## Unresolved Issues
None identified

## Evidence References
None identified
`;

export const VERIF_DOC = `# Verification Report

## Metadata
- Artifact Type: verification-report
- Contract Version: 1.0.0
- Change ID: ${CHANGE_ID}
- Revision: 1
- Status: complete

## Pinned Revisions
- Specification Revision: 1
- Specification Hash: sha256:${sha256(SPEC_DOC)}
- Implementation Revision: 1
- Implementation Hash: sha256:${sha256(IMPL_DOC)}

## Scope
Verifies the implemented change against the approved specification.

## Checks

### CHK-001: unit-tests

- Reference: AC-001
- Required: yes
- Method: unit-tests
- Expected: the check reports a passing result
- Actual: passing
- Status: PASS
- Evidence: 12 tests pass

### CHK-002: typecheck

- Reference: tooling
- Required: yes
- Method: typecheck
- Expected: the check reports a passing result
- Actual: passing
- Status: PASS
- Evidence: 0 errors

## Coverage
- AC-001: covered by the unit-tests check

## Residual Risks
None identified

## Overall Verdict
- Verdict: PASS
`;

export const DOCS: Record<Phase, string> = {
  requirement: REQ_DOC,
  spec: SPEC_DOC,
  design: DESIGN_DOC,
  task_planning: TASK_PLAN_DOC,
  implementation: IMPL_DOC,
  verification: VERIF_DOC,
};

export const TASKS: TaskRecord[] = [
  {
    change_id: CHANGE_ID,
    seq: 1,
    title: "Add feature",
    scope: "src/feature.ts",
    references: "AC-001",
    verification: "npm test",
    status: "DONE",
    evidence: "Ran: npm test — ok",
  },
  {
    change_id: CHANGE_ID,
    seq: 2,
    title: "Wire it up",
    scope: "src/index.ts",
    references: "AC-001",
    verification: "manual smoke test",
    status: "DONE",
    evidence: "Ran: manual smoke test — ok",
  },
];

export const CHECKS: CheckRecord[] = [
  { change_id: CHANGE_ID, name: "unit-tests", required: true, status: "PASSED", output: "12 tests pass", updated_at: "2026-01-01T00:00:00.000Z" },
  { change_id: CHANGE_ID, name: "typecheck", required: true, status: "PASSED", output: "0 errors", updated_at: "2026-01-01T00:00:01.000Z" },
];

const HISTORY = ["- [2026-01-01T00:00:00.000Z] (R1) do the thing"];

/** Upstream chain approved before `phase` (every earlier phase, revision 1). */
function upstreamRefs(phase: Phase, docs: Partial<Record<Phase, string | null>> = {}, hashes: Partial<Record<Phase, string>> = {}): UpstreamArtifactRef[] {
  const order: Phase[] = ["requirement", "spec", "design", "task_planning", "implementation", "verification"];
  const idx = order.indexOf(phase);
  const refs: UpstreamArtifactRef[] = [];
  for (let i = 0; i < idx; i++) {
    const p = order[i]!;
    const text = docs[p] !== undefined ? docs[p]! : DOCS[p];
    refs.push({
      phase: p,
      revision: 1,
      hash: hashes[p] ?? (text === null ? "0".repeat(64) : sha256(text)),
      text,
    });
  }
  return refs;
}

export interface FixtureOpts {
  /** Candidate revision the engine would record. */
  expectedRevision?: number;
  tasks?: TaskRecord[];
  checks?: CheckRecord[];
  history?: string[];
  /** Per-phase upstream document overrides (null = file missing on disk). */
  upstreamDocs?: Partial<Record<Phase, string | null>>;
  /** Per-phase recorded-hash overrides (to simulate tampered files). */
  upstreamHashes?: Partial<Record<Phase, string>>;
}

export function fixtureCtx(phase: Phase, opts: FixtureOpts = {}): PhaseContext {
  const history = opts.history ?? HISTORY;
  return {
    changeId: CHANGE_ID,
    expectedRevision: opts.expectedRevision ?? 1,
    requirementHistory: history,
    historyIds: [...history]
      .map((l) => {
        const m = /\(R(\d+)\)/.exec(l);
        return m ? Number(m[1]) : NaN;
      })
      .filter((n) => Number.isFinite(n)),
    tasks: opts.tasks ?? TASKS,
    checks: opts.checks ?? CHECKS,
    upstream: upstreamRefs(phase, opts.upstreamDocs, opts.upstreamHashes),
  };
}

/** Run the full 4-layer pipeline for `phase` against `candidate` markdown. */
export function runValidation(phase: Phase, candidate: string, opts: FixtureOpts = {}): ArtifactValidationResult {
  const ctx = fixtureCtx(phase, opts);
  return validateArtifact({
    contract: getContract(phase),
    rawText: candidate,
    ctx,
    artifactHash: sha256(candidate),
    upstreamRaw: new Map(ctx.upstream.map((r) => [r.phase, r.text])),
  });
}

export function codes(result: ArtifactValidationResult, severity: "ERROR" | "WARNING" = "ERROR"): string[] {
  return result.issues.filter((i) => i.severity === severity).map((i) => i.code);
}
