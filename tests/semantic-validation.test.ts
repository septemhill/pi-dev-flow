import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHECKS,
  DESIGN_DOC,
  DOCS,
  IMPL_DOC,
  REQ_DOC,
  SPEC_DOC,
  TASK_PLAN_DOC,
  TASKS,
  VERIF_DOC,
  codes,
  fixtureCtx,
  runValidation,
} from "./validation-fixture.ts";

test("semantic: metadata is immutable by the model (type, version, change id, revision, status)", () => {
  const base = SPEC_DOC;
  const badType = runValidation("spec", base.replace("- Artifact Type: spec", "- Artifact Type: requirement"));
  assert.ok(codes(badType).includes("SEM_BAD_ARTIFACT_TYPE"));

  const badVersion = runValidation("spec", base.replace("- Contract Version: 1.0.0", "- Contract Version: 2.0.0"));
  assert.ok(codes(badVersion).includes("SEM_CONTRACT_VERSION_MISMATCH"));

  const badChange = runValidation("spec", base.replace("- Change ID: chg-fixture", "- Change ID: chg-other"));
  assert.ok(codes(badChange).includes("SEM_CHANGE_MISMATCH"));

  const badRevision = runValidation("spec", base.replace("- Revision: 1", "- Revision: 4"));
  assert.ok(codes(badRevision).includes("SEM_REVISION_MISMATCH"));

  const draft = runValidation("spec", base.replace("- Status: complete", "- Status: draft"));
  assert.ok(codes(draft).includes("SEM_STATUS_NOT_COMPLETE"));
});

test("semantic: requirement sources must cite real history entries", () => {
  // cites an entry that was never recorded
  const phantom = runValidation("requirement", REQ_DOC.replace("- Source: R1", "- Source: R2"));
  assert.ok(codes(phantom).includes("SEM_BAD_REF"));

  // a recorded entry that no requirement cites → warning
  const ctx = fixtureCtx("requirement", {
    history: ["- [2026-01-01T00:00:00.000Z] (R1) do the thing", "- [2026-01-01T00:00:01.000Z] (R2) more things"],
  });
  void ctx;
  const uncovered = runValidation("requirement", REQ_DOC, {
    history: ["- [2026-01-01T00:00:00.000Z] (R1) do the thing", "- [2026-01-01T00:00:01.000Z] (R2) more things"],
  });
  const warnings = uncovered.issues.filter((i) => i.severity === "WARNING").map((i) => i.code);
  assert.ok(warnings.includes("SEM_UNCOVERED_HISTORY"), warnings.join(","));
  assert.equal(uncovered.valid, true, "warnings must not block the artifact");
});

test("semantic: the design must address every acceptance criterion", () => {
  const blind = DESIGN_DOC
    .replace("Requirement REQ-001 and acceptance criterion AC-001 of the approved spec.", "The approved spec.")
    .replace("Unit tests cover AC-001; the typecheck check covers the build.", "Unit tests cover the spec; the typecheck check covers the build.")
    .replace("- Rationale: The simplest structure that satisfies AC-001.", "- Rationale: The simplest structure that satisfies the spec.");
  assert.ok(!blind.includes("AC-001"), "test setup: AC-001 must be fully removed");
  const result = runValidation("design", blind);
  assert.ok(codes(result).includes("SEM_UNCOVERED_AC"), codes(result).join(","));
});

test("semantic: the task plan must mirror the recorded plan exactly", () => {
  // one extra recorded task → count mismatch
  const three = [...TASKS, { ...TASKS[1]!, seq: 3, title: "Extra task", scope: "src/extra.ts" }];
  const result = runValidation("task_planning", TASK_PLAN_DOC, { tasks: three });
  assert.ok(codes(result).includes("SEM_PLAN_MISMATCH"), codes(result).join(","));

  // renamed title → silent plan change
  const renamed = TASK_PLAN_DOC.replace("### TASK-001: Add feature", "### TASK-001: Different title");
  const result2 = runValidation("task_planning", renamed);
  assert.ok(codes(result2).includes("SEM_PLAN_MISMATCH"), codes(result2).join(","));
});

test("semantic: task dependencies must be acyclic and backward-only", () => {
  const cycle = TASK_PLAN_DOC.replace("- Dependencies: TASK-001", "- Dependencies: TASK-002").replace(
    "- Dependencies: none",
    "- Dependencies: TASK-002",
  );
  const result = runValidation("task_planning", cycle);
  assert.ok(codes(result).includes("SEM_CYCLE"), codes(result).join(","));

  const forward = TASK_PLAN_DOC.replace("- Dependencies: none", "- Dependencies: TASK-002");
  const f = runValidation("task_planning", forward);
  const warnings = f.issues.filter((i) => i.severity === "WARNING").map((i) => i.code);
  assert.ok(warnings.includes("SEM_FWD_DEPENDENCY"), warnings.join(","));
});

test("semantic: tasks without upstream references are rejected", () => {
  const unref = TASK_PLAN_DOC.replace("- References: AC-001\n\n### TASK-002", "- References: \n\n### TASK-002").replace("- References: AC-001", "- References: nothing here");
  const result = runValidation("task_planning", unref);
  assert.ok(codes(result).includes("SEM_MISSING_REF") || codes(result).includes("STRUCT_EMPTY_RECORD_FIELD_VALUE"), codes(result).join(","));
});

test("semantic: the implementation report must mirror the recorded task plan and results", () => {
  // stale plan hash
  const staleHash = IMPL_DOC.replace(/Hash: sha256:[0-9a-f]{64}/, "Hash: sha256:" + "ab".repeat(32));
  const result = runValidation("implementation", staleHash);
  assert.ok(codes(result).includes("SEM_PLAN_HASH_MISMATCH"), codes(result).join(","));

  // a task reported COMPLETED while the persisted status is not DONE
  const notDone = [...TASKS].map((t, i) => (i === 0 ? { ...t, status: "IN_PROGRESS" as const } : t));
  const result2 = runValidation("implementation", IMPL_DOC, { tasks: notDone });
  assert.ok(
    codes(result2).some((c) => c === "SEM_EVIDENCE_MISMATCH" || c === "SEM_TASKS_INCOMPLETE"),
    codes(result2).join(","),
  );

  // a task recorded BLOCKED in the report
  const blocked = IMPL_DOC.replace("- Status: COMPLETED\n- Evidence: Ran: npm test — ok", "- Status: BLOCKED\n- Evidence: could not run npm test");
  const result3 = runValidation("implementation", blocked, { tasks: notDone });
  assert.ok(codes(result3).includes("SEM_TASK_NOT_COMPLETE"), codes(result3).join(","));

  // an unplanned task in the results
  const ghost = IMPL_DOC.replace(
    "## Task Results",
    "## Task Results\n\n### TASK-003: Ghost task\n\n- Status: COMPLETED\n- Evidence: nothing",
  );
  const result4 = runValidation("implementation", ghost);
  assert.ok(codes(result4).includes("SEM_BAD_REF"), codes(result4).join(","));
});

test("semantic: the verification report must mirror recorded checks and the recomputed verdict", () => {
  // reported status differs from the recorded one
  const lying = VERIF_DOC.replace("- Status: PASS\n- Evidence: 12 tests pass", "- Status: FAIL\n- Evidence: 12 tests pass");
  const r1 = runValidation("verification", lying);
  assert.ok(codes(r1).includes("SEM_CHECK_MISMATCH"), codes(r1).join(","));

  // a check in the report that was never recorded
  const extra = VERIF_DOC.replace(
    "## Coverage",
    "### CHK-003: invented\n\n- Reference: tooling\n- Required: no\n- Method: invented\n- Expected: pass\n- Actual: pass\n- Status: PASS\n- Evidence: nope\n\n## Coverage",
  );
  const r2 = runValidation("verification", extra);
  assert.ok(codes(r2).includes("SEM_CHECK_UNRECORDED"), codes(r2).join(","));

  // a recorded check missing from the report
  const missing = VERIF_DOC.split("### CHK-002")[0] + VERIF_DOC.split("## Coverage")[1]!.replace(/^## Coverage/, "").replace(/^\n+/, "");
  const r3 = runValidation("verification", missing, { checks: CHECKS });
  assert.ok(codes(r3).includes("SEM_CHECK_MISMATCH"), codes(r3).join(","));

  // verdict conflicts with the recorded checks
  const conflict = VERIF_DOC.replace("- Verdict: PASS", "- Verdict: FAIL");
  const r4 = runValidation("verification", conflict);
  assert.ok(codes(r4).includes("SEM_VERDICT_CONFLICT"), codes(r4).join(","));

  // a failed required check must be reflected in the verdict
  const failed = CHECKS.map((c) => (c.name === "unit-tests" ? { ...c, status: "FAILED" as const } : c));
  const docFail = VERIF_DOC.replace("- Status: PASS\n- Evidence: 12 tests pass", "- Status: FAIL\n- Evidence: 3 tests failed");
  const r5 = runValidation("verification", docFail, { checks: failed });
  assert.ok(codes(r5).includes("SEM_VERDICT_CONFLICT"), codes(r5).join(","));
});

test("semantic: pinned revision hashes are verified against the artifact registry", () => {
  const wrongPin = VERIF_DOC.replace(/- Specification Hash: sha256:[0-9a-f]{64}/, "- Specification Hash: sha256:" + "cd".repeat(32));
  const result = runValidation("verification", wrongPin);
  assert.ok(codes(result).includes("SEM_PIN_HASH_MISMATCH"), codes(result).join(","));
});
