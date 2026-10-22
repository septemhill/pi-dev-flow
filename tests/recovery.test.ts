import { test } from "vitest";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import {
  assertThrowsWorkflowError,
  cleanup,
  changeFile,
  completePhase,
  makeArtifact,
  makeRoot,
  newEngine,
  writeChangeFile,
  type Engine,
} from "./helpers.ts";
import { handleFactory } from "../src/commands/factory.ts";

function ctxFor(engine: Engine, sent: string[]) {
  const notifications: { msg: string; type?: string }[] = [];
  return {
    ctx: {
      cwd: engine.root,
      mode: "tui",
      ui: {
        notify: (msg: string, type?: string) => notifications.push({ msg, type }),
        setWidget: () => {},
      },
      isIdle: () => true,
      waitForIdle: async () => {},
    },
    notifications,
    deps: { engineFor: () => engine, sendPhasePrompt: (p: string) => sent.push(p) },
  };
}

test("11a. corrupted database produces an explicit error (no silent reset)", () => {
  const root = makeRoot();
  const engine = newEngine(root);
  engine.initChange("corrupt me");
  const changeId = engine.requireActive().change_id;
  engine.close();
  // Corrupt the database file out-of-band (simulates disk corruption).
  writeFileSync(path.join(root, ".factory", "factory.db"), "this is not a sqlite database");
  rmSync(path.join(root, ".factory", "factory.db-wal"), { force: true });
  rmSync(path.join(root, ".factory", "factory.db-shm"), { force: true });
  assert.throws(
    () => newEngine(root),
    (e: unknown) => e instanceof Error && /PERSISTENCE_ERROR|not a database|corrupted/i.test(e.message),
  );
  // The change directory and any files are untouched — nothing was reset.
  assert.ok(existsSync(path.join(root, ".factory", "changes", changeId)), "change directory must survive");
  cleanup(root);
});

test("11b. missing artifact file is an explicit error, not a silent re-run", async () => {
  const root = makeRoot();
  const engine = newEngine(root);
  engine.initChange("missing file");
  completePhase(root, engine, "understanding");
  completePhase(root, engine, "requirement"); // requirement approved; on spec now
  const changeId = engine.getWorkflow(engine.listWorkflows()[0].change_id)!.change_id;
  rmSync(changeFile(root, changeId, "requirement.md"));
  // /factory resume must flag the integrity problem and change nothing.
  const { ctx, deps } = ctxFor(engine, []);
  await handleFactory("resume", ctx, deps);
  const w = engine.requireActive();
  assert.equal(w.status, "IDLE");
  assert.equal(w.current_phase, "spec");
  // completing any phase whose artifact vanished is refused explicitly
  engine.beginCurrentPhase();
  writeChangeFile(root, changeId, "design.md", makeArtifact("design", engine)); // wrong phase on purpose
  assertThrowsWorkflowError(() => engine.completeCurrentPhase(), "MISSING_ARTIFACT");
  engine.close();
  cleanup(root);
});

test("12. interrupted execution (RUNNING at kill time) does not silently skip work", async () => {
  const root = makeRoot();
  const e1 = newEngine(root);
  e1.initChange("crash mid-phase");
  completePhase(root, e1, "understanding");
  completePhase(root, e1, "requirement");
  e1.beginCurrentPhase(); // spec is RUNNING; now simulate a hard process death
  e1.close();

  // Fresh load: state must still be RUNNING on spec — no phase was skipped.
  const e2 = newEngine(root);
  const w = e2.requireActive();
  assert.equal(w.current_phase, "spec");
  assert.equal(w.status, "RUNNING");

  // /factory run on an interrupted phase is a SAFE resume: it re-prompts the
  // same phase (marked as possibly interrupted), it does not skip ahead.
  const sent: string[] = [];
  const { ctx, deps } = ctxFor(e2, sent);
  await handleFactory("run", ctx, deps);
  assert.equal(sent.length, 1, "exactly one phase work order re-sent");
  assert.match(sent[0], /spec/);
  assert.match(sent[0], /interrupted/i, "the prompt must warn about the possible interruption");
  assert.equal(e2.requireActive().current_phase, "spec");

  // And /factory resume explicitly recovers it to IDLE on the SAME phase.
  e2.beginCurrentPhase(); // idempotent no-op while RUNNING
  const r = e2.resume();
  assert.equal(r.recovered, true);
  assert.equal(e2.requireActive().current_phase, "spec");
  assert.equal(e2.requireActive().status, "IDLE");
  e2.close();
  cleanup(root);
});

test("FAILED workflow needs explicit recovery before it can run again", async () => {
  const root = makeRoot();
  const engine = newEngine(root);
  engine.initChange("failure path");
  engine.fail("LLM execution failed: provider error 500");
  assert.equal(engine.requireActive().status, "FAILED");
  // run is refused with the explicit recovery path
  const sent: string[] = [];
  const { ctx, notifications, deps } = ctxFor(engine, sent);
  await handleFactory("run", ctx, deps);
  assert.equal(sent.length, 0);
  assert.ok(notifications.some((n) => /resume/.test(n.msg)));
  // explicit resume recovers on the SAME phase
  const r = engine.resume();
  assert.equal(r.recovered, true);
  assert.equal(engine.requireActive().status, "IDLE");
  assert.equal(engine.requireActive().current_phase, "understanding");
  engine.close();
  cleanup(root);
});

test("resume never bypasses an approval gate", () => {
  const root = makeRoot();
  const engine = newEngine(root);
  engine.initChange("gate at resume");
  completePhase(root, engine, "understanding");
  engine.beginCurrentPhase();
  engine.appendRequirement("pending review");
  writeChangeFile(root, engine.requireActive().change_id, "requirement.md", makeArtifact("requirement", engine));
  engine.completeCurrentPhase();
  // AWAITING_APPROVAL: resume is a no-op, run is still refused.
  const r = engine.resume();
  assert.equal(r.recovered, false);
  assert.equal(engine.requireActive().status, "AWAITING_APPROVAL");
  assertThrowsWorkflowError(() => engine.beginCurrentPhase(), "PENDING_APPROVAL");
  engine.close();
  cleanup(root);
});

test("repeated /factory init is idempotent-safe (second one refused, none lost)", async () => {
  const root = makeRoot();
  const engine = newEngine(root);
  const a = engine.initChange("first");
  const sent: string[] = [];
  const { ctx, notifications, deps } = ctxFor(engine, sent);
  await handleFactory("init second change description", ctx, deps);
  assert.ok(notifications.some((n) => /ACTIVE_CHANGE_EXISTS/.test(n.msg)));
  assert.equal(engine.getActiveWorkflow()!.change_id, a.change_id, "original change must be intact");
  assert.equal(engine.listWorkflows().length, 1, "no phantom second change created");
  engine.close();
  cleanup(root);
});

test("missing change / no active change gives actionable errors", async () => {
  const root = makeRoot();
  const engine = newEngine(root);
  const sent: string[] = [];
  const { ctx, notifications, deps } = ctxFor(engine, sent);
  await handleFactory("status", ctx, deps);
  assert.ok(notifications.some((n) => /No active change/.test(n.msg)));
  await handleFactory("run", ctx, deps);
  assert.ok(notifications.some((n) => /NO_ACTIVE_CHANGE/.test(n.msg)));
  await handleFactory("approve", ctx, deps);
  assert.ok(notifications.some((n) => /NO_ACTIVE_CHANGE/.test(n.msg)));
  engine.close();
  cleanup(root);
});

test("workflow state round-trips through the /factory status command", async () => {
  const root = makeRoot();
  const engine = newEngine(root);
  engine.initChange("status check");
  completePhase(root, engine, "understanding");
  completePhase(root, engine, "requirement"); // -> spec, IDLE, spec artifact pending? no: approved
  const sent: string[] = [];
  const { ctx, notifications, deps } = ctxFor(engine, sent);
  await handleFactory("status", ctx, deps);
  const text = notifications.map((n) => n.msg).join("\n");
  assert.match(text, /spec/);
  assert.match(text, /IDLE/);
  engine.close();
  cleanup(root);
});
