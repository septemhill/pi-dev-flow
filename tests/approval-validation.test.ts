import { test } from "vitest";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { handleFactory } from "../src/commands/factory.ts";
import {
  assertThrowsWorkflowError,
  cleanup,
  completePhase,
  makeArtifact,
  makeRoot,
  newEngine,
  reviseRequirement,
  writeChangeFile,
  changeFile,
} from "./helpers.ts";

test("a non-conformant artifact cannot complete a phase and is not recorded", () => {
  const root = makeRoot();
  const engine = newEngine(root);
  const w = engine.initChange("blocked by contract");
  engine.beginCurrentPhase();
  engine.appendRequirement("a real statement");
  writeChangeFile(root, w.change_id, "requirement.md", "not a factory artifact at all");
  const err = assertThrowsWorkflowError(() => engine.completeCurrentPhase(), "INVALID_ARTIFACT");
  assert.match(err.message, /FAILED validation/);
  // phase state unchanged, nothing recorded, no approval requested
  const now = engine.requireActive();
  assert.equal(now.current_phase, "requirement");
  assert.equal(now.status, "RUNNING");
  assert.equal(now.pending_approval_id, null);
  assert.equal(engine.db.latestArtifact(w.change_id, "requirement"), null);
  // the failed validation is persisted for audit
  const results = engine.db.listValidationResults(w.change_id);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.phase, "requirement");
  assert.equal(results[0]!.valid, false);
  assert.ok(results[0]!.errorCount > 0);
  engine.close();
  cleanup(root);
});

test("a stale revision (unchanged file after rejection) is refused; the revised one passes", () => {
  const root = makeRoot();
  const engine = newEngine(root);
  const w = engine.initChange("stale revision");
  engine.beginCurrentPhase();
  engine.appendRequirement("statement one");
  writeChangeFile(root, w.change_id, "requirement.md", makeArtifact("requirement", engine));
  engine.completeCurrentPhase();
  assert.equal(engine.requireActive().status, "AWAITING_APPROVAL");

  engine.reject("needs a security requirement");
  engine.beginCurrentPhase();
  // an external edit landed without bumping the declared revision → stale
  const staleText = readFileSync(changeFile(engine.root, w.change_id, "requirement.md"), "utf8") + "\n- edited without bumping the revision\n";
  writeChangeFile(root, w.change_id, "requirement.md", staleText);
  const err = assertThrowsWorkflowError(() => engine.completeCurrentPhase(), "INVALID_ARTIFACT");
  assert.match(err.message, /SEM_REVISION_MISMATCH/);
  const results = engine.db.listValidationResults(w.change_id);
  assert.ok(results.some((r) => !r.valid && r.resultJson.includes("SEM_REVISION_MISMATCH")));

  // revise (bump revision + add content) and it passes
  reviseRequirement(engine, "- Security: the feature must not accept untrusted input.");
  engine.completeCurrentPhase();
  assert.equal(engine.requireActive().status, "AWAITING_APPROVAL");
  assert.ok(engine.db.latestArtifact(w.change_id, "requirement")!.revision >= 1);
  engine.close();
  cleanup(root);
});

test("a tampered upstream artifact blocks the downstream phase (integrity is re-verified)", () => {
  const root = makeRoot();
  const engine = newEngine(root);
  engine.initChange("tamper");
  completePhase(root, engine, "requirement");
  completePhase(root, engine, "spec");
  const changeId = engine.requireActive().change_id;

  // an out-of-band edit to the approved requirement (e.g. sloppy user edit)
  const file = writeChangeFile(root, changeId, "requirement.md", "");
  appendFileSync(file, "\n- sneaky late addition\n");

  engine.beginCurrentPhase(); // design
  writeChangeFile(root, changeId, "design.md", makeArtifact("design", engine));
  const err = assertThrowsWorkflowError(() => engine.completeCurrentPhase(), "INVALID_ARTIFACT");
  assert.match(err.message, /TRACE_UPSTREAM_MODIFIED/);
  assert.equal(engine.requireActive().current_phase, "design");
  assert.equal(engine.requireActive().status, "RUNNING");
  assert.equal(engine.db.latestArtifact(changeId, "design"), null);
  engine.close();
  cleanup(root);
});

test("a conformant artifact completes with a persisted passing validation", () => {
  const root = makeRoot();
  const engine = newEngine(root);
  const w = engine.initChange("green path");
  completePhase(root, engine, "requirement");
  const results = engine.db.listValidationResults(w.change_id);
  const req = results.filter((r) => r.phase === "requirement");
  assert.ok(req.length >= 1);
  assert.equal(req.at(-1)!.valid, true);
  assert.equal(req.at(-1)!.errorCount, 0);
  assert.match(req.at(-1)!.schemaId, /requirement\.schema\.json/);
  engine.close();
  cleanup(root);
});

test("/factory validate re-runs validation without side effects", async () => {
  const root = makeRoot();
  const engine = newEngine(root);
  const w = engine.initChange("validate command");
  const notifications: { msg: string }[] = [];
  const deps = {
    engineFor: () => engine,
    sendPhasePrompt: () => {},
  };
  const ctx = {
    cwd: engine.root,
    mode: "tui" as const,
    ui: {
      notify: (msg: string) => notifications.push({ msg }),
      setWidget: () => {},
    },
    isIdle: () => true,
    waitForIdle: async () => {},
  };

  engine.beginCurrentPhase();
  engine.appendRequirement("statement");
  writeChangeFile(root, w.change_id, "requirement.md", makeArtifact("requirement", engine));
  await handleFactory("validate", ctx, deps);
  let text = notifications.map((n) => n.msg).join("\n");
  assert.match(text, /Validation PASSED/i);
  assert.match(text, /requirement/);
  // validation never moves the workflow
  const now = engine.requireActive();
  assert.equal(now.current_phase, "requirement");
  assert.equal(now.status, "RUNNING");
  assert.equal(now.pending_approval_id, null);
  assert.equal(engine.db.latestArtifact(w.change_id, "requirement"), null);

  // and it reports failures the same way
  notifications.length = 0;
  writeChangeFile(root, w.change_id, "requirement.md", "garbage");
  await handleFactory("validate", ctx, deps);
  text = notifications.map((n) => n.msg).join("\n");
  assert.match(text, /Validation FAILED/i);
  engine.close();
  cleanup(root);
});

test("no engine path records an artifact that skipped validation", () => {
  const root = makeRoot();
  const engine = newEngine(root);
  const w = engine.initChange("no bypass");
  engine.beginCurrentPhase();
  engine.appendRequirement("s");
  // attempt the old MVP shortcut: file on disk but never through the contract gate
  writeChangeFile(root, w.change_id, "requirement.md", makeArtifact("requirement", engine).replace("- Status: complete", "- Status: draft"));
  assertThrowsWorkflowError(() => engine.completeCurrentPhase(), "INVALID_ARTIFACT");
  assert.equal(engine.db.latestArtifact(w.change_id, "requirement"), null, "the draft was never recorded");
  engine.close();
  cleanup(root);
});
