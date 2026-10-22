import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { newEngine, cleanup, makeRoot } from "./helpers.ts";
import { handleKnowledge } from "../src/commands/knowledge.ts";
import type { CommandCtxLike, FactoryDeps } from "../src/commands/factory.ts";
import { baseConstraint, baseConvention } from "./knowledge-fixtures.ts";

let tmp: string | null = null;
afterEach(() => {
  if (tmp) {
    cleanup(tmp);
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

interface Ctx {
  ctx: CommandCtxLike;
  deps: FactoryDeps;
  notified: Array<{ msg: string; kind?: string }>;
  prompts: string[];
}

function setup(cwd: string): Ctx {
  const engine = newEngine(cwd);
  const notified: Ctx["notified"] = [];
  const prompts: string[] = [];
  const ctx: CommandCtxLike = {
    cwd,
    mode: "tui",
    isIdle: () => true,
    waitForIdle: async () => {},
    ui: {
      notify: (msg, kind) => notified.push({ msg, kind }),
      setWidget: () => {},
    },
  };
  const deps: FactoryDeps = { engineFor: () => engine, sendPhasePrompt: (p) => prompts.push(p) };
  return { ctx, deps, notified, prompts };
}

function fresh(): { root: string; c: Ctx } {
  const root = makeRoot();
  tmp = root;
  const c = setup(root);
  return { root, c };
}

function msgs(c: Ctx): string {
  return c.notified.map((n) => n.msg).join("\n");
}

async function run(c: Ctx, rest: string): Promise<void> {
  await handleKnowledge(rest, c.ctx, c.deps);
}

describe("/factory knowledge command: argument parsing and errors", () => {
  it("prints usage with no subcommand / unknown subcommand", async () => {
    const { c } = fresh();
    await run(c, "");
    expect(msgs(c)).toContain("Project Knowledge commands:");
    await run(c, "frobnicate");
    const last = c.notified.at(-1)!.msg;
    expect(last).toContain('Unknown knowledge subcommand "frobnicate"');
    expect(last).toContain("approve <id>");
  });

  it("rejects an unknown --type for add and list", async () => {
    const { c } = fresh();
    await run(c, "add --type bogus x");
    expect(c.notified.at(-1)!.msg).toContain('Unknown knowledge type "bogus"');
    expect(c.prompts).toHaveLength(0); // no work order sent
    await run(c, "list --type bogus");
    expect(c.notified.at(-1)!.msg).toContain('Unknown --type "bogus"');
  });

  it("requires --type for add", async () => {
    const { c } = fresh();
    await run(c, "add");
    expect(c.notified.at(-1)!.msg).toContain("Missing or unknown --type");
    expect(c.prompts).toHaveLength(0);
  });

  it("rejects too many positional arguments", async () => {
    const { c } = fresh();
    await run(c, "validate CON-001 EXTRA");
    expect(c.notified.at(-1)!.msg).toContain("Usage: /factory knowledge validate [id]");
    await run(c, "list --type constraint");
    expect(c.notified.at(-1)!.msg).toContain("No Project Knowledge records match");
  });

  it("reports unknown ids with an actionable message", async () => {
    const { c } = fresh();
    await run(c, "show NOPE-1");
    const msg = c.notified.at(-1)!.msg;
    expect(msg).toContain('No Project Knowledge record with id "NOPE-1"');
    expect(msg).toContain("/factory knowledge list");
  });
});

describe("/factory knowledge command: add work order", () => {
  it("sends exactly one work-order prompt with the requested description", async () => {
    const { c } = fresh();
    await run(c, "add --type constraint Credentials must not be logged");
    expect(c.prompts).toHaveLength(1);
    const p = c.prompts[0]!;
    expect(p).toContain("# [factory] Project Knowledge draft work order");
    expect(p).toContain("Credentials must not be logged");
    expect(p).toContain("factory_knowledge_draft");
    expect(p).toContain("type \"constraint\"");
    expect(c.notified.at(-1)!.msg).toContain("DRAFT");
    expect(c.notified.at(-1)!.msg).toContain("/factory knowledge approve");
  });

  it("auto type is explained as classification, NOT approval", async () => {
    const { c } = fresh();
    await run(c, "add --type auto something");
    expect(c.prompts[0]!).toContain("AUTOMATIC CLASSIFICATION, NOT automatic approval");
  });

  it("add without description tells the agent to ask the user first", async () => {
    const { c } = fresh();
    await run(c, "add --type convention");
    expect(c.prompts[0]!).toContain("ask the user what knowledge they want to record");
  });

  it("the work order carries the existing knowledge list and change context", async () => {
    const { root, c } = fresh();
    c.deps.engineFor(root).knowledge.createDraft("constraint", baseConstraint());
    await run(c, "add --type convention new thing");
    expect(c.prompts[0]!).toContain("CON-001");
    expect(c.prompts[0]!).toContain("do NOT create a duplicate");
  });
});

describe("/factory knowledge command: list / show / validate", () => {
  it("lists records with id, status, scope and paths", async () => {
    const { c } = fresh();
    const km = c.deps.engineFor(c.ctx.cwd).knowledge;
    km.createDraft("constraint", baseConstraint());
    km.approve("CON-001");
    km.createDraft("convention", baseConvention());
    await run(c, "list");
    const msg = c.notified.at(-1)!.msg;
    expect(msg).toContain("2 record(s)");
    expect(msg).toContain("CON-001  [approved]");
    expect(msg).toContain("CVN-001  [draft]");
    expect(msg).toContain(".factory/knowledge/constraints/CON-001.json");
  });

  it("list --status filters", async () => {
    const { c } = fresh();
    const km = c.deps.engineFor(c.ctx.cwd).knowledge;
    km.createDraft("constraint", baseConstraint());
    km.approve("CON-001");
    await run(c, "list --status draft");
    expect(c.notified.at(-1)!.msg).toContain("No Project Knowledge records match");
    await run(c, "list --status approved");
    expect(c.notified.at(-1)!.msg).toContain("CON-001");
  });

  it("show prints canonical JSON and markdown state", async () => {
    const { c } = fresh();
    const km = c.deps.engineFor(c.ctx.cwd).knowledge;
    km.createDraft("constraint", baseConstraint());
    await run(c, "show CON-001");
    const msg = c.notified.at(-1)!.msg;
    expect(msg).toContain('"id": "CON-001"');
    expect(msg).toContain('"status": "draft"');
    expect(msg).toContain("in sync");
    expect(msg).toContain("DRAFT_CREATED");
  });

  it("validate prints PASSED for a clean base and FAILED for a broken one", async () => {
    const { root, c } = fresh();
    const km = c.deps.engineFor(root).knowledge;
    km.createDraft("constraint", baseConstraint());
    await run(c, "validate");
    expect(c.notified.at(-1)!.msg).toContain("Result: PASSED");

    const json = path.join(root, ".factory", "knowledge", "constraints", "CON-001.json");
    const broken = JSON.parse(readFileSync(json, "utf8")) as Record<string, unknown>;
    broken.severity = "fatal";
    writeFileSync(json, JSON.stringify(broken), "utf8");
    await run(c, "validate");
    const msg = c.notified.at(-1)!.msg;
    expect(msg).toContain("Result: FAILED");
    expect(msg).toContain("severity");
  });
});

describe("/factory knowledge command: transitions", () => {
  it("approve makes a draft effective and shows both file paths", async () => {
    const { c } = fresh();
    const km = c.deps.engineFor(c.ctx.cwd).knowledge;
    km.createDraft("tech-decision", { schema_version: "1.0.0", title: "Use PostgreSQL", scope: { level: "project", paths: [] }, status: "draft", context: "c", decision: "d", rationale: "r", alternatives: [], consequences: [], supersedes: null });
    await run(c, "approve ADR-001");
    const msg = c.notified.at(-1)!.msg;
    expect(msg).toContain("ADR-001: draft -> accepted");
    expect(km.getKnowledge("ADR-001").doc.status).toBe("accepted");
  });

  it("approve twice is an error (illegal transition), not a silent no-op", async () => {
    const { c } = fresh();
    const km = c.deps.engineFor(c.ctx.cwd).knowledge;
    km.createDraft("constraint", baseConstraint());
    await run(c, "approve CON-001");
    expect(c.notified.at(-1)!.msg).toContain("CON-001: draft -> approved");
    await run(c, "approve CON-001");
    const msg = c.notified.at(-1)!.msg;
    expect(msg).toContain("[ILLEGAL_TRANSITION]");
    expect(msg).toContain("approved");
  });

  it("deprecate and reject behave per type", async () => {
    const { c } = fresh();
    const km = c.deps.engineFor(c.ctx.cwd).knowledge;
    km.createDraft("constraint", baseConstraint());
    km.approve("CON-001");
    await run(c, "deprecate CON-001");
    expect(c.notified.at(-1)!.msg).toContain("deprecated");
    expect(km.getKnowledge("CON-001").doc.status).toBe("deprecated");

    await run(c, "reject CON-001");
    expect(c.notified.at(-1)!.msg).toContain("[ILLEGAL_TRANSITION]");

    km.createDraft("convention", baseConvention());
    await run(c, "deprecate CVN-001");
    expect(c.notified.at(-1)!.msg).toContain("CVN-001: draft -> deprecated");
  });

  it("regenerate repairs a hand-edited projection and reports the path", async () => {
    const { root, c } = fresh();
    const km = c.deps.engineFor(root).knowledge;
    km.createDraft("constraint", baseConstraint());
    const md = path.join(root, ".factory", "generated", "knowledge", "constraints", "CON-001.md");
    writeFileSync(md, "tampered\n", "utf8");
    await run(c, "validate CON-001");
    expect(c.notified.at(-1)!.msg).toContain("out of sync");
    await run(c, "regenerate CON-001");
    expect(c.notified.at(-1)!.msg).toContain("Regenerated .factory/generated/knowledge/constraints/CON-001.md");
    await run(c, "validate CON-001");
    expect(c.notified.at(-1)!.msg).toContain("PASSED");
  });

  it("persistence failures surface as errors (not swallowed)", async () => {
    const { root, c } = fresh();
    const km = c.deps.engineFor(root).knowledge;
    km.createDraft("constraint", baseConstraint());
    // Block the GENERATED markdown directory (the canonical JSON stays intact).
    const gdir = path.join(root, ".factory", "generated", "knowledge");
    const sub = path.join(gdir, "constraints");
    rmSync(sub, { recursive: true, force: true });
    writeFileSync(sub, "blocker", "utf8");
    await run(c, "regenerate CON-001");
    const msg = c.notified.at(-1)!.msg;
    expect(msg).toContain("PERSISTENCE_ERROR");
    expect(c.notified.at(-1)!.kind).toBe("error");
    rmSync(sub);
    // The repair path works again once the block is gone.
    await run(c, "regenerate CON-001");
    expect(c.notified.at(-1)!.msg).toContain("Regenerated");
  });
});
