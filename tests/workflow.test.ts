import { test } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import {
  assertThrowsWorkflowError,
  cleanup,
  makeArtifact,
  makeRoot,
  newEngine,
  runFullWorkflow,
  writeChangeFile,
  rawArtifactText,
  completePhase,
  advanceTo,
  type Engine,
} from "./helpers.ts";
import { handleFactory } from "../src/commands/factory.ts";

function makeCtx(root: string, sent: string[]) {
  const notifications: { msg: string; type?: string }[] = [];
  const ctx = {
    cwd: root,
    mode: "tui",
    ui: {
      notify: (msg: string, type?: string) => notifications.push({ msg, type }),
      setWidget: () => {},
    },
    isIdle: () => true,
    waitForIdle: async () => {},
  };
  return { ctx, notifications, deps: { engineFor: () => engines.get(root)!, sendPhasePrompt: (p: string) => sent.push(p) } };
}
const engines = new Map<string, Engine>();
function eng(root: string): Engine {
  let e = engines.get(root);
  if (!e) {
    e = newEngine(root);
    engines.set(root, e);
  }
  return e;
}

/** Complete understanding, then start + complete the requirement phase, leaving a PENDING approval. */
function pendingRequirementApproval(root: string): void {
  const engine = eng(root);
  advanceTo(root, engine, "requirement");
  engine.beginCurrentPhase();
  engine.appendRequirement("test requirement");
  writeChangeFile(root, engine.requireActive().change_id, "requirement.md", makeArtifact("requirement", engine));
  engine.completeCurrentPhase();
}

test("1. a new change starts at understanding, status IDLE", () => {
  const root = makeRoot();
  const engine = eng(root);
  const w = engine.initChange("add a cool feature");
  assert.equal(w.current_phase, "understanding");
  assert.equal(w.status, "IDLE");
  assert.match(w.change_id, /^chg-/);
  // repeated init must NOT silently replace the active change
  assertThrowsWorkflowError(() => engine.initChange("another"), "ACTIVE_CHANGE_EXISTS");
  assert.equal(engine.getActiveWorkflow()!.change_id, w.change_id);
  cleanup(root);
});

test("2. the seven phases follow the required order", () => {
  const root = makeRoot();
  const engine = eng(root);
  engine.initChange("order test");
  const seen: string[] = [];
  for (const expected of ["understanding", "requirement", "spec", "design", "task_planning", "implementation", "verification"] as const) {
    assert.equal(engine.requireActive().current_phase, expected, `expected to be on ${expected}`);
    seen.push(expected);
    completePhase(root, engine, expected);
  }
  assert.deepEqual(seen, ["understanding", "requirement", "spec", "design", "task_planning", "implementation", "verification"]);
  assert.equal(engine.getActiveWorkflow(), null, "no active workflow after completion");
  assert.equal(engine.getWorkflow(engine.listWorkflows()[0].change_id)!.status, "COMPLETED");
  cleanup(root);
});

test("3. a phase cannot advance without approval", () => {
  const root = makeRoot();
  const engine = eng(root);
  engine.initChange("no auto advance");
  pendingRequirementApproval(root);
  assert.equal(engine.requireActive().status, "AWAITING_APPROVAL");
  const err = assertThrowsWorkflowError(() => engine.beginCurrentPhase(), "PENDING_APPROVAL");
  assert.match(err.message, /approv/i);
  assert.equal(engine.requireActive().current_phase, "requirement");
  cleanup(root);
});

test("4. /factory run cannot bypass a pending approval (command layer)", async () => {
  const root = makeRoot();
  eng(root).initChange("gate test");
  pendingRequirementApproval(root);
  const sent: string[] = [];
  const { ctx, notifications, deps } = makeCtx(root, sent);
  await handleFactory("run", ctx, deps);
  assert.equal(sent.length, 0, "no phase prompt may be sent while an approval is pending");
  assert.ok(notifications.some((n) => /PENDING_APPROVAL|awaiting approval/i.test(n.msg)));
  cleanup(root);
});

test("5. approval advances exactly one phase; repeated approval is a no-op", () => {
  const root = makeRoot();
  const engine = eng(root);
  engine.initChange("one step at a time");
  pendingRequirementApproval(root);
  const before = engine.requireActive();
  const { workflow } = engine.approve("looks good");
  assert.equal(workflow.current_phase, "spec");
  assert.equal(workflow.status, "IDLE");
  assert.equal(workflow.revision, before.revision + 1);
  // a second approval attempt is refused and changes nothing
  const err = assertThrowsWorkflowError(() => engine.approve("again"));
  assert.equal(err.code, "ILLEGAL_TRANSITION");
  const after = engine.requireActive();
  assert.equal(after.current_phase, "spec");
  assert.equal(after.status, "IDLE");
  assert.equal(after.revision, before.revision + 1, "revision must not move twice");
  cleanup(root);
});

test("6. rejection preserves feedback and keeps the same phase", () => {
  const root = makeRoot();
  const engine = eng(root);
  engine.initChange("reject me");
  pendingRequirementApproval(root);
  const { workflow } = engine.reject("missing the security requirement");
  assert.equal(workflow.current_phase, "requirement", "rejection must not change phase");
  assert.equal(workflow.status, "REJECTED");
  const rej = engine.lastRejection("requirement");
  assert.ok(rej);
  assert.equal(rej!.review_comment, "missing the security requirement");
  assert.equal(rej!.status, "REJECTED");
  // a rejected phase advances only via an explicit revision run
  engine.beginCurrentPhase();
  assert.equal(engine.requireActive().status, "RUNNING");
  assert.equal(engine.requireActive().current_phase, "requirement");
  cleanup(root);
});

test("9. an invalid transition leaves persisted state unchanged", () => {
  const root = makeRoot();
  const engine = eng(root);
  engine.initChange("no side effects");
  const before = engine.requireActive();
  // approving with no pending approval is illegal and must change nothing
  assertThrowsWorkflowError(() => engine.approve("x"), "ILLEGAL_TRANSITION");
  const after = engine.requireActive();
  assert.deepEqual(after, before, "state must be identical after a refused transition");
  cleanup(root);
});

test("10. workflow state survives reloading from persistence", () => {
  const root = makeRoot();
  const e1 = newEngine(root);
  e1.initChange("survive reload");
  completePhase(root, e1, "understanding");
  completePhase(root, e1, "requirement");
  const changeId = e1.requireActive().change_id;
  e1.close();

  const e2 = newEngine(root); // fresh process-like load
  const w = e2.requireActive();
  assert.equal(w.current_phase, "spec");
  assert.equal(w.status, "IDLE");
  for (const phase of ["spec", "design", "task_planning", "implementation", "verification"] as const) {
    completePhase(root, e2, phase);
  }
  assert.equal(e2.getActiveWorkflow(), null);
  assert.equal(e2.getWorkflow(changeId)!.status, "COMPLETED");
  e2.close();
  cleanup(root);
});

test("13. failed required verification checks prevent a successful verification result", () => {
  const root = makeRoot();
  const engine = eng(root);
  engine.initChange("fail loud");
  advanceTo(root, engine, "verification");
  engine.beginCurrentPhase();
  engine.recordCheck("unit-tests", true, "FAILED", "3 tests failed: expected 200 got 500");
  engine.recordCheck("typecheck", true, "PASSED", "clean");
  writeChangeFile(root, engine.requireActive().change_id, "verification-report.md", makeArtifact("verification", engine));
  // the coverage gate (acceptance → verification) blocks the artifact: a FAILED
  // required check can never count as successful verification (fail-closed)
  const err = assertThrowsWorkflowError(() => engine.completeCurrentPhase(), "INVALID_ARTIFACT");
  assert.match(err.message, /TRACE_REQUIRED_CHECK_FAILED/);
  assert.match(err.message, /AC-001/);
  const w = engine.requireActive();
  assert.equal(w.current_phase, "verification");
  assert.equal(w.status, "RUNNING");
  // a required SKIPPED check also blocks (artifact re-written to mirror it)
  engine.recordCheck("typecheck", true, "SKIPPED", "forgot to run it");
  writeChangeFile(root, engine.requireActive().change_id, "verification-report.md", makeArtifact("verification", engine));
  assertThrowsWorkflowError(() => engine.completeCurrentPhase(), "INVALID_ARTIFACT");
  cleanup(root);
});

test("14. existing user changes are not overwritten during initialization", () => {
  const root = makeRoot();
  // pre-existing unrelated file in the repo
  const marker = `${root}/user-file.txt`;
  writeFileSync(marker, "mine");
  const engine = eng(root);
  engine.initChange("new change");
  assert.equal(readFileSync(marker, "utf8"), "mine", "unrelated files must not be overwritten");

  // a separate root with prior user content: re-opening never resets it
  const priorRoot = makeRoot();
  const e0 = newEngine(priorRoot);
  const w0 = e0.initChange("old change");
  writeChangeFile(priorRoot, w0.change_id, "spec.md", "USER CONTENT — must survive");
  e0.close();
  const e1 = newEngine(priorRoot);
  assert.ok(e1.getWorkflow(w0.change_id), "pre-existing workflow must still exist");
  assert.equal(rawArtifactText(priorRoot, w0.change_id, "spec.md"), "USER CONTENT — must survive");
  e1.close();
  cleanup(root);
  cleanup(priorRoot);
});

test("end-to-end: full workflow reaches COMPLETED with exactly one APPROVED approval per phase", () => {
  const root = makeRoot();
  const engine = eng(root);
  engine.initChange("e2e");
  runFullWorkflow(root, engine);
  assert.equal(engine.getWorkflow(engine.listWorkflows()[0].change_id)!.status, "COMPLETED");
  const rows = (engine.db.db.prepare("SELECT phase, status, count(*) c FROM approvals GROUP BY phase, status").all() as {
    phase: string;
    status: string;
    c: number;
  }[]).map((r) => ({ phase: r.phase, status: r.status, c: r.c }));
  assert.deepEqual(rows.sort((a, b) => a.phase.localeCompare(b.phase)), [
    { phase: "design", status: "APPROVED", c: 1 },
    { phase: "implementation", status: "APPROVED", c: 1 },
    { phase: "requirement", status: "APPROVED", c: 1 },
    { phase: "spec", status: "APPROVED", c: 1 },
    { phase: "task_planning", status: "APPROVED", c: 1 },
    { phase: "understanding", status: "APPROVED", c: 1 },
    { phase: "verification", status: "APPROVED", c: 1 },
  ]);
  // a completed workflow is no longer active and cannot be driven further
  assert.equal(engine.getActiveWorkflow(), null);
  assertThrowsWorkflowError(() => engine.fail("x"), "NO_ACTIVE_CHANGE");
  cleanup(root);
});
