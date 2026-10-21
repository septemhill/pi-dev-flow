import { test } from "vitest";
import assert from "node:assert/strict";
import { handleFactory } from "../src/commands/factory.ts";
import { getContract } from "../src/artifacts/artifact-registry.ts";
import {
  assertThrowsWorkflowError,
  cleanup,
  completePhase,
  makeArtifact,
  makeRoot,
  newEngine,
  writeChangeFile,
  type Engine,
} from "./helpers.ts";

/** Simulate a pre-contract recording: keep the row, drop the contract marker. */
function markLegacy(engine: Engine, phase: string): void {
  engine.db.db.prepare("UPDATE artifacts SET contract = NULL WHERE change_id = ? AND phase = ?").run(engine.requireActive().change_id, phase);
}

test("a legacy upstream blocks downstream phases with one actionable error (no TRACE_UNKNOWN_ITEM flood)", () => {
  const root = makeRoot();
  const engine = newEngine(root);
  const w = engine.initChange("legacy upstream");
  completePhase(root, engine, "requirement");
  markLegacy(engine, "requirement");

  engine.beginCurrentPhase(); // spec
  writeChangeFile(root, w.change_id, "spec.md", makeArtifact("spec", engine));
  const err = assertThrowsWorkflowError(() => engine.completeCurrentPhase(), "INVALID_ARTIFACT");
  assert.match(err.message, /TRACE_UPSTREAM_LEGACY/);
  assert.match(err.message, /requirement/);
  assert.match(err.message, /Re-run the "requirement" phase/);
  // the single legacy error stands in for all per-reference checks
  assert.ok(!err.message.includes("TRACE_UNKNOWN_ITEM"), err.message);
  // nothing recorded, phase unchanged
  assert.equal(engine.db.latestArtifact(w.change_id, "spec"), null);
  assert.equal(engine.requireActive().current_phase, "spec");
  engine.close();
  cleanup(root);
});

test("newly recorded artifacts carry the pinned contract marker", () => {
  const root = makeRoot();
  const engine = newEngine(root);
  const w = engine.initChange("contract marker");
  completePhase(root, engine, "requirement");
  const row = engine.db.latestArtifact(w.change_id, "requirement");
  assert.ok(row);
  assert.equal(row.contract, `${getContract("requirement").templateId}@${getContract("requirement").templateVersion}`);
  engine.close();
  cleanup(root);
});

test("/factory status marks legacy artifacts and a green workflow shows none", async () => {
  const root = makeRoot();
  const engine = newEngine(root);
  const w = engine.initChange("status legacy");
  completePhase(root, engine, "requirement");
  markLegacy(engine, "requirement");

  const notifications: string[] = [];
  const ctx = {
    cwd: engine.root,
    mode: "tui" as const,
    ui: { notify: (m: string) => notifications.push(m), setWidget: () => {} },
    isIdle: () => true,
    waitForIdle: async () => {},
  };
  const deps = { engineFor: () => engine, sendPhasePrompt: () => {} };

  await handleFactory("status", ctx, deps);
  const text = notifications.join("\n");
  assert.match(text, /Legacy:\s+requirement rev 1/);
  assert.match(text, /before template-driven validation/);
  engine.close();
  cleanup(root);

  // a fully post-contract workflow shows no legacy marker
  const root2 = makeRoot();
  const engine2 = newEngine(root2);
  engine2.initChange("green");
  completePhase(root2, engine2, "requirement");
  const n2: string[] = [];
  const ctx2 = { ...ctx, cwd: engine2.root, ui: { notify: (m: string) => n2.push(m), setWidget: () => {} } };
  await handleFactory("status", ctx2, { engineFor: () => engine2, sendPhasePrompt: () => {} });
  assert.ok(!n2.join("\n").includes("Legacy:"), n2.join("\n"));
  engine2.close();
  cleanup(root2);
});
