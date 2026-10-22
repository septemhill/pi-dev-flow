import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  assertThrowsWorkflowError,
  cleanup,
  changeFile,
  completePhase,
  makeRoot,
  makeUnderstandingDoc,
  newEngine,
  type Engine,
} from "./helpers.ts";
import { sha256 } from "../src/artifacts/artifact-store.ts";
import { renderUnderstandingMarkdown } from "../src/artifacts/understanding-renderer.ts";
import { buildPhasePrompt } from "../src/execution/phase-executor.ts";

function newChange(root: string, description = "Add a retry helper to the downloader"): { engine: Engine; changeId: string } {
  const engine = newEngine(root);
  const w = engine.initChange(description);
  return { engine, changeId: w.change_id };
}

/** understanding RUNNING, nothing submitted yet. */
function runningUnderstanding(root: string, description?: string): { engine: Engine; changeId: string } {
  const { engine, changeId } = newChange(root, description);
  engine.beginCurrentPhase();
  return { engine, changeId };
}

test("understanding: a valid submission persists JSON + deterministic Markdown and requests approval", () => {
  const root = makeRoot();
  const { engine, changeId } = runningUnderstanding(root, "Add a retry helper");
  const doc = makeUnderstandingDoc(changeId, "Add a retry helper");

  const r = engine.submitUnderstanding(doc);
  assert.equal(r.revision, 1);

  const jsonFile = changeFile(root, changeId, "understanding.json");
  const mdFile = changeFile(root, changeId, "understanding.md");
  const jsonText = readFileSync(jsonFile, "utf8");
  const mdText = readFileSync(mdFile, "utf8");

  // canonical JSON round-trips and matches the submitted document
  assert.deepEqual(JSON.parse(jsonText), doc);
  // the Markdown is the deterministic render of the JSON (and nothing else)
  assert.equal(mdText, renderUnderstandingMarkdown(doc));
  assert.match(mdText, /^# Understanding$/m);
  assert.match(mdText, /## 1\. Metadata/);
  assert.match(mdText, /## 10\. Traceability/);
  assert.match(mdText, /CR-001/);

  // completion validates, records the artifact, and pins the JSON hash
  engine.completeCurrentPhase();
  const w = engine.requireActive();
  assert.equal(w.status, "AWAITING_APPROVAL");
  assert.equal(w.current_phase, "understanding");
  const approval = engine.db.getApproval(w.pending_approval_id!);
  assert.equal(approval!.artifact_hash, sha256(jsonText), "approval must pin the canonical JSON");
  const art = engine.db.latestArtifact(changeId, "understanding");
  assert.equal(art!.revision, 1);
  assert.equal(art!.hash, sha256(jsonText));
  engine.close();
  cleanup(root);
});

test("understanding: a failed submission writes nothing (previous state untouched)", () => {
  const root = makeRoot();
  const { engine, changeId } = runningUnderstanding(root, "Broken submit");

  // schema-invalid: duplicate local ids across collections is semantic;
  // use a missing required field for a schema-level failure
  const bad = makeUnderstandingDoc(changeId, "Broken submit");
  delete (bad as Record<string, unknown>).summary;
  const err = assertThrowsWorkflowError(() => engine.submitUnderstanding(bad), "INVALID_ARTIFACT");
  assert.match(err.message, /FAILED validation/);

  assert.throws(() => readFileSync(changeFile(root, changeId, "understanding.json")), /ENOENT/, "no JSON may be written");
  assert.throws(() => readFileSync(changeFile(root, changeId, "understanding.md")), /ENOENT/, "no Markdown may be rendered before the JSON validates");
  assert.equal(engine.db.latestArtifact(changeId, "understanding"), null, "nothing may be recorded");
  engine.close();
  cleanup(root);
});

test("understanding: malformed JSON text is rejected as a contract error", () => {
  const root = makeRoot();
  const { engine } = runningUnderstanding(root, "Malformed");
  const err = assertThrowsWorkflowError(() => engine.submitUnderstanding("{ this is not json ]"), "CONTRACT_ERROR");
  assert.match(err.message, /not valid JSON/i);
  engine.close();
  cleanup(root);
});

test("understanding: semantic rules are enforced (change id, verbatim prompt, status, ids, refs)", () => {
  const root = makeRoot();
  const { engine, changeId } = runningUnderstanding(root, "Semantics");
  const desc = "Semantics";

  const wrongChange = makeUnderstandingDoc("chg-19700101-000000", desc);
  let err = assertThrowsWorkflowError(() => engine.submitUnderstanding(wrongChange), "INVALID_ARTIFACT");
  assert.match(err.message, /SEM_CHANGE_ID_MISMATCH/);

  const paraphrased = makeUnderstandingDoc(changeId, "The semantics of things");
  err = assertThrowsWorkflowError(() => engine.submitUnderstanding(paraphrased), "INVALID_ARTIFACT");
  assert.match(err.message, /SEM_SOURCE_PROMPT_MISMATCH/);
  assert.match(err.message, /VERBATIM/);

  const draft = makeUnderstandingDoc(changeId, desc, { metadata: makeUnderstandingDoc(changeId, desc).metadata });
  (draft.metadata as Record<string, unknown>).status = "draft";
  err = assertThrowsWorkflowError(() => engine.submitUnderstanding(draft), "INVALID_ARTIFACT");
  assert.match(err.message, /SEM_STATUS_NOT_COMPLETE/);

  const dup = makeUnderstandingDoc(changeId, desc);
  (dup.ambiguities as Array<Record<string, unknown>>).push({
    id: "Q-001",
    question: "A second entry with the same stable id.",
    interpretations: ["a", "b"],
    impact: "confusion",
    status: "open",
  });
  err = assertThrowsWorkflowError(() => engine.submitUnderstanding(dup), "INVALID_ARTIFACT");
  assert.match(err.message, /SEM_DUPLICATE_ID/);

  const dangling = makeUnderstandingDoc(changeId, desc);
  (dangling.candidateRequirements as Array<Record<string, unknown>>)[0]!.sourceRefs = ["EXP-999"];
  err = assertThrowsWorkflowError(() => engine.submitUnderstanding(dangling), "INVALID_ARTIFACT");
  assert.match(err.message, /SEM_BAD_REF/);

  assert.equal(engine.db.latestArtifact(changeId, "understanding"), null);
  engine.close();
  cleanup(root);
});

test("understanding: a hand-edited Markdown projection is refused and can be regenerated deterministically", () => {
  const root = makeRoot();
  const { engine, changeId } = runningUnderstanding(root, "Stale md");
  const doc = makeUnderstandingDoc(changeId, "Stale md");
  engine.submitUnderstanding(doc);

  const mdFile = changeFile(root, changeId, "understanding.md");
  writeFileSync(mdFile, readFileSync(mdFile, "utf8") + "\n- a human edit that was never part of the JSON\n", "utf8");

  const err = assertThrowsWorkflowError(() => engine.completeCurrentPhase(), "INVALID_ARTIFACT");
  assert.match(err.message, /UNDERSTANDING_MD_STALE/);

  // recovery without any LLM call: the extension re-renders from the JSON
  engine.regenerateUnderstanding();
  assert.equal(readFileSync(mdFile, "utf8"), renderUnderstandingMarkdown(doc));
  engine.completeCurrentPhase();
  assert.equal(engine.requireActive().status, "AWAITING_APPROVAL");
  engine.close();
  cleanup(root);
});

test("understanding: a deleted Markdown projection is refused until regenerated", () => {
  const root = makeRoot();
  const { engine, changeId } = runningUnderstanding(root, "Missing md");
  const doc = makeUnderstandingDoc(changeId, "Missing md");
  engine.submitUnderstanding(doc);

  const mdFile = changeFile(root, changeId, "understanding.md");
  rmSync(mdFile);
  const err = assertThrowsWorkflowError(() => engine.completeCurrentPhase(), "INVALID_ARTIFACT");
  assert.match(err.message, /UNDERSTANDING_MD_MISSING/);

  engine.regenerateUnderstanding();
  engine.completeCurrentPhase();
  assert.equal(engine.requireActive().status, "AWAITING_APPROVAL");
  engine.close();
  cleanup(root);
});

test("understanding: only the understanding phase may be submitted, and only while RUNNING", () => {
  const root = makeRoot();
  const { engine, changeId } = newChange(root, "Wrong phase");
  const doc = makeUnderstandingDoc(changeId, "Wrong phase");

  // IDLE (not started): refused
  assertThrowsWorkflowError(() => engine.submitUnderstanding(doc), "ILLEGAL_TRANSITION");

  engine.beginCurrentPhase();
  engine.submitUnderstanding(doc);
  engine.completeCurrentPhase();
  // AWAITING_APPROVAL: refused (no resubmission behind the approval gate)
  assertThrowsWorkflowError(() => engine.submitUnderstanding(makeUnderstandingDoc(changeId, "Wrong phase")), "ILLEGAL_TRANSITION");

  engine.approve("ok");
  // now on requirement: refused
  engine.beginCurrentPhase(); // start the requirement phase
  assert.equal(engine.requireActive().current_phase, "requirement");
  assertThrowsWorkflowError(() => engine.submitUnderstanding(doc), "ILLEGAL_TRANSITION");
  engine.close();
  cleanup(root);
});

test("understanding: resubmitting the identical document keeps its revision; a changed one bumps it", () => {
  const root = makeRoot();
  const { engine, changeId } = runningUnderstanding(root, "Revisioning");
  const doc = makeUnderstandingDoc(changeId, "Revisioning");
  engine.submitUnderstanding(doc);
  engine.completeCurrentPhase();
  engine.reject("needs more detail");
  engine.beginCurrentPhase();

  // identical content → same revision
  assert.equal(engine.submitUnderstanding(doc).revision, 1);
  // changed content → next revision (the work order tells the agent to declare
  // the expected revision in metadata; the extension refuses a wrong one)
  const doc2 = makeUnderstandingDoc(changeId, "Revisioning", {
    summary: {
      ...makeUnderstandingDoc(changeId, "Revisioning").summary,
      narrative: "Amended after rejection: the retry helper is bounded.",
    },
  });
  (doc2.metadata as Record<string, unknown>).revision = 2;
  assert.equal(engine.submitUnderstanding(doc2).revision, 2);
  engine.close();
  cleanup(root);
});

test("understanding: the requirement phase cannot start while the approved artifact no longer validates", () => {
  const root = makeRoot();
  const { engine, changeId } = runningUnderstanding(root, "Tamper guard");
  engine.submitUnderstanding(makeUnderstandingDoc(changeId, "Tamper guard"));
  engine.completeCurrentPhase();
  engine.approve("ok");
  assert.equal(engine.requireActive().current_phase, "requirement");

  // out-of-band tamper with the approved canonical JSON
  const jsonFile = changeFile(root, changeId, "understanding.json");
  const doc = JSON.parse(readFileSync(jsonFile, "utf8"));
  doc.candidateRequirements[0].statement = "Tampered after approval.";
  writeFileSync(jsonFile, JSON.stringify(doc, null, 2) + "\n", "utf8");

  const err = assertThrowsWorkflowError(() => engine.beginCurrentPhase(), "PERSISTENCE_ERROR");
  assert.match(err.message, /no longer matches the approved revision/i);
  assert.equal(engine.requireActive().status, "IDLE");
  engine.close();
  cleanup(root);
});

test("understanding: a recorded-but-deleted artifact blocks requirement start explicitly", () => {
  const root = makeRoot();
  const { engine, changeId } = runningUnderstanding(root, "Deleted guard");
  engine.submitUnderstanding(makeUnderstandingDoc(changeId, "Deleted guard"));
  engine.completeCurrentPhase();
  engine.approve("ok");

  rmSync(changeFile(root, changeId, "understanding.json"));
  const err = assertThrowsWorkflowError(() => engine.beginCurrentPhase(), "PERSISTENCE_ERROR");
  assert.match(err.message, /missing from disk/i);
  engine.close();
  cleanup(root);
});

test("understanding: the requirement work order carries a digest of the approved understanding", () => {
  const root = makeRoot();
  const { engine } = newChange(root, "Digest check");
  completePhase(root, engine, "understanding");
  const w = engine.requireActive();
  assert.equal(w.current_phase, "requirement");

  const s = engine.snapshot();
  const prompt = buildPhasePrompt({
    workflow: s.workflow!,
    artifacts: s.artifacts,
    rejection: s.lastRejection,
    tasks: s.tasks,
    checks: s.checks,
    restarted: false,
    repoRoot: root,
    projectKnowledge: engine.knowledge.summaryForPrompt() || "(none yet)",
  });
  assert.match(prompt, /## Understanding artifact \(approved input/);
  assert.match(prompt, /CR-001/);
  assert.match(prompt, /EXP-001/);
  assert.match(prompt, /Q-001/);
  assert.match(prompt, /candidate requirements/i);
  engine.close();
  cleanup(root);
});

test("understanding: the work order pins the verbatim prompt, schema and skeleton", () => {
  const root = makeRoot();
  const { engine } = newChange(root, "Prompt check with `backticks` and # heading markers");
  const s = engine.snapshot();
  const prompt = buildPhasePrompt({
    workflow: s.workflow!,
    artifacts: s.artifacts,
    rejection: s.lastRejection,
    tasks: s.tasks,
    checks: s.checks,
    restarted: false,
    repoRoot: root,
    projectKnowledge: "(none yet)",
  });
  assert.match(prompt, /## Original prompt \(verbatim source input\)/);
  assert.match(prompt, /factory_understanding_submit/);
  assert.match(prompt, /JSON Schema/);
  assert.match(prompt, /"understanding"/);
  assert.match(prompt, /Document skeleton/);
  assert.ok(!prompt.includes("# [factory] Work order: phase \"requirement\""));
  engine.close();
  cleanup(root);
});

test("understanding: the renderer is deterministic and escapes untrusted content", () => {
  const doc = makeUnderstandingDoc("chg-1", 'Prompt with "quotes", a #fake heading, and ```fence``` markers');
  const a = renderUnderstandingMarkdown(doc);
  const b = renderUnderstandingMarkdown(doc);
  assert.equal(a, b, "rendering must be a pure function of the document");

  // the original prompt is fenced so its text cannot inject Markdown structure
  // (the fence grows past any backtick runs inside the prompt)
  const m = a.match(/## 2\. Original Prompt\n\n(`{3,})text\n([^\n]*)\n\1/);
  assert.ok(m, "sourcePrompt must be rendered inside a code fence");
  assert.match(m![2], /#fake heading/);
  // a heading line inside free text cannot create a real section
  assert.ok(!/^#fake heading$/m.test(a.replace(/`{3,}[\s\S]*?`{3,}/g, "")));
});

test("understanding: malformed Markdown structure is detected by the projection validator", () => {
  const root = makeRoot();
  const { engine, changeId } = runningUnderstanding(root, "Md structure");
  const doc = makeUnderstandingDoc(changeId, "Md structure");
  engine.submitUnderstanding(doc);

  // break the fixed structure: rename a section heading
  const mdFile = changeFile(root, changeId, "understanding.md");
  writeFileSync(mdFile, readFileSync(mdFile, "utf8").replace("## 1. Metadata", "## 1. Meta"), "utf8");
  const err = assertThrowsWorkflowError(() => engine.completeCurrentPhase(), "INVALID_ARTIFACT");
  assert.ok(
    /UNDERSTANDING_MD_STALE|UNDERSTANDING_MD_BADSTRUCTURE/.test(err.message),
    `expected a structural Markdown error, got: ${err.message}`,
  );
  engine.close();
  cleanup(root);
});

import { handleFactory } from "../src/commands/factory.ts";

function commandCtx(engine: Engine, sent: string[]) {
  const notifications: string[] = [];
  return {
    ctx: {
      cwd: engine.root,
      mode: "tui" as const,
      ui: { notify: (msg: string) => notifications.push(msg), setWidget: () => {} },
      isIdle: () => true,
      waitForIdle: async () => {},
    },
    notifications,
    deps: { engineFor: () => engine, sendPhasePrompt: (p: string) => sent.push(p) },
  };
}

test("understanding: /factory validate re-runs the full validation on the JSON artifact", async () => {
  const root = makeRoot();
  const { engine, changeId } = runningUnderstanding(root, "Validate command");
  engine.submitUnderstanding(makeUnderstandingDoc(changeId, "Validate command"));
  const { ctx, notifications, deps } = commandCtx(engine, []);
  await handleFactory("validate", ctx, deps);
  let text = notifications.join("\n");
  assert.match(text, /Validation PASSED/i);
  assert.match(text, /understanding/);
  // workflow unchanged, nothing recorded beyond the validation row
  const w = engine.requireActive();
  assert.equal(w.current_phase, "understanding");
  assert.equal(w.status, "RUNNING");

  // a broken JSON on disk is reported as FAILED with the JSON error
  writeFileSync(changeFile(root, changeId, "understanding.json"), "{ not json");
  notifications.length = 0;
  await handleFactory("validate", ctx, deps);
  text = notifications.join("\n");
  assert.match(text, /Validation FAILED/i);
  assert.match(text, /STRUCTURE_INVALID_JSON/);
  engine.close();
  cleanup(root);
});

test("understanding: full workflow runs understanding first and completes all seven phases", () => {
  const root = makeRoot();
  const { engine, changeId } = newChange(root, "Seven phases");
  completePhase(root, engine, "understanding");
  completePhase(root, engine, "requirement");
  completePhase(root, engine, "spec");
  completePhase(root, engine, "design");
  completePhase(root, engine, "task_planning");
  completePhase(root, engine, "implementation");
  completePhase(root, engine, "verification");
  assert.equal(engine.getActiveWorkflow(), null);
  const rows = (engine.db.db.prepare("SELECT phase, status, count(*) c FROM approvals GROUP BY phase, status").all() as {
    phase: string;
    status: string;
    c: number;
  }[])
    .map((r) => ({ phase: r.phase, status: r.status, c: r.c }))
    .sort((x, y) => x.phase.localeCompare(y.phase));
  assert.deepEqual(
    rows,
    [
      { phase: "design", status: "APPROVED", c: 1 },
      { phase: "implementation", status: "APPROVED", c: 1 },
      { phase: "requirement", status: "APPROVED", c: 1 },
      { phase: "spec", status: "APPROVED", c: 1 },
      { phase: "task_planning", status: "APPROVED", c: 1 },
      { phase: "understanding", status: "APPROVED", c: 1 },
      { phase: "verification", status: "APPROVED", c: 1 },
    ],
  );
  assert.ok(changeId);
  engine.close();
  cleanup(root);
});
