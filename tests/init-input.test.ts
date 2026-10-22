import { test } from "vitest";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseInitArgs, readAndCombineFiles } from "../src/commands/init-input.ts";
import { isWorkflowError } from "../src/workflow/errors.ts";
import { handleFactory } from "../src/commands/factory.ts";
import { cleanup, makeRoot, newEngine, type Engine } from "./helpers.ts";

/* ------------------------------------------------------------------ *
 * Argument parsing (pure)
 * ------------------------------------------------------------------ */

test("init-input: inline-only input preserves existing behavior", () => {
  const r = parseInitArgs("Implement a user authentication feature");
  assert.deepEqual(r, { inline: "Implement a user authentication feature", files: [] });
  // multiple spaces are normalized, as before
  const r2 = parseInitArgs("  add   login   ");
  assert.equal(r2.inline, "add login");
  assert.deepEqual(r2.files, []);
});

test("init-input: --file is repeatable and order is preserved", () => {
  const r = parseInitArgs("--file requirements/authentication.md --file requirements/security.md");
  assert.equal(r.inline, "");
  assert.deepEqual(r.files, ["requirements/authentication.md", "requirements/security.md"]);
});

test("init-input: --file without a path is a usage error", () => {
  assert.throws(
    () => parseInitArgs("--file"),
    (e: unknown) => isWorkflowError(e) && e.code === "INVALID_INIT_INPUT" && /--file requires a path/.test(e.message),
  );
  assert.throws(
    () => parseInitArgs("--file --file"),
    (e: unknown) => isWorkflowError(e) && /--file requires a path/.test(e.message),
  );
});

test("init-input: unknown options are rejected", () => {
  assert.throws(
    () => parseInitArgs("hello --bogus x"),
    (e: unknown) => isWorkflowError(e) && e.code === "INVALID_INIT_INPUT" && /Unknown option "--bogus"/.test(e.message),
  );
});

test("init-input: inline text and --file cannot be mixed", () => {
  assert.throws(
    () => parseInitArgs("Add login --file docs/req.md"),
    (e: unknown) => isWorkflowError(e) && e.code === "INVALID_INIT_INPUT" && /cannot be combined/.test(e.message),
  );
  // …in either order
  assert.throws(
    () => parseInitArgs("--file docs/req.md Add login"),
    (e: unknown) => isWorkflowError(e) && /cannot be combined/.test(e.message),
  );
});

test("init-input: duplicate --file paths are rejected", () => {
  assert.throws(
    () => parseInitArgs("--file a.md --file b.md --file a.md"),
    (e: unknown) => isWorkflowError(e) && /Duplicate --file path: "a.md"/.test(e.message),
  );
});

test("init-input: empty input yields no inline text and no files", () => {
  assert.deepEqual(parseInitArgs(""), { inline: "", files: [] });
});

/* ------------------------------------------------------------------ *
 * File reading + combining (temp dirs, no engine)
 * ------------------------------------------------------------------ */

function tmpdir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "factory-init-input-"));
}

const AUTH_MD = `# Authentication

Users must be able to sign in and sign out.
`;
const SEC_MD = `# Security

Authentication endpoints must enforce rate limits.
\`\`\`js
// code blocks survive verbatim
\`\`\`
`;

test("init-input: a single file is read and combined with a provenance label", () => {
  const dir = tmpdir();
  writeFileSync(path.join(dir, "authentication.md"), AUTH_MD);
  const out = readAndCombineFiles(["authentication.md"], dir);
  assert.equal(out, `# Input File 1: authentication.md\n\n${AUTH_MD}\n`);
  assert.match(out, /^# Input File 1: authentication\.md\n\n# Authentication\n/);
  assert.match(out, /sign in and sign out\./);
  assert.ok(!out.includes("---"), "a single file needs no separator");
  rmSync(dir, { recursive: true, force: true });
});

test("init-input: multiple files keep order, content and explicit boundaries", () => {
  const dir = tmpdir();
  writeFileSync(path.join(dir, "authentication.md"), AUTH_MD);
  writeFileSync(path.join(dir, "security.md"), SEC_MD);
  const out = readAndCombineFiles(["authentication.md", "security.md"], dir);

  // order: file 1 before file 2
  assert.ok(out.indexOf("# Input File 1: authentication.md") < out.indexOf("# Input File 2: security.md"));
  // boundary between the two ("\n\n---\n\n" separator; extra \n when content ends with one)
  assert.match(out, /sign out\.\n{2,3}---\n\n# Input File 2: security\.md/);
  // contents preserved verbatim, including the code block
  assert.ok(out.includes(AUTH_MD.trimEnd()));
  assert.ok(out.includes(SEC_MD.trimEnd()));
  assert.ok(out.includes("```js"));
  rmSync(dir, { recursive: true, force: true });
});

test("init-input: relative paths resolve against the working directory", () => {
  const dir = tmpdir();
  mkdirSync(path.join(dir, "requirements"));
  writeFileSync(path.join(dir, "requirements", "authentication.md"), AUTH_MD);
  const out = readAndCombineFiles(["requirements/authentication.md"], dir);
  assert.match(out, /^# Input File 1: requirements\/authentication\.md\n/);
  rmSync(dir, { recursive: true, force: true });
});

test("init-input: absolute paths work and fall back to absolute labels", () => {
  const dir = tmpdir();
  const p = path.join(dir, "authentication.md");
  writeFileSync(p, AUTH_MD);
  const out = readAndCombineFiles([p], path.join(dir, "somewhere-else"));
  assert.ok(out.includes(`# Input File 1: ${p}`), "outside cwd → absolute label");
  // inside cwd → relative label
  const out2 = readAndCombineFiles([p], dir);
  assert.ok(out2.includes("# Input File 1: authentication.md"));
  rmSync(dir, { recursive: true, force: true });
});

test("init-input: a missing file is reported by name and nothing is returned", () => {
  const dir = tmpdir();
  writeFileSync(path.join(dir, "a.md"), AUTH_MD);
  assert.throws(
    () => readAndCombineFiles(["a.md", "missing.md"], dir),
    (e: unknown) =>
      isWorkflowError(e) &&
      e.code === "INVALID_INIT_INPUT" &&
      /missing\.md/.test(e.message) &&
      /File not found/.test(e.message),
  );
  rmSync(dir, { recursive: true, force: true });
});

test("init-input: a directory path is rejected", () => {
  const dir = tmpdir();
  mkdirSync(path.join(dir, "adir"));
  assert.throws(
    () => readAndCombineFiles(["adir"], dir),
    (e: unknown) => isWorkflowError(e) && /is a directory/.test(e.message),
  );
  rmSync(dir, { recursive: true, force: true });
});

test("init-input: empty or whitespace-only files are rejected by name", () => {
  const dir = tmpdir();
  writeFileSync(path.join(dir, "empty.md"), "");
  writeFileSync(path.join(dir, "blank.md"), "   \n\t\n  ");
  assert.throws(
    () => readAndCombineFiles(["empty.md"], dir),
    (e: unknown) => isWorkflowError(e) && /"empty.md" is empty/.test(e.message),
  );
  assert.throws(
    () => readAndCombineFiles(["blank.md"], dir),
    (e: unknown) => isWorkflowError(e) && /"blank.md" is empty/.test(e.message),
  );
  rmSync(dir, { recursive: true, force: true });
});

test("init-input: invalid UTF-8 is rejected instead of silently replaced", () => {
  const dir = tmpdir();
  const p = path.join(dir, "binary.md");
  // 0xFF 0xFE are never valid UTF-8 lead bytes
  writeFileSync(p, Buffer.from([0xff, 0xfe, 0xff, 0x00, 0x41]));
  assert.throws(
    () => readAndCombineFiles(["binary.md"], dir),
    (e: unknown) => isWorkflowError(e) && /not valid UTF-8/.test(e.message),
  );
  rmSync(dir, { recursive: true, force: true });
});

test("init-input: an unreadable file is reported with its name (skipped as root)", () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return; // root bypasses permission bits; the EACCES path cannot be exercised
  }
  const dir = tmpdir();
  const p = path.join(dir, "locked.md");
  writeFileSync(p, AUTH_MD);
  chmodSync(p, 0o000);
  try {
    assert.throws(
      () => readAndCombineFiles(["locked.md"], dir),
      (e: unknown) => isWorkflowError(e) && /Cannot read "locked\.md"/.test(e.message),
    );
  } finally {
    chmodSync(p, 0o644);
  }
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * Command → workflow integration
 * ------------------------------------------------------------------ */

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

test("init command: file input reaches the same initialization path as inline input", async () => {
  const root = makeRoot();
  const engine = newEngine(root);
  const sent: string[] = [];

  mkdirSync(path.join(root, "requirements"), { recursive: true });
  const a = path.join(root, "requirements", "authentication.md");
  const b = path.join(root, "requirements", "security.md");
  writeFileSync(a, AUTH_MD);
  writeFileSync(b, SEC_MD);

  const { ctx, notifications, deps } = commandCtx(engine, sent);
  await handleFactory("init --file requirements/authentication.md --file requirements/security.md", ctx, deps);

  const w = engine.getActiveWorkflow();
  assert.ok(w, "a workflow must be created");
  assert.equal(w!.current_phase, "understanding");
  assert.equal(w!.status, "IDLE");
  // the combined text (order + boundaries + provenance) is THE description
  assert.equal(w!.description.indexOf("# Input File 1: requirements/authentication.md"), 0);
  assert.ok(w!.description.indexOf("# Input File 2: requirements/security.md") > 0);
  assert.match(w!.description, /---/);
  assert.match(w!.description, /sign in and sign out/);
  assert.match(w!.description, /rate limits/);
  assert.ok(notifications.some((n) => /Change created/.test(n)));
  assert.ok(notifications.some((n) => /2 file\(s\)/.test(n)));

  // identical to the inline path: same entry point, same gates
  const inlineRoot = makeRoot();
  const engine2 = newEngine(inlineRoot);
  engine2.initChange(w!.description);
  const w2 = engine2.getActiveWorkflow()!;
  assert.equal(w2.current_phase, "understanding");
  assert.equal(w2.status, "IDLE");
  assert.equal(w2.description, w!.description);

  engine.close();
  engine2.close();
  cleanup(root);
  cleanup(inlineRoot);
});

test("init command: inline input still works unchanged", async () => {
  const root = makeRoot();
  const engine = newEngine(root);
  const { ctx, notifications, deps } = commandCtx(engine, []);
  await handleFactory("init Implement a user authentication feature", ctx, deps);
  const w = engine.getActiveWorkflow();
  assert.equal(w!.description, "Implement a user authentication feature");
  assert.equal(w!.current_phase, "understanding");
  assert.ok(notifications.some((n) => /inline description/.test(n)));
  engine.close();
  cleanup(root);
});

test("init command: a failed file input creates no change and leaves existing state untouched", async () => {
  const root = makeRoot();
  const engine = newEngine(root);
  const existing = engine.initChange("the original change");

  mkdirSync(path.join(root, "requirements"), { recursive: true });
  writeFileSync(path.join(root, "requirements", "a.md"), AUTH_MD);
  const { ctx, notifications, deps } = commandCtx(engine, []);

  // second file does not exist
  await handleFactory("init --file requirements/a.md --file requirements/missing.md", ctx, deps);
  assert.ok(notifications.some((n) => /INVALID_INIT_INPUT/.test(n) && /missing\.md/.test(n)));
  assert.equal(engine.getActiveWorkflow()!.change_id, existing.change_id, "original change intact");
  assert.equal(engine.listWorkflows().length, 1, "no phantom change created");

  // a fresh root: a bad first file also creates nothing
  const root2 = makeRoot();
  const engine2 = newEngine(root2);
  const c2 = commandCtx(engine2, []);
  await handleFactory("init --file no-such.md", c2.ctx, c2.deps);
  assert.equal(engine2.listWorkflows().length, 0);
  assert.ok(c2.notifications.some((n) => /File not found: no-such\.md/.test(n)));

  engine.close();
  engine2.close();
  cleanup(root);
  cleanup(root2);
});

test("init command: no input shows usage without initializing", async () => {
  const root = makeRoot();
  const engine = newEngine(root);
  const { ctx, notifications, deps } = commandCtx(engine, []);
  await handleFactory("init", ctx, deps);
  assert.equal(engine.listWorkflows().length, 0, "nothing created");
  assert.ok(notifications.some((n) => /No description or files given/.test(n)));
  assert.ok(notifications.some((n) => /Factory commands/.test(n)));
  engine.close();
  cleanup(root);
});

test("init command: mixed inline + --file and --file without path are usage errors", async () => {
  const root = makeRoot();
  const engine = newEngine(root);
  const { ctx, notifications, deps } = commandCtx(engine, []);
  await handleFactory("init Add login --file docs/req.md", ctx, deps);
  assert.equal(engine.listWorkflows().length, 0);
  assert.ok(notifications.some((n) => /INVALID_INIT_INPUT/.test(n) && /cannot be combined/.test(n)));
  await handleFactory("init --file", ctx, deps);
  assert.equal(engine.listWorkflows().length, 0);
  assert.ok(notifications.some((n) => /INVALID_INIT_INPUT/.test(n) && /--file requires a path/.test(n)));
  engine.close();
  cleanup(root);
});
