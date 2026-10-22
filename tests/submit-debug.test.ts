import { test } from "vitest";
import assert from "node:assert/strict";
import factoryExtension from "../index.ts";
import { cleanup, makeRoot, makeUnderstandingDoc, newEngine } from "./helpers.ts";

type ToolDef = {
  name: string;
  execute: (
    id: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
};

function capturedTools(): Map<string, ToolDef> {
  const tools = new Map<string, ToolDef>();
  const pi = {
    registerCommand: () => {},
    registerTool: (t: ToolDef) => void tools.set(t.name, t),
    sendUserMessage: () => {},
    on: () => {},
  };
  factoryExtension(pi as never);
  return tools;
}

function toolCtx(root: string) {
  return { cwd: root, mode: "tui" as const, ui: { notify: () => {}, setWidget: () => {} }, isIdle: () => true, waitForIdle: async () => {} };
}

function text(res: { content: Array<{ text: string }> }): string {
  return res.content.map((b) => b.text).join("\n");
}

async function submit(tools: Map<string, ToolDef>, root: string, params: unknown) {
  const tool = tools.get("factory_understanding_submit")!;
  assert.ok(tool, "factory_understanding_submit must be registered");
  return tool.execute("t1", params, undefined, undefined, toolCtx(root));
}

test("submit debug: reports wrong-cwd / no-active-workflow failures with engine root and state", async () => {
  const root = makeRoot();
  const tools = capturedTools();

  const res = await submit(tools, root, { document: makeUnderstandingDoc("chg-x", "anything") });
  assert.equal(res.isError, true);
  const t = text(res);
  assert.match(t, /Debug:/);
  assert.match(t, /engine root \(cwd used for this call\): /);
  assert.match(t, /active workflow: NONE/);
  assert.match(t, /this directory/i);
  cleanup(root);
});

test("submit debug: reports a missing document parameter explicitly", async () => {
  const root = makeRoot();
  const engine = newEngine(root);
  engine.initChange("debug missing param");
  engine.beginCurrentPhase();

  const tools = capturedTools();
  const res = await submit(tools, root, {});
  assert.equal(res.isError, true);
  assert.match(text(res), /params\.document is UNDEFINED/);
  engine.close();
  cleanup(root);
});

test("submit debug: reports document shape problems (missing/extra top-level keys, metadata) alongside the validation errors", async () => {
  const root = makeRoot();
  const engine = newEngine(root);
  const w = engine.initChange("debug shape");
  engine.beginCurrentPhase();

  const tools = capturedTools();
  const doc = makeUnderstandingDoc(w.change_id, "debug shape");
  delete (doc as Record<string, unknown>).summary;
  (doc as Record<string, unknown>).strayKey = "unexpected";

  const res = await submit(tools, root, { document: doc });
  assert.equal(res.isError, true);
  const t = text(res);
  assert.match(t, /missing top-level keys: summary/);
  assert.match(t, /unexpected top-level keys/);
  assert.match(t, /strayKey/);
  assert.match(t, /- input: metadata = /);
  assert.match(t, /INVALID_ARTIFACT/);
  engine.close();
  cleanup(root);
});

test("submit debug: unexpected (non-WorkflowError) exceptions are reported with a stack", async () => {
  const root = makeRoot();
  const engine = newEngine(root);
  const w = engine.initChange("debug crash");
  engine.beginCurrentPhase();

  const tools = capturedTools();
  const doc = makeUnderstandingDoc(w.change_id, "debug crash");
  // a getter-only sourcePrompt makes the engine's pinning assignment throw a
  // plain TypeError — exactly the class of bug a bare error message hides
  Object.defineProperty(doc, "sourcePrompt", { get(): string { throw new Error("boom in getter"); }, enumerable: true });

  const res = await submit(tools, root, { document: doc });
  assert.equal(res.isError, true);
  const t = text(res);
  assert.match(t, /UNEXPECTED exception \(not a WorkflowError\)/);
  assert.match(t, /boom in getter/);
  assert.match(t, /at /, "a stack trace must be included");
  engine.close();
  cleanup(root);
});

test("submit debug: the success path reports the workflow state", async () => {
  const root = makeRoot();
  const engine = newEngine(root);
  const w = engine.initChange("debug success");
  engine.beginCurrentPhase();

  const tools = capturedTools();
  const res = await submit(tools, root, { document: makeUnderstandingDoc(w.change_id, "debug success") });
  assert.equal(res.isError, undefined);
  const t = text(res);
  assert.match(t, /Understanding document accepted/);
  assert.match(t, /Workflow state: change=/);
  assert.match(t, /status=RUNNING phase=understanding/);
  engine.close();
  cleanup(root);
});
