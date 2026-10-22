import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { FactoryEngine } from "../src/engine.ts";
import {
  CHANGE_ID_RE,
  FACTORY_DIR,
  readFileOrNull,
  sha256,
} from "../src/artifacts/artifact-store.ts";
import type { Phase } from "../src/workflow/phases.ts";
import { PHASES, PHASE_ARTIFACT_FILE } from "../src/workflow/phases.ts";
import type { WorkflowErrorCode } from "../src/workflow/errors.ts";
import { reportStatusForCheck } from "../src/artifacts/validation-context.ts";

export type Engine = FactoryEngine;

export function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "factory-test-"));
  mkdirSync(path.join(root, "some", "dir"), { recursive: true });
  return root;
}

export function newEngine(root: string): FactoryEngine {
  return new FactoryEngine(root);
}

export function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ *
 * Template-conformant artifact generation.
 *
 * The factory validates every artifact against its versioned contract
 * (structure → schema → traceability → semantics), so tests must feed
 * the engine documents that follow the real templates. These builders
 * derive every pin, revision and mirror from the engine's PERSISTED
 * state — exactly what an honest LLM would do from its work order.
 * ------------------------------------------------------------------ */

/** Expected revision number for the next candidate of `phase`. */
function expectedRevision(engine: Engine, phase: Phase): number {
  const w = engine.requireActive();
  const latest = engine.db.latestArtifact(w.change_id, phase);
  if (!latest) return 1;
  const cur = readFileOrNull(changeFile(engine.root, w.change_id, PHASE_ARTIFACT_FILE[phase]));
  if (cur !== null && sha256(cur) === latest.hash) return latest.revision;
  return latest.revision + 1;
}

function metadataBlock(engine: Engine, phase: Phase, artifactType: string, rev: number): string {
  const w = engine.requireActive();
  // Per-contract versions: spec and design are at 1.1.0 (DES References +
  // Coverage Review), all others at 1.0.0.
  const version = phase === "spec" || phase === "design" ? "1.1.0" : "1.0.0";
  return [
    "## Metadata",
    `- Artifact Type: ${artifactType}`,
    `- Contract Version: ${version}`,
    `- Change ID: ${w.change_id}`,
    `- Revision: ${rev}`,
    "- Status: complete",
    "",
  ].join("\n");
}

function requireUpstream(engine: Engine, phase: Phase): { revision: number; hash: string } {
  const w = engine.requireActive();
  const row = engine.db.latestArtifact(w.change_id, phase);
  if (!row) throw new Error(`fixture: no recorded ${phase} artifact`);
  return row;
}

function requirementDoc(engine: Engine): string {
  const rev = expectedRevision(engine, "requirement");
  return [
    "# Requirement",
    "",
    metadataBlock(engine, "requirement", "requirement", rev),
    "## Context",
    "The change introduces the requested behavior into the repository.",
    "",
    "## Goals",
    "- Deliver the requested behavior.",
    "",
    "## Non-Goals",
    "None identified",
    "",
    "## Requirements",
    "",
    "### REQ-001: Do the thing",
    "",
    "- Priority: MUST",
    "- Source: R1",
    "- Rationale: The user asked for it in the requirements history.",
    "- Acceptance Intent: The tool performs the requested behavior.",
    "",
    "The tool must do the thing.",
    "",
    "## Constraints",
    "None identified",
    "",
    "## Assumptions",
    "None identified",
    "",
    "## Open Questions",
    "None identified",
    "",
    "## Stakeholders",
    "Not applicable",
    "",
    "## Change History",
    "Not applicable",
    "",
  ].join("\n");
}

function specDoc(engine: Engine): string {
  const rev = expectedRevision(engine, "spec");
  return [
    "# Specification",
    "",
    metadataBlock(engine, "spec", "spec", rev),
    "## Scope",
    "External behavior of the change: the tool performs the requested operation.",
    "",
    "## Referenced Requirements",
    "- REQ-001",
    "",
    "## Expected Behavior",
    "The system performs the requested behavior when invoked.",
    "",
    "## Functional Requirements",
    "",
    "### FR-001: Perform the thing",
    "",
    "- References: REQ-001",
    "",
    "Executes the requested operation and reports the outcome.",
    "",
    "## Inputs",
    "- A user invocation of the tool.",
    "",
    "## Outputs",
    "- Exit code 0 on success, non-zero on failure.",
    "",
    "## Error Behavior",
    "Errors are reported on stderr with a non-zero exit code.",
    "",
    "## Boundary Conditions",
    "None identified",
    "",
    "## Acceptance Criteria",
    "",
    "### AC-001: The thing works",
    "",
    "- References: REQ-001",
    "- Verification: npm test runs the scenario and exits 0.",
    "",
    "Running the tool performs the requested behavior.",
    "",
    "## Coverage Review",
    "None identified",
    "",
    "## External Verification Contract",
    "- The unit-tests check covers AC-001; the typecheck check covers the build.",
    "",
    "## Non-Functional Requirements",
    "Not applicable",
    "",
    "## Unresolved Questions",
    "None identified",
    "",
  ].join("\n");
}

function designDoc(engine: Engine): string {
  const rev = expectedRevision(engine, "design");
  return [
    "# Design",
    "",
    metadataBlock(engine, "design", "design", rev),
    "## Context",
    "Design for the approved specification of this change.",
    "",
    "## Referenced Artifacts",
    "Requirement REQ-001 and acceptance criterion AC-001 of the approved spec.",
    "",
    "## Repository Findings",
    "The repository runs on node with node:sqlite persistence and node --test.",
    "",
    "## Architecture",
    "A single feature module performs the thing.",
    "",
    "## Component Responsibilities",
    "- The feature module owns the requested behavior.",
    "",
    "## Data Model & Persistence",
    "Not applicable — no new persistent state is introduced.",
    "",
    "## Interfaces & Interactions",
    "Not applicable — internal call only.",
    "",
    "## Runtime & Infrastructure",
    "Not applicable — runs inside the existing process.",
    "",
    "## Library Choices",
    "Not applicable — plain node, no new dependencies.",
    "",
    "## Security & Trust Boundaries",
    "Not applicable — no untrusted input is handled.",
    "",
    "## Error Handling & Recovery",
    "Not applicable — errors propagate to the caller.",
    "",
    "## Testing Strategy",
    "Unit tests cover AC-001; the typecheck check covers the build.",
    "",
    "## Design Decisions",
    "",
    "### DES-001: Implement as a single module",
    "",
    "- References: FR-001, AC-001",
    "- Rationale: The simplest structure that satisfies AC-001.",
    "- Consequences: Easy to test; harder to scale later.",
    "- Alternatives: Multi-module split, rejected as overkill.",
    "",
    "The single module keeps the change small and reviewable.",
    "",
    "## Coverage Review",
    "None identified",
    "",
    "## Risks",
    "None identified",
    "",
    "## Open Questions",
    "None identified",
    "",
  ].join("\n");
}

function taskPlanDoc(engine: Engine): string {
  const rev = expectedRevision(engine, "task_planning");
  const req = requireUpstream(engine, "requirement");
  const spec = requireUpstream(engine, "spec");
  const design = requireUpstream(engine, "design");
  const tasks = engine.listTasks();
  if (tasks.length === 0) throw new Error("fixture: no recorded task plan");

  const records: string[] = [];
  for (const t of tasks) {
    const deps = t.seq === 1 ? "none" : `TASK-${String(t.seq - 1).padStart(3, "0")}`;
    records.push(
      [
        `### TASK-${String(t.seq).padStart(3, "0")}: ${t.title}`,
        "",
        `- Scope: ${t.scope}`,
        "- Expected Output: the task's stated result",
        `- Verification: ${t.verification}`,
        `- Dependencies: ${deps}`,
        `- References: ${t.references}`,
        "",
      ].join("\n"),
    );
  }

  return [
    "# Task Plan",
    "",
    metadataBlock(engine, "task_planning", "task-plan", rev),
    "## Upstream References",
    `- Requirement: ${req.revision}`,
    `- Spec: ${spec.revision}`,
    `- Design: ${design.revision}`,
    "",
    "## Strategy",
    "Small, independently verifiable tasks that implement the design in order.",
    "",
    "## Tasks",
    "",
    records.join("\n"),
    "",
    "## Dependencies",
    "Each task depends only on the tasks listed in its record.",
    "",
    "## Expected Outputs",
    "- Working code implementing AC-001.",
    "",
    "## Verification Criteria",
    "- npm test passes.",
    "",
    "## Risks & Blockers",
    "None identified",
    "",
    "## Deferred Work",
    "None identified",
    "",
  ].join("\n");
}

function implementationDoc(engine: Engine): string {
  const rev = expectedRevision(engine, "implementation");
  const plan = requireUpstream(engine, "task_planning");
  const tasks = engine.listTasks();

  const results: string[] = [];
  for (const t of tasks) {
    results.push(
      [
        `### TASK-${String(t.seq).padStart(3, "0")}: ${t.title}`,
        "",
        "- Status: COMPLETED",
        `- Evidence: Ran: ${t.verification} — ${t.evidence ?? "completed and verified"}`,
        "",
      ].join("\n"),
    );
  }

  return [
    "# Implementation Report",
    "",
    metadataBlock(engine, "implementation", "implementation-report", rev),
    "## Approved Task Plan",
    `- Revision: ${plan.revision}`,
    `- Hash: sha256:${plan.hash}`,
    "",
    "## Task Results",
    "",
    results.join("\n"),
    "## Modified Files",
    "- src/feature.ts — feature implementation",
    "- src/index.ts — wiring",
    "",
    "## Commands Executed",
    "- npm test — full suite",
    "",
    "## Test & Build Results",
    "All tests pass; the build is clean.",
    "",
    "## Deviations",
    "None identified",
    "",
    "## Known Limitations",
    "None identified",
    "",
    "## Unresolved Issues",
    "None identified",
    "",
    "## Evidence References",
    "None identified",
    "",
  ].join("\n");
}

function verificationDoc(engine: Engine): string {
  const rev = expectedRevision(engine, "verification");
  const spec = requireUpstream(engine, "spec");
  const impl = requireUpstream(engine, "implementation");
  const checks = engine.listChecks();
  if (checks.length === 0) throw new Error("fixture: no recorded verification checks");

  const records: string[] = [];
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i]!;
    const n = i + 1;
    const isTooling = /typecheck|build|lint/i.test(c.name);
    const status = reportStatusForCheck(c.status);
    const evidence = (c.output ?? "").slice(0, 120) || "recorded with factory_check_record";
    records.push(
      [
        `### CHK-${String(n).padStart(3, "0")}: ${c.name}`,
        "",
        `- Reference: ${isTooling ? "tooling" : "AC-001"}`,
        `- Required: ${c.required ? "yes" : "no"}`,
        `- Method: ${c.name}`,
        "- Expected: the check reports a passing result",
        `- Actual: ${status === "PASS" ? "passing" : "see recorded output"}: ${evidence}`,
        `- Status: ${status}`,
        `- Evidence: ${evidence}`,
        "",
      ].join("\n"),
    );
  }

  const verdict = checks.some((c) => c.required && (c.status === "FAILED" || c.status === "SKIPPED"))
    ? "FAIL"
    : "PASS";

  return [
    "# Verification Report",
    "",
    metadataBlock(engine, "verification", "verification-report", rev),
    "## Pinned Revisions",
    `- Specification Revision: ${spec.revision}`,
    `- Specification Hash: sha256:${spec.hash}`,
    `- Implementation Revision: ${impl.revision}`,
    `- Implementation Hash: sha256:${impl.hash}`,
    "",
    "## Scope",
    "Verifies the implemented change against the approved specification.",
    "",
    "## Checks",
    "",
    records.join("\n"),
    "## Coverage",
    "- AC-001: covered by the unit-tests check",
    "",
    "## Residual Risks",
    "None identified",
    "",
    "## Overall Verdict",
    `- Verdict: ${verdict}`,
    "",
  ].join("\n");
}

/** A valid understanding document for a change (JSON-first canonical artifact). */
export function makeUnderstandingDoc(changeId: string, description: string, extra: Record<string, unknown> = {}) {
  return {
    metadata: {
      artifactType: "understanding",
      contractVersion: "1.0.0",
      changeId,
      revision: 1,
      status: "complete",
      sourcePromptRef: "original prompt (verbatim in sourcePrompt)",
    },
    sourcePrompt: description,
    intent: {
      objective: `Understand what to change: ${description.slice(0, 40)}`,
      expectedOutcome: "An approved, unambiguous interpretation of the change description.",
      successIndicators: ["Requirements derive from documented candidates", "Ambiguities surfaced, not silently resolved"],
    },
    explicitInformation: [
      { id: "EXP-001", type: "goal", statement: `The change concerns: ${description}`, sourceRef: "original prompt (full text, verbatim in sourcePrompt)" },
    ],
    inferences: [
      {
        id: "INF-001",
        statement: "Existing phases and behavior remain unchanged except where the change requires it.",
        evidence: "The prompt does not ask for unrelated changes.",
        rationale: "Minimal-diff interpretation: restrict the change to what the prompt asks.",
        confidence: "medium",
        impactIfWrong: "Over- or under-scoped requirement set.",
        status: "open",
      },
    ],
    scope: {
      inScope: ["The functionality described in the original prompt"],
      outOfScope: [],
      undetermined: ["Whether documentation updates are expected (not stated in the prompt)"],
    },
    ambiguities: [
      {
        id: "Q-001",
        question: "Does the change include documentation updates?",
        interpretations: ["Yes — docs stay in sync", "No — code-only"],
        impact: "Affects the requirement set and verification checks.",
        status: "open",
      },
    ],
    candidateRequirements: [
      {
        id: "CR-001",
        statement: `Implement the change described in the original prompt: ${description}`,
        origin: "explicit",
        sourceRefs: ["EXP-001", "prompt"],
        relatedIds: ["INF-001"],
      },
    ],
    summary: {
      narrative: "The change is scoped to the described functionality; open questions are listed.",
      unresolvedIssues: ["Q-001"],
      clarificationsNeeded: ["Confirm whether documentation updates are in scope (Q-001)."],
    },
    traceability: {
      sourcePromptRef: "original prompt (verbatim in sourcePrompt)",
      relatedArtifactRefs: [],
      requirementRefs: [],
    },
    ...extra,
  };
}

/**
 * Build a template-conformant artifact candidate for the engine's active
 * change and `phase`, derived entirely from persisted engine state.
 * (understanding is JSON-first: it is submitted via engine.submitUnderstanding,
 * not written as a file — see completePhase.)
 */
export function makeArtifact(phase: Phase, engine: Engine): string {
  switch (phase) {
    case "understanding":
      throw new Error("understanding is JSON-first: use engine.submitUnderstanding(makeUnderstandingDoc(...))");
    case "requirement": return requirementDoc(engine);
    case "spec": return specDoc(engine);
    case "design": return designDoc(engine);
    case "task_planning": return taskPlanDoc(engine);
    case "implementation": return implementationDoc(engine);
    case "verification": return verificationDoc(engine);
  }
}

/**
 * Amend the current requirement artifact the way a rejected-then-revised
 * document would be amended: bump the declared revision and append a line
 * to the (free-form) trailing Change History section.
 */
export function reviseRequirement(engine: Engine, extra: string): void {
  const w = engine.requireActive();
  const file = changeFile(engine.root, w.change_id, "requirement.md");
  const text = readFileSync(file, "utf8");
  const latest = engine.db.latestArtifact(w.change_id, "requirement");
  const nextRev = latest ? latest.revision + 1 : 1;
  const updated = text.replace(/^- Revision: \d+/m, `- Revision: ${nextRev}`) + "\n" + extra + "\n";
  writeFileSync(file, updated, "utf8");
}

export function writeChangeFile(root: string, changeId: string, name: string, content: string): string {
  if (!CHANGE_ID_RE.test(changeId)) throw new Error(`invalid change id: ${changeId}`);
  const file = path.join(root, FACTORY_DIR, "changes", changeId, name);
  writeFileSync(file, content, "utf8");
  return file;
}

export function changeFile(root: string, changeId: string, name: string): string {
  return path.join(root, FACTORY_DIR, "changes", changeId, name);
}

export function rawArtifactText(root: string, changeId: string, phaseOrFile: Phase | string): string | null {
  const name = PHASE_ARTIFACT_FILE[phaseOrFile as Phase] ?? phaseOrFile;
  return readFileOrNull(changeFile(root, changeId, name));
}

export function artifactExists(root: string, changeId: string, phaseOrFile: Phase | string): boolean {
  return rawArtifactText(root, changeId, phaseOrFile) !== null;
}

/**
 * Complete the engine's current phase (begin → fixture work → artifact →
 * complete → approve). The artifact is template-conformant and derived
 * from the engine's persisted state.
 */
export function completePhase(root: string, engine: Engine, phase: Phase): void {
  if (engine.requireActive().current_phase !== phase) {
    throw new Error(`expected current phase ${phase}, got ${engine.requireActive().current_phase}`);
  }
  const w = engine.requireActive();
  if (w.status !== "RUNNING") engine.beginCurrentPhase();

  switch (phase) {
    case "understanding":
      engine.submitUnderstanding(makeUnderstandingDoc(w.change_id, w.description));
      break;
    case "requirement":
      engine.appendRequirement(`requirement for ${w.change_id}`);
      break;
    case "task_planning":
      engine.setTaskPlan(
        [
          { title: "Add feature", scope: "src/feature.ts", references: "FR-1, AC-1", verification: "npm test" },
          { title: "Wire it up", scope: "src/index.ts", references: "FR-1, AC-1", verification: "manual smoke test" },
        ],
        false,
      );
      break;
    case "implementation":
      for (const t of engine.listTasks()) {
        engine.updateTask(t.seq, "DONE", `Ran: ${t.verification} — ok`);
      }
      break;
    case "verification":
      engine.recordCheck("unit-tests", true, "PASSED", "12 tests pass");
      engine.recordCheck("typecheck", true, "PASSED", "0 errors");
      break;
    default:
      break;
  }

  if (phase !== "understanding") {
    writeChangeFile(root, w.change_id, PHASE_ARTIFACT_FILE[phase], makeArtifact(phase, engine));
  }
  engine.completeCurrentPhase();
  engine.approve("auto-approved in test");
}

/** Complete phases until the engine is on `target` (IDLE). */
export function advanceTo(root: string, engine: Engine, target: Phase): void {
  for (const p of PHASES) {
    if (p === target) break;
    if (p === engine.requireActive().current_phase) {
      completePhase(root, engine, p);
    }
  }
  if (engine.requireActive().current_phase !== target) {
    throw new Error(`advanceTo(${target}) failed, on ${engine.requireActive().current_phase}`);
  }
}

export function runFullWorkflow(root: string, engine: Engine): void {
  for (const p of PHASES) completePhase(root, engine, p);
}

export function assertThrowsWorkflowError(
  fn: () => unknown,
  code?: WorkflowErrorCode,
): { code: WorkflowErrorCode; message: string } {
  try {
    fn();
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e && typeof e === "object" && typeof e.code === "string" && (code === undefined || e.code === code)) {
      return { code: e.code as WorkflowErrorCode, message: e.message ?? String(err) };
    }
    throw new Error(`expected WorkflowError ${code ?? "(any)"}, got: ${String(err)}`);
  }
  throw new Error(`expected WorkflowError ${code ?? "(any)"}, but nothing was thrown`);
}
