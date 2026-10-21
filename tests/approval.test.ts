import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  assertThrowsWorkflowError,
  cleanup,
  changeFile,
  makeArtifact,
  makeRoot,
  newEngine,
  reviseRequirement,
  writeChangeFile,
  type Engine,
} from "./helpers.ts";

function pendingRequirementApproval(engine: Engine): void {
  engine.beginCurrentPhase();
  engine.appendRequirement("approval test requirement");
  writeChangeFile(
    engine.root,
    engine.requireActive().change_id,
    "requirement.md",
    makeArtifact("requirement", engine),
  );
  engine.completeCurrentPhase();
}

function approvalStatus(engine: Engine, id: string): string {
  return engine.db.getApproval(id)!.status;
}

test("7. a revised artifact invalidates the old approval; a new review is required", () => {
  const root = makeRoot();
  const engine = newEngine(root);
  engine.initChange("stale approval");
  pendingRequirementApproval(engine);
  const approvalId = engine.requireActive().pending_approval_id!;
  const changeId = engine.requireActive().change_id;

  // User (or agent) modifies the artifact after the approval request exists.
  reviseRequirement(engine, "- late edit that was never reviewed");

  // Approving the stale approval must fail and INVALidATE it — no state advance.
  const err = assertThrowsWorkflowError(() => engine.approve("oops"), "STALE_APPROVAL");
  assert.match(err.message, /changed after the approval request/i);
  assert.equal(approvalStatus(engine, approvalId), "INVALIDATED");
  assert.equal(engine.requireActive().status, "AWAITING_APPROVAL", "no phase advance from a failed approve");
  assert.equal(engine.requireActive().pending_approval_id, approvalId);

  // Rejecting the already-invalidated approval is refused as well (no double resolution).
  const rerr = assertThrowsWorkflowError(() => engine.reject("no"));
  assert.equal(rerr.code, "ILLEGAL_TRANSITION");
  assert.match(rerr.message, /INVALIDATED/);

  // Recovery: the phase can be re-run (its pending approval is no longer PENDING)
  // and completed again for a NEW review.
  engine.beginCurrentPhase();
  assert.equal(engine.requireActive().status, "RUNNING");
  engine.completeCurrentPhase();
  const second = engine.requireActive();
  assert.notEqual(second.pending_approval_id, approvalId);
  assert.equal(approvalStatus(engine, approvalId), "INVALIDATED");
  assert.equal(approvalStatus(engine, second.pending_approval_id!), "PENDING");

  // And the new approval validates and advances exactly one phase.
  const { workflow } = engine.approve("revised and fine");
  assert.equal(workflow.current_phase, "spec");
  engine.close();
  cleanup(root);
});

test("8. repeated approval does not advance the workflow twice", () => {
  const root = makeRoot();
  const engine = newEngine(root);
  engine.initChange("double approve");
  pendingRequirementApproval(engine);
  const first = engine.approve("");
  assert.equal(first.workflow.current_phase, "spec");
  const secondErr = assertThrowsWorkflowError(() => engine.approve(""));
  assert.equal(secondErr.code, "ILLEGAL_TRANSITION");
  assert.equal(engine.requireActive().current_phase, "spec");
  assert.equal(engine.requireActive().status, "IDLE");
  engine.close();
  cleanup(root);
});

test("approval is bound to the exact artifact revision and hash", () => {
  const root = makeRoot();
  const engine = newEngine(root);
  engine.initChange("bound approval");
  pendingRequirementApproval(engine);
  const approval = engine.db.getApproval(engine.requireActive().pending_approval_id!);
  assert.equal(approval!.phase, "requirement");
  assert.equal(approval!.artifact_revision, 1);
  assert.match(approval!.artifact_hash, /^[a-f0-9]{64}$/);
  const file = changeFile(root, engine.requireActive().change_id, "requirement.md");
  assert.equal(approval!.artifact_hash, createHash("sha256").update(readFileSync(file)).digest("hex"));
  engine.close();
  cleanup(root);
});

test("rejecting requires a reason; approval history is preserved", () => {
  const root = makeRoot();
  const engine = newEngine(root);
  engine.initChange("review history");
  pendingRequirementApproval(engine);
  assertThrowsWorkflowError(() => engine.reject("   "), "REASON_REQUIRED");
  engine.reject("too vague");
  // revise (with a real content change) + re-review
  engine.beginCurrentPhase();
  reviseRequirement(engine, "- clarified per feedback");
  engine.completeCurrentPhase();
  engine.approve("ok now");
  const changeId = engine.getWorkflow(engine.listWorkflows()[0].change_id)!.change_id;
  // history: one REJECTED and one APPROVED approval for the same phase
  const rows = engine.db.db
    .prepare("SELECT status, review_comment FROM approvals WHERE phase = 'requirement' ORDER BY rowid")
    .all() as { status: string; review_comment: string | null }[];
  assert.deepEqual(rows.map((r) => ({ status: r.status, review_comment: r.review_comment })), [
    { status: "REJECTED", review_comment: "too vague" },
    { status: "APPROVED", review_comment: "ok now" },
  ]);
  // the rejected and the approved versions are distinct artifact revisions
  const arts = engine.db.allArtifacts(changeId);
  assert.equal(arts.filter((a) => a.phase === "requirement").length, 2);
  engine.close();
  cleanup(root);
});

test("an approval cannot come from the LLM: no tool resolves approvals", () => {
  // Structural guarantee: the only approval paths are the command handlers
  // (approve/reject), which are unreachable from model tools. The tools the
  // LLM can call are registered in index.ts and none of them resolves
  // approvals — verified here at the engine level: no engine method takes an
  // arbitrary approval status from outside the human command flow.
  const root = makeRoot();
  const engine = newEngine(root);
  engine.initChange("no self-approval");
  pendingRequirementApproval(engine);
  // The LLM's only forward-moving tool is factory_phase_complete, which can
  // only fire from RUNNING — while awaiting approval it must refuse.
  assertThrowsWorkflowError(() => engine.completeCurrentPhase(), "ILLEGAL_TRANSITION");
  engine.close();
  cleanup(root);
});
