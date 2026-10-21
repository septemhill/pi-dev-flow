/**
 * Traceability & coverage engine tests.
 *
 * Covers, per the task spec:
 *  - the relationship contract (allowed pairs, stages, field projection)
 *  - deterministic graph extraction (links, invalid relations, duplicates)
 *  - stage-specific coverage states (UNCOVERED/COVERED/VERIFIED/FAILED/WAIVED)
 *  - evidence requirements (VERIFIED needs a passing check, not a link)
 *  - waiver semantics (active vs stale, denominator, idempotency)
 *  - semantic (bounded model) review validation
 *  - phase-gate integration (uncovered mandatory items block completion)
 *  - the /factory traceability report
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { handleFactory } from "../src/commands/factory.ts";
import { getContract } from "../src/artifacts/artifact-registry.ts";
import { parseArtifact } from "../src/artifacts/markdown-parser.ts";
import { PHASES, type Phase } from "../src/workflow/phases.ts";
import type { WaiverRecord } from "../src/workflow/state.ts";
import {
  relationForPair,
  RELATION_CONTRACT,
  FIELD_ALLOWED_PREFIXES,
  stageForPair,
} from "../src/traceability/relations.ts";
import { extractTraceGraph, type GraphInput } from "../src/traceability/items.ts";
import { assessCoverage, WAIVER_KEY, STAGE_MISSING_CODE } from "../src/traceability/coverage.ts";
import { coverageIssues } from "../src/traceability/issues.ts";
import { semanticReviewIssues } from "../src/traceability/semantic-review.ts";
import type { ActiveWaiver, CoverageStage, CoverageReport, TraceGraph, StageSummary } from "../src/traceability/types.ts";
import {
  CHANGE_ID,
  DOCS,
  REQ_DOC,
  SPEC_DOC,
  DESIGN_DOC,
  TASK_PLAN_DOC,
  IMPL_DOC,
  VERIF_DOC,
  runValidation,
  codes,
} from "./validation-fixture.ts";
import {
  assertThrowsWorkflowError,
  cleanup,
  completePhase,
  makeRoot,
  newEngine,
  writeChangeFile,
  type Engine,
} from "./helpers.ts";

// ---------------------------------------------------------------- helpers

function graphFor(phases: Phase[], docs: Partial<Record<Phase, string>> = {}): { graph: TraceGraph; issues: ReturnType<typeof extractTraceGraph>["issues"] } {
  const inputs: GraphInput[] = phases.map((p) => ({
    phase: p,
    artifactType: getContract(p).artifactType,
    revision: 1,
    approved: true,
    parsed: parseArtifact(getContract(p), docs[p] ?? DOCS[p]),
  }));
  return extractTraceGraph(CHANGE_ID, inputs);
}

const allWaivers = (): Map<string, ActiveWaiver> => new Map();

function waiverMap(entries: Array<[string, CoverageStage, ActiveWaiver?]>): Map<string, ActiveWaiver> {
  const m = new Map<string, ActiveWaiver>();
  for (const [id, stage, aw] of entries) m.set(WAIVER_KEY(id, stage), aw ?? activeWaiver(id, stage));
  return m;
}

function activeWaiver(itemId: string, stage: CoverageStage, staleBecause: Phase[] = []): ActiveWaiver {
  return {
    waiver: {
      id: `wv-${itemId}-${stage}`,
      changeId: CHANGE_ID,
      itemId,
      stage,
      rationale: "test waiver",
      created_at: "2026-01-01T00:00:00.000Z",
      status: "ACTIVE",
      pinnedRevisions: {},
    },
    staleBecause,
  };
}

function waiverRec(itemId: string, stage: CoverageStage, status: WaiverRecord["status"] = "ACTIVE"): WaiverRecord {
  return {
    id: `wv-${itemId.toLowerCase()}-${stage}`,
    change_id: CHANGE_ID,
    item_id: itemId,
    stage,
    rationale: "explicitly deferred by user decision",
    status,
    pinned_revisions: "{}",
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

const forStage = (report: CoverageReport, stage: CoverageStage, id: string) =>
  report.assessments.find((a) => a.stage === stage && a.item.id === id)!;

const errorsFor = (contractPhase: Phase, report: CoverageReport) =>
  coverageIssues(getContract(contractPhase), report.assessments).filter((i) => i.severity === "ERROR");

/** Fixture docs use the fictional change id; adapt for a real engine change. */
const adapt = (doc: string, changeId: string): string => doc.replaceAll("chg-fixture", changeId);

const REQ2_BLOCK = `### REQ-002: Second behavior

- Priority: MUST
- Source: R1
- Rationale: The user asked for it too.
- Acceptance Intent: It also works.

Second requirement body.

## Constraints`;
const REQ2_DOC = REQ_DOC.replace("## Constraints", REQ2_BLOCK);

const FR2_BLOCK = `### FR-002: Second behavior

- References: REQ-002

Does the second thing.

## Inputs`;

/** Simulate a pre-contract recording: keep the row, drop the contract marker. */
function markLegacy(engine: Engine, phase: string): void {
  engine.db.db.prepare("UPDATE artifacts SET contract = NULL WHERE change_id = ? AND phase = ?").run(engine.requireActive().change_id, phase);
}

// ---------------------------------------------------------------- 1) relation contract

test("relations: legal (source, target) pairs map to the canonical relation", () => {
  assert.equal(relationForPair("functional_requirement", "REQ"), "SATISFIES");
  assert.equal(relationForPair("acceptance_criterion", "REQ"), "SATISFIES");
  assert.equal(relationForPair("acceptance_criterion", "FR"), "DERIVED_FROM");
  assert.equal(relationForPair("design_decision", "FR"), "REALIZES");
  assert.equal(relationForPair("design_decision", "AC"), "REALIZES");
  assert.equal(relationForPair("task", "REQ"), "IMPLEMENTS");
  assert.equal(relationForPair("task", "FR"), "IMPLEMENTS");
  assert.equal(relationForPair("task", "AC"), "IMPLEMENTS");
  assert.equal(relationForPair("task", "DES"), "IMPLEMENTS");
  assert.equal(relationForPair("task", "TASK"), "DEPENDS_ON");
  assert.equal(relationForPair("verification_check", "AC"), "VERIFIES");
  assert.equal(relationForPair("verification_check", "REQ"), "VERIFIES");
});

test("relations: illegal pairs are rejected (no invented relationships)", () => {
  assert.equal(relationForPair("requirement", "REQ"), null); // requirements never cite downstream
  assert.equal(relationForPair("functional_requirement", "AC"), null);
  assert.equal(relationForPair("functional_requirement", "DES"), null);
  assert.equal(relationForPair("functional_requirement", "TASK"), null);
  assert.equal(relationForPair("design_decision", "REQ"), null); // design realizes spec, not requirements
  assert.equal(relationForPair("design_decision", "TASK"), null);
  assert.equal(relationForPair("verification_check", "TASK"), null);
  assert.equal(relationForPair("verification_check", "DES"), null);
  assert.equal(relationForPair("task", "CHK"), null);
});

test("relations: which coverage stage each relation contributes to", () => {
  assert.equal(RELATION_CONTRACT.SATISFIES.coversStage, "requirement_to_spec");
  assert.equal(RELATION_CONTRACT.DERIVED_FROM.coversStage, null);
  assert.equal(RELATION_CONTRACT.REALIZES.coversStage, "spec_to_design");
  assert.equal(RELATION_CONTRACT.IMPLEMENTS.coversStage, "spec_to_tasks");
  assert.equal(RELATION_CONTRACT.VERIFIES.coversStage, "acceptance_to_verification");
  assert.equal(RELATION_CONTRACT.DEPENDS_ON.coversStage, null);
  // DEPENDS_ON is the only relation that may reference same-artifact (non-approved) items
  assert.equal(RELATION_CONTRACT.DEPENDS_ON.targetsMustBeApproved, false);
  assert.equal(RELATION_CONTRACT.REALIZES.targetsMustBeApproved, true);
  assert.equal(stageForPair("design_decision", "AC"), "spec_to_design");
  assert.equal(stageForPair("task", "TASK"), null);
});

test("relations: field-level projection — what each References field may cite", () => {
  assert.deepEqual(FIELD_ALLOWED_PREFIXES, {
    "spec:Functional Requirements:References": ["REQ"],
    "spec:Acceptance Criteria:References": ["REQ", "FR"],
    "design:Design Decisions:References": ["FR", "AC"],
    "task-plan:Tasks:References": ["REQ", "FR", "AC", "DES"],
    "task-plan:Tasks:Dependencies": ["TASK"],
    "verification-report:Checks:Reference": ["REQ", "FR", "AC"],
  });
});

// ---------------------------------------------------------------- 2) graph extraction

test("graph: the full fixture chain extracts every item and canonical link", () => {
  const { graph, issues } = graphFor(["requirement", "spec", "design", "task_planning", "implementation", "verification"]);
  assert.equal(issues.length, 0, JSON.stringify(issues, null, 2));
  const types = graph.items.map((i) => `${i.itemType}:${i.id}`).sort();
  assert.deepEqual(types, [
    "acceptance_criterion:AC-001",
    "design_decision:DES-001",
    "functional_requirement:FR-001",
    "implementation_result:TASK-001",
    "implementation_result:TASK-002",
    "requirement:REQ-001",
    "task:TASK-001",
    "task:TASK-002",
    "verification_check:CHK-001",
    "verification_check:CHK-002",
  ]);
  const pairs = graph.links.map((l) => `${l.source.id} ${l.relation} ${l.target.id}`).sort();
  assert.deepEqual(pairs, [
    "AC-001 SATISFIES REQ-001",
    "CHK-001 VERIFIES AC-001",
    "DES-001 REALIZES AC-001",
    "DES-001 REALIZES FR-001",
    "FR-001 SATISFIES REQ-001",
    "TASK-001 IMPLEMENTS AC-001",
    "TASK-001 IMPLEMENTS FR-001",
    "TASK-002 DEPENDS_ON TASK-001",
    "TASK-002 IMPLEMENTS AC-001",
  ]);
  // "none" dependencies and the "tooling" check reference produce no links
  assert.ok(!graph.links.some((l) => l.source.id === "TASK-001" && l.relation === "DEPENDS_ON"));
  assert.ok(!graph.links.some((l) => l.source.id === "CHK-002"));
});

test("graph: citing a prefix the field may not cite is TRACE_INVALID_RELATION", () => {
  // FR-001 cites an AC, but an FR may only cite REQ ids
  const spec = SPEC_DOC.replace("- References: REQ-001\n\nExecutes", "- References: AC-001\n\nExecutes");
  const { issues } = graphFor(["requirement", "spec"], { spec });
  assert.ok(
    issues.some((i) => i.code === "TRACE_INVALID_RELATION" && i.relatedId === "FR-001"),
    JSON.stringify(issues, null, 2),
  );
  const bad = issues.find((i) => i.code === "TRACE_INVALID_RELATION")!;
  assert.match(bad.message, /may only cite/);
  assert.match(bad.suggestedFix ?? "", /Cite only/);
});

test("graph: reusing an id for a different item is rejected (structural layer + graph backstop)", () => {
  const dup = SPEC_DOC.replace(
    "## Inputs",
    "### FR-001: Reused id\n\n- References: REQ-001\n\nA second item stealing the first id.\n\n## Inputs",
  );
  // within one section the structural layer names the collision
  const result = runValidation("spec", dup);
  assert.ok(codes(result).includes("STRUCT_DUPLICATE_RECORD_ID"), codes(result).join(","));

  // the graph layer independently backstops the same id for two different items
  const g = extractTraceGraph(
    CHANGE_ID,
    [
      { phase: "spec" as Phase, artifactType: "spec", revision: 1, approved: true, parsed: parseArtifact(getContract("spec"), SPEC_DOC) },
      { phase: "spec" as Phase, artifactType: "spec", revision: 2, approved: true, parsed: parseArtifact(getContract("spec"), SPEC_DOC.replace("### FR-001: Perform the thing", "### FR-001: A different item")) },
    ],
  );
  assert.ok(g.issues.some((i) => i.code === "TRACE_DUPLICATE_ITEM_ID" && i.relatedId === "FR-001"), JSON.stringify(g.issues, null, 2));
});

test("graph: multi-valued dependencies produce one DEPENDS_ON link per task", () => {
  const plan = TASK_PLAN_DOC.replace(
    "### TASK-002: Wire it up",
    "### TASK-003: Third\n\n- Scope: src/third.ts\n- Expected Output: the third result\n- Verification: npm test\n- Dependencies: TASK-001, TASK-002\n- References: AC-001\n\nThird body.\n\n### TASK-002: Wire it up",
  );
  const { graph, issues } = graphFor(["requirement", "spec", "design", "task_planning"], { task_planning: plan });
  assert.equal(issues.length, 0, JSON.stringify(issues, null, 2));
  const deps = graph.links.filter((l) => l.relation === "DEPENDS_ON" && l.source.id === "TASK-003");
  assert.deepEqual(deps.map((d) => d.target.id).sort(), ["TASK-001", "TASK-002"]);
});

// ---------------------------------------------------------------- 3) coverage engine

test("coverage S1: a requirement is covered by any FR or AC that references it", () => {
  const { graph } = graphFor(["requirement", "spec"]);
  const report = assessCoverage({ graph, waivers: allWaivers() });
  const a = forStage(report, "requirement_to_spec", "REQ-001");
  assert.equal(a.status, "COVERED");
  assert.equal(a.mandatory, true);
  assert.deepEqual(a.links.map((l) => l.source.id).sort(), ["AC-001", "FR-001"]);
  assert.equal(report.stages.requirement_to_spec.percent, 100);
  assert.equal(errorsFor("spec", report).length, 0);

  // coverage still holds when only the AC references the requirement
  const spec = SPEC_DOC.replace("- References: REQ-001\n\nExecutes", "- References: None identified\n\nExecutes");
  const onlyAc = graphFor(["requirement", "spec"], { spec });
  const r2 = assessCoverage({ graph: onlyAc.graph, waivers: allWaivers() });
  const a2 = forStage(r2, "requirement_to_spec", "REQ-001");
  assert.equal(a2.status, "COVERED");
  assert.deepEqual(a2.links.map((l) => l.source.id), ["AC-001"]);
});

test("coverage S1: an uncovered MUST requirement blocks; SHOULD only warns", () => {
  const withGap = (priority: string) => {
    const req = REQ_DOC.replace("## Constraints", REQ2_BLOCK.replace("- Priority: MUST", `- Priority: ${priority}`));
    const { graph } = graphFor(["requirement", "spec"], { requirement: req });
    return assessCoverage({ graph, waivers: allWaivers() });
  };
  const must = withGap("MUST");
  const mustA = forStage(must, "requirement_to_spec", "REQ-002");
  assert.equal(mustA.status, "UNCOVERED");
  assert.equal(mustA.mandatory, true);
  const mustErrors = errorsFor("spec", must);
  assert.ok(mustErrors.some((e) => e.code === STAGE_MISSING_CODE.requirement_to_spec && e.relatedId === "REQ-002"), JSON.stringify(mustErrors));

  const should = withGap("SHOULD");
  const shouldA = forStage(should, "requirement_to_spec", "REQ-002");
  assert.equal(shouldA.mandatory, false);
  const issues = coverageIssues(getContract("spec"), should.assessments);
  const gap = issues.find((i) => i.relatedId === "REQ-002")!;
  assert.equal(gap.severity, "WARNING");
  assert.equal(errorsFor("spec", should).length, 0);
});

test("coverage S2: every FR and AC must be realized by a design decision", () => {
  const { graph } = graphFor(["requirement", "spec", "design"]);
  const report = assessCoverage({ graph, waivers: allWaivers() });
  assert.equal(forStage(report, "spec_to_design", "FR-001").status, "COVERED");
  assert.equal(forStage(report, "spec_to_design", "AC-001").status, "COVERED");
  assert.deepEqual(forStage(report, "spec_to_design", "AC-001").links.map((l) => l.source.id), ["DES-001"]);

  // the design decision drops AC-001 → the gap is named and blocking
  const blind = DESIGN_DOC.replace("- References: FR-001, AC-001", "- References: FR-001");
  const blindGraph = graphFor(["requirement", "spec", "design"], { design: blind });
  const r2 = assessCoverage({ graph: blindGraph.graph, waivers: allWaivers() });
  const a = forStage(r2, "spec_to_design", "AC-001");
  assert.equal(a.status, "UNCOVERED");
  assert.ok(errorsFor("design", r2).some((e) => e.code === STAGE_MISSING_CODE.spec_to_design && e.relatedId === "AC-001"));
});

test("coverage S3: every FR and AC must be implemented by a task", () => {
  const { graph } = graphFor(["requirement", "spec", "design", "task_planning"]);
  const report = assessCoverage({ graph, waivers: allWaivers() });
  assert.equal(forStage(report, "spec_to_tasks", "FR-001").status, "COVERED");
  assert.equal(forStage(report, "spec_to_tasks", "AC-001").status, "COVERED");

  // no task references FR-001 anymore
  const plan = TASK_PLAN_DOC.replace("- References: FR-001, AC-001", "- References: AC-001");
  const planGraph = graphFor(["requirement", "spec", "design", "task_planning"], { task_planning: plan });
  const r2 = assessCoverage({ graph: planGraph.graph, waivers: allWaivers() });
  assert.equal(forStage(r2, "spec_to_tasks", "FR-001").status, "UNCOVERED");
  assert.ok(errorsFor("task_planning", r2).some((e) => e.code === STAGE_MISSING_CODE.spec_to_tasks && e.relatedId === "FR-001"));
});

test("coverage S4: a task is covered only by a COMPLETED result with evidence", () => {
  const { graph } = graphFor(["task_planning", "implementation"]);
  const report = assessCoverage({ graph, waivers: allWaivers() });
  assert.equal(forStage(report, "tasks_to_implementation", "TASK-001").status, "COVERED");
  assert.equal(forStage(report, "tasks_to_implementation", "TASK-002").status, "COVERED");

  const variant = (impl: string) => {
    const g = graphFor(["task_planning", "implementation"], { implementation: impl });
    return assessCoverage({ graph: g.graph, waivers: allWaivers() });
  };
  const noEvidence = variant(IMPL_DOC.replace("- Status: COMPLETED\n- Evidence: Ran: npm test — ok", "- Status: COMPLETED\n- Evidence: "));
  assert.equal(forStage(noEvidence, "tasks_to_implementation", "TASK-001").status, "UNCOVERED");
  assert.ok(errorsFor("implementation", noEvidence).some((e) => e.code === STAGE_MISSING_CODE.tasks_to_implementation && e.relatedId === "TASK-001"));

  const blocked = variant(IMPL_DOC.replace("- Status: COMPLETED", "- Status: BLOCKED"));
  assert.equal(forStage(blocked, "tasks_to_implementation", "TASK-001").status, "UNCOVERED");

  const noResult = variant(IMPL_DOC.replace("### TASK-002: Wire it up\n\n- Status: COMPLETED\n- Evidence: Ran: manual smoke test — ok\n\n", ""));
  assert.equal(forStage(noResult, "tasks_to_implementation", "TASK-002").status, "UNCOVERED");
  assert.match(forStage(noResult, "tasks_to_implementation", "TASK-002").reasons[0]!, /no task result record/);
});

test("coverage S5: PASS verifies, FAIL fails the item, SKIPPED never counts", () => {
  const { graph } = graphFor(["requirement", "spec", "design", "task_planning", "implementation", "verification"]);
  const report = assessCoverage({ graph, waivers: allWaivers() });
  assert.equal(forStage(report, "acceptance_to_verification", "AC-001").status, "VERIFIED");

  const variant = (verif: string) =>
    assessCoverage({
      graph: graphFor(["requirement", "spec", "design", "task_planning", "implementation", "verification"], { verification: verif }).graph,
      waivers: allWaivers(),
    });

  const failed = variant(VERIF_DOC.replace("- Status: PASS\n- Evidence: 12 tests pass", "- Status: FAIL\n- Evidence: 3 tests fail"));
  assert.equal(forStage(failed, "acceptance_to_verification", "AC-001").status, "FAILED");
  assert.ok(errorsFor("verification", failed).some((e) => e.code === "TRACE_REQUIRED_CHECK_FAILED" && e.relatedId === "AC-001"));

  const skipped = variant(VERIF_DOC.replace("- Status: PASS\n- Evidence: 12 tests pass", "- Status: SKIPPED\n- Evidence: not run"));
  const sk = forStage(skipped, "acceptance_to_verification", "AC-001");
  assert.equal(sk.status, "UNCOVERED");
  assert.match(sk.reasons[0]!, /skipped|SKIPPED/i);
  assert.ok(errorsFor("verification", skipped).some((e) => e.code === STAGE_MISSING_CODE.acceptance_to_verification && e.relatedId === "AC-001"));
});

test("coverage S5: an unresolved human check is explicitly pending, never promoted and non-blocking", () => {
  const verif = VERIF_DOC.replace("- Status: PASS\n- Evidence: 12 tests pass", "- Status: NEEDS_HUMAN\n- Evidence: requires human review");
  const g = graphFor(["requirement", "spec", "design", "task_planning", "implementation", "verification"], { verification: verif });
  const report = assessCoverage({ graph: g.graph, waivers: allWaivers() });
  const a = forStage(report, "acceptance_to_verification", "AC-001");
  assert.equal(a.status, "UNCOVERED");
  assert.equal(a.humanPending, true);
  const issues = coverageIssues(getContract("verification"), report.assessments);
  const gap = issues.find((i) => i.relatedId === "AC-001")!;
  assert.equal(gap.severity, "WARNING");
  assert.equal(errorsFor("verification", report).length, 0);
});

test("coverage: an active waiver turns an uncovered MUST item WAIVED without blocking", () => {
  const req = REQ_DOC.replace("## Constraints", REQ2_BLOCK);
  const { graph } = graphFor(["requirement", "spec"], { requirement: req });
  const waivers = waiverMap([["REQ-002", "requirement_to_spec"]]);
  const report = assessCoverage({ graph, waivers });
  const a = forStage(report, "requirement_to_spec", "REQ-002");
  assert.equal(a.status, "WAIVED");
  assert.equal(a.waiverId, waivers.get(WAIVER_KEY("REQ-002", "requirement_to_spec"))!.waiver.id);
  const issues = coverageIssues(getContract("spec"), report.assessments);
  assert.ok(issues.some((i) => i.code === "TRACE_WAIVER_ACTIVE" && i.severity === "INFO" && i.relatedId === "REQ-002"));
  assert.equal(errorsFor("spec", report).length, 0);
});

test("coverage: a stale waiver does not apply — the gap blocks again", () => {
  const req = REQ_DOC.replace("## Constraints", REQ2_BLOCK);
  const { graph } = graphFor(["requirement", "spec"], { requirement: req });
  const waivers = waiverMap([["REQ-002", "requirement_to_spec", activeWaiver("REQ-002", "requirement_to_spec", ["requirement"])]]);
  const report = assessCoverage({ graph, waivers });
  const a = forStage(report, "requirement_to_spec", "REQ-002");
  assert.equal(a.status, "UNCOVERED");
  assert.equal(a.waiverId, undefined);
  assert.ok(errorsFor("spec", report).some((e) => e.code === STAGE_MISSING_CODE.requirement_to_spec && e.relatedId === "REQ-002"));
});

test("coverage: waived items stay in the denominator; percent counts covered+waived", () => {
  const req = REQ_DOC.replace("## Constraints", REQ2_BLOCK);
  const { graph } = graphFor(["requirement", "spec"], { requirement: req });
  const plain = assessCoverage({ graph, waivers: allWaivers() });
  assert.equal(plain.stages.requirement_to_spec.percent, 50);
  assert.deepEqual(plain.stages.requirement_to_spec.uncoveredIds, ["REQ-002"]);

  const waived = assessCoverage({ graph, waivers: waiverMap([["REQ-002", "requirement_to_spec"]]) });
  const s = waived.stages.requirement_to_spec;
  assert.equal(s.total, 2);
  assert.equal(s.covered, 1);
  assert.equal(s.waived, 1);
  assert.equal(s.percent, 100);
  assert.deepEqual(s.waivedIds, ["REQ-002"]);
});

test("coverage: only stages with a denominator are assessed", () => {
  const { graph } = graphFor(["requirement", "spec"]);
  const report = assessCoverage({ graph, waivers: allWaivers() });
  const stages = report.stages as Record<string, StageSummary>;
  assert.ok(stages.requirement_to_spec, "S1 assessable");
  assert.equal(stages.spec_to_design, undefined, "no design artifact → no S2");
  assert.equal(stages.spec_to_tasks, undefined);
  assert.equal(stages.tasks_to_implementation, undefined);
  assert.equal(stages.acceptance_to_verification, undefined);
});

// ---------------------------------------------------------------- 4) bounded semantic review

const SR_RECORD = (status: string, missing: string, stage = "requirement_to_spec", upstream = "REQ-001", downstream = "FR-001") =>
  `### SR-001: ${downstream} satisfies ${upstream}

- Upstream: ${upstream}
- Downstream: ${downstream}
- Stage: ${stage}
- Status: ${status}
- Missing Obligations: ${missing}
- Rationale: The downstream item addresses the upstream obligation.

Review body.
`;
const withReview = (spec: string, record: string): string =>
  spec.replace("## Coverage Review\nNone identified", `## Coverage Review\n\n${record}`);

test("review: a valid COVERED attestation passes the pipeline", () => {
  const spec = withReview(SPEC_DOC, SR_RECORD("COVERED", "None identified"));
  const result = runValidation("spec", spec);
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
  assert.ok(!codes(result, "WARNING").some((c) => c.startsWith("TRACE_")), codes(result, "WARNING").join(","));
});

test("review: PARTIAL without named missing obligations is inconsistent", () => {
  const spec = withReview(SPEC_DOC, SR_RECORD("PARTIAL", "None identified"));
  const result = runValidation("spec", spec);
  assert.ok(codes(result).includes("TRACE_REVIEW_INCONSISTENT"), codes(result).join(","));
});

test("review: a PARTIAL attestation surfaces a non-blocking review warning", () => {
  const spec = withReview(SPEC_DOC, SR_RECORD("PARTIAL", "error-path behavior not fully addressed"));
  const result = runValidation("spec", spec);
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
  assert.ok(codes(result, "WARNING").includes("TRACE_SEMANTIC_REVIEW"), codes(result, "WARNING").join(","));
});

test("review: the attested stage must match the relation's coverage stage", () => {
  const spec = withReview(SPEC_DOC, SR_RECORD("COVERED", "None identified", "spec_to_design"));
  const result = runValidation("spec", spec);
  assert.ok(codes(result).includes("TRACE_REVIEW_STAGE_MISMATCH"), codes(result).join(","));
});

test("review: an attestation of a link the artifact does not declare is rejected", () => {
  // AC-001 → FR-001 is a legal pair but the fixture AC does not reference FR-001
  const spec = withReview(SPEC_DOC, SR_RECORD("COVERED", "None identified", "requirement_to_spec", "FR-001", "AC-001"));
  const result = runValidation("spec", spec);
  assert.ok(codes(result).includes("TRACE_INVALID_RELATION"), codes(result).join(","));
});

test("review: deterministic coverage always beats a claimed COVERED", () => {
  const { graph } = graphFor(["requirement", "spec"]);
  const parsed = parseArtifact(getContract("spec"), withReview(SPEC_DOC, SR_RECORD("COVERED", "None identified")));
  const assessments = [
    {
      stage: "requirement_to_spec" as const,
      item: { itemType: "requirement" as const, id: "REQ-001" },
      mandatory: true,
      status: "UNCOVERED" as const,
      links: [],
      reasons: ["no functional requirement or acceptance criterion references this requirement"],
    },
  ];
  const issues = semanticReviewIssues(getContract("spec"), parsed, graph, assessments);
  assert.ok(issues.some((i) => i.code === "TRACE_SEMANTIC_CONFLICT" && i.severity === "ERROR"), JSON.stringify(issues, null, 2));
});

// ---------------------------------------------------------------- 5) pipeline & phase gates

test("pipeline: a recorded waiver unblocks the gate for an uncovered MUST requirement", () => {
  const blocked = runValidation("spec", SPEC_DOC, { upstreamDocs: { requirement: REQ2_DOC } });
  assert.ok(codes(blocked).includes(STAGE_MISSING_CODE.requirement_to_spec), codes(blocked).join(","));

  const waived = runValidation("spec", SPEC_DOC, {
    upstreamDocs: { requirement: REQ2_DOC },
    waivers: [waiverRec("REQ-002", "requirement_to_spec")],
  });
  assert.equal(waived.valid, true, JSON.stringify(waived.issues, null, 2));
  assert.ok(waived.issues.some((i) => i.code === "TRACE_WAIVER_ACTIVE" && i.relatedId === "REQ-002"));

  const revoked = runValidation("spec", SPEC_DOC, {
    upstreamDocs: { requirement: REQ2_DOC },
    waivers: [waiverRec("REQ-002", "requirement_to_spec", "REVOKED")],
  });
  assert.ok(codes(revoked).includes(STAGE_MISSING_CODE.requirement_to_spec), codes(revoked).join(","));
});

test("gate: a spec that leaves a MUST requirement uncovered cannot complete", () => {
  const root = makeRoot();
  const engine = newEngine(root);
  const w = engine.initChange("coverage gate spec");
  // requirement phase: two requirements
  engine.beginCurrentPhase();
  engine.appendRequirement("do the thing");
  writeChangeFile(root, w.change_id, "requirement.md", adapt(REQ2_DOC, w.change_id));
  engine.completeCurrentPhase();
  engine.approve("ok");
  // spec phase: covers only REQ-001
  engine.beginCurrentPhase();
  writeChangeFile(root, w.change_id, "spec.md", adapt(SPEC_DOC, w.change_id));
  const err = assertThrowsWorkflowError(() => engine.completeCurrentPhase(), "INVALID_ARTIFACT");
  assert.match(err.message, /TRACE_MISSING_SPEC_COVERAGE/);
  assert.match(err.message, /REQ-002/);
  assert.equal(engine.requireActive().current_phase, "spec");

  // fixing the gap (an FR for REQ-002) unblocks
  writeChangeFile(root, w.change_id, "spec.md", adapt(SPEC_DOC.replace("## Inputs", FR2_BLOCK), w.change_id));
  engine.completeCurrentPhase();
  assert.equal(engine.requireActive().status, "AWAITING_APPROVAL");
  engine.close();
  cleanup(root);
});

test("gate: a design that does not realize an AC cannot complete", () => {
  const root = makeRoot();
  const engine = newEngine(root);
  engine.initChange("coverage gate design");
  completePhase(root, engine, "requirement");
  completePhase(root, engine, "spec");
  engine.beginCurrentPhase();
  const w = engine.requireActive();
  const blind = adapt(DESIGN_DOC, w.change_id).replace("- References: FR-001, AC-001", "- References: FR-001");
  writeChangeFile(root, w.change_id, "design.md", blind);
  const err = assertThrowsWorkflowError(() => engine.completeCurrentPhase(), "INVALID_ARTIFACT");
  assert.match(err.message, /TRACE_MISSING_DESIGN_COVERAGE/);
  assert.match(err.message, /AC-001/);
  assert.equal(engine.requireActive().current_phase, "design");
  writeChangeFile(root, w.change_id, "design.md", adapt(DESIGN_DOC, w.change_id));
  engine.completeCurrentPhase();
  assert.equal(engine.requireActive().status, "AWAITING_APPROVAL");
  engine.close();
  cleanup(root);
});

test("gate: a task plan that leaves an FR unimplemented cannot complete", () => {
  const root = makeRoot();
  const engine = newEngine(root);
  engine.initChange("coverage gate tasks");
  completePhase(root, engine, "requirement");
  completePhase(root, engine, "spec");
  completePhase(root, engine, "design");
  engine.beginCurrentPhase();
  const w = engine.requireActive();
  const gap = adapt(TASK_PLAN_DOC, w.change_id).replace("- References: FR-001, AC-001", "- References: AC-001");
  writeChangeFile(root, w.change_id, "task-plan.md", gap);
  const err = assertThrowsWorkflowError(() => engine.completeCurrentPhase(), "INVALID_ARTIFACT");
  assert.match(err.message, /TRACE_MISSING_TASK_COVERAGE/);
  assert.match(err.message, /FR-001/);
  assert.equal(engine.requireActive().current_phase, "task_planning");
  engine.close();
  cleanup(root);
});

test("waiver: waiveItem validates item, status and rationale; is idempotent; revocable", () => {
  const root = makeRoot();
  const engine = newEngine(root);
  const w = engine.initChange("waiver engine");
  engine.beginCurrentPhase();
  engine.appendRequirement("do the thing");
  writeChangeFile(root, w.change_id, "requirement.md", adapt(REQ2_DOC, w.change_id));
  engine.completeCurrentPhase();
  engine.approve("ok");
  engine.beginCurrentPhase();
  writeChangeFile(root, w.change_id, "spec.md", adapt(SPEC_DOC, w.change_id));

  // phantom items cannot be waived
  assert.throws(() => engine.waiveItem("REQ-099", "requirement_to_spec", "a long enough rationale"), /not assessable/);
  // a terse rationale is not an audit
  assert.throws(() => engine.waiveItem("REQ-002", "requirement_to_spec", "later"), /too short/);

  const first = engine.waiveItem("REQ-002", "requirement_to_spec", "Deferred to a follow-up change by explicit user decision.");
  assert.equal(first.created, true);
  const second = engine.waiveItem("REQ-002", "requirement_to_spec", "Another rationale for the same item.");
  assert.equal(second.created, false);
  assert.equal(second.waiver.id, first.waiver.id);

  // revoke → the gate blocks again
  engine.revokeWaiver(first.waiver.id);
  const err = assertThrowsWorkflowError(() => engine.completeCurrentPhase(), "INVALID_ARTIFACT");
  assert.match(err.message, /TRACE_MISSING_SPEC_COVERAGE/);
  // re-grant → completes and is approved (the spec now records REQ-001 as covered)
  engine.waiveItem("REQ-002", "requirement_to_spec", "Deferred to a follow-up change by explicit user decision.");
  engine.completeCurrentPhase();
  assert.equal(engine.requireActive().status, "AWAITING_APPROVAL");
  engine.approve("ok");
  // already-covered items are not exceptions (the recorded spec covers REQ-001)
  assert.throws(() => engine.waiveItem("REQ-001", "requirement_to_spec", "a long enough rationale"), /already COVERED/);
  engine.close();
  cleanup(root);
});

test("waiver: advancing upstream STALEs the waiver and re-blocks the gate", () => {
  const root = makeRoot();
  const engine = newEngine(root);
  const w = engine.initChange("waiver stale");
  engine.beginCurrentPhase();
  engine.appendRequirement("do the thing");
  writeChangeFile(root, w.change_id, "requirement.md", adapt(REQ2_DOC, w.change_id));
  engine.completeCurrentPhase();
  engine.approve("ok");
  engine.beginCurrentPhase();
  writeChangeFile(root, w.change_id, "spec.md", adapt(SPEC_DOC, w.change_id));

  const { waiver } = engine.waiveItem("REQ-002", "requirement_to_spec", "Deferred to a follow-up change by explicit user decision.");
  assert.match(waiver.pinned_revisions, /"requirement":\s*1/);

  // simulate the requirement phase advancing to revision 2 after the grant
  engine.db.db.prepare("UPDATE artifacts SET revision = 2 WHERE change_id = ? AND phase = 'requirement'").run(w.change_id);

  const err = assertThrowsWorkflowError(() => engine.completeCurrentPhase(), "INVALID_ARTIFACT");
  assert.match(err.message, /TRACE_MISSING_SPEC_COVERAGE/);
  const report = engine.traceabilityReport();
  assert.match(report, /STALE/);
  assert.match(report, /requirement/);
  engine.close();
  cleanup(root);
});

test("report: /factory traceability shows stages, statuses, waivers and legacy markers", () => {
  const root = makeRoot();
  const engine = newEngine(root);
  const w = engine.initChange("trace report");
  for (const p of ["requirement", "spec", "design", "task_planning", "implementation"] as Phase[]) {
    completePhase(root, engine, p);
  }
  const text = engine.traceabilityReport();
  assert.match(text, /Traceability report — change /);
  assert.match(text, /requirement\s+rev 1/);
  assert.match(text, /Stage requirement → spec: 100%/);
  assert.match(text, /✓ REQ-001  COVERED/);
  assert.match(text, /Stage spec → design: 100%/);
  assert.match(text, /Stage task planning → implementation: 100%/);
  assert.match(text, /✓ TASK-001  COVERED/);
  assert.ok(!text.includes("UNCOVERED"), text);

  // a legacy upstream is flagged and its ids are not trusted
  markLegacy(engine, "requirement");
  const legacy = engine.traceabilityReport();
  assert.match(legacy, /LEGACY \(pre-contract — not trusted\)/);
  assert.match(legacy, /Legacy upstream: requirement/);
  engine.close();
  cleanup(root);
});

test("commands: /factory waive and /factory revoke-waiver record auditable exceptions", async () => {
  const root = makeRoot();
  const engine = newEngine(root);
  const w = engine.initChange("waiver commands");
  engine.beginCurrentPhase();
  engine.appendRequirement("do the thing");
  writeChangeFile(root, w.change_id, "requirement.md", adapt(REQ2_DOC, w.change_id));
  engine.completeCurrentPhase();
  engine.approve("ok");
  engine.beginCurrentPhase();

  const notifications: string[] = [];
  const ctx = {
    cwd: engine.root,
    mode: "tui" as const,
    ui: { notify: (m: string) => notifications.push(m), setWidget: () => {} },
    isIdle: () => true,
    waitForIdle: async () => {},
  };
  const deps = { engineFor: () => engine, sendPhasePrompt: () => {} };

  await handleFactory("waive REQ-002 requirement_to_spec deferred to a follow-up change by explicit user decision", ctx, deps);
  let text = notifications.join("\n");
  assert.match(text, /Waiver wv-.* granted: REQ-002 @ requirement_to_spec/);

  const waivers = engine.db.listWaivers(w.change_id);
  assert.equal(waivers.length, 1);
  assert.equal(waivers[0]!.item_id, "REQ-002");

  await handleFactory(`revoke-waiver ${waivers[0]!.id}`, ctx, deps);
  text = notifications.join("\n");
  assert.match(text, /revoked \(REQ-002 @ requirement_to_spec\)/);
  assert.equal(engine.db.getWaiver(waivers[0]!.id)!.status, "REVOKED");
  engine.close();
  cleanup(root);
});
