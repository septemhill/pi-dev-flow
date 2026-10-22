import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { newEngine, cleanup, makeRoot } from "./helpers.ts";
import { KnowledgeManager } from "../src/knowledge/manager.ts";
import { renderKnowledgeMarkdown } from "../src/knowledge/renderer.ts";
import { isWorkflowError, WorkflowError } from "../src/workflow/errors.ts";
import { baseConstraint, baseConvention, baseDecision } from "./knowledge-fixtures.ts";

let tmp: string | null = null;
afterEach(() => {
  if (tmp) {
    cleanup(tmp);
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

function setup(): { root: string; km: KnowledgeManager; engine: ReturnType<typeof newEngine> } {
  const root = makeRoot();
  tmp = root;
  const engine = newEngine(root);
  return { root, km: engine.knowledge, engine };
}

function errOf(e: unknown): WorkflowError {
  if (!isWorkflowError(e)) throw e;
  return e;
}

describe("KnowledgeManager: drafts (extension-validated, status forced)", () => {
  it("allocates the first id of the type and persists canonical JSON + Markdown", () => {
    const { km, root } = setup();
    const r = km.createDraft("constraint", baseConstraint({ id: undefined as never }), {});
    expect(r.id).toBe("CON-001");
    expect(r.statusForcedFrom).toBeNull();
    const jsonPath = path.join(root, ".factory", "knowledge", "constraints", "CON-001.json");
    const mdPath = path.join(root, ".factory", "generated", "knowledge", "constraints", "CON-001.md");
    expect(readFileSync(jsonPath, "utf8")).toBe(JSON.stringify({ ...baseConstraint(), status: "draft" }, null, 2) + "\n");
    expect(readFileSync(mdPath, "utf8")).toBe(renderKnowledgeMarkdown("constraint", r.doc));
  });

  it("forces any agent-supplied status to draft (never trusted)", () => {
    const { km } = setup();
    const r = km.createDraft("tech-decision", baseDecision({ status: "accepted" as never }), {});
    expect(r.id).toBe("ADR-001");
    expect(r.statusForcedFrom).toBe("accepted");
    expect(r.doc.status).toBe("draft");
    expect((km.getKnowledge("ADR-001").doc as { status: string }).status).toBe("draft");
  });

  it("allocates sequential ids across multiple records of different types", () => {
    const { km } = setup();
    expect(km.createDraft("constraint", baseConstraint({ id: undefined as never })).id).toBe("CON-001");
    expect(km.createDraft("convention", baseConvention({ id: undefined as never })).id).toBe("CVN-001");
    expect(km.createDraft("tech-decision", baseDecision({ id: undefined as never })).id).toBe("ADR-001");
    expect(km.createDraft("constraint", baseConstraint({ id: undefined as never, title: "second" })).id).toBe("CON-002");
  });

  it("rejects schema-invalid drafts and persists nothing", () => {
    const { km, root } = setup();
    const bad = baseConstraint();
    delete (bad as unknown as Record<string, unknown>).rule;
    let threw = false;
    try {
      km.createDraft("constraint", bad);
    } catch (e) {
      threw = true;
      const err = errOf(e);
      expect(err.code).toBe("INVALID_ARTIFACT");
      expect(err.message).toContain("FAILED schema validation");
      expect(err.message).toContain("rule");
    }
    expect(threw).toBe(true);
    expect(existsSync(path.join(root, ".factory", "knowledge", "constraints"))).toBe(false);
    const { items, errors } = km.listKnowledge();
    expect(items).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("rejects semantic violations (scope inconsistency) and persists nothing", () => {
    const { km } = setup();
    try {
      km.createDraft("constraint", baseConstraint({ scope: { level: "project", paths: ["src/**"] } }));
      throw new Error("should have thrown");
    } catch (e) {
      const err = errOf(e);
      expect(err.code).toBe("INVALID_ARTIFACT");
      expect(err.message).toContain("scope inconsistent");
    }
    expect(km.listKnowledge().items).toEqual([]);
  });

  it("rejects automated verification without a named validator", () => {
    const { km } = setup();
    try {
      km.createDraft("constraint", baseConstraint({ verification: { method: "automated", validator: null, instructions: "x" } }));
      throw new Error("should have thrown");
    } catch (e) {
      expect(errOf(e).message).toContain("verification.validator is null");
    }
  });

  it("rejects ADR supersedes pointing at a missing record", () => {
    const { km } = setup();
    try {
      km.createDraft("tech-decision", baseDecision({ supersedes: "ADR-009" }));
      throw new Error("should have thrown");
    } catch (e) {
      expect(errOf(e).message).toContain('supersedes references "ADR-009"');
    }
  });

  it("rejects ADR supersedes pointing at a draft (only accepted can be superseded)", () => {
    const { km } = setup();
    km.createDraft("tech-decision", baseDecision({ id: "ADR-000" }));
    try {
      km.createDraft("tech-decision", baseDecision({ supersedes: "ADR-000" }));
      throw new Error("should have thrown");
    } catch (e) {
      expect(errOf(e).message).toContain('status "draft"');
    }
  });

  it("rejects self-supersession and cross-type supersedes", () => {
    const { km } = setup();
    try {
      km.createDraft("tech-decision", baseDecision({ id: "ADR-005", supersedes: "ADR-005" }));
      throw new Error("should have thrown");
    } catch (e) {
      expect(errOf(e).message).toContain("must not reference the record itself");
    }
    km.createDraft("constraint", baseConstraint({ id: "CON-002" }));
    try {
      km.createDraft("tech-decision", baseDecision({ supersedes: "CON-002" }));
      throw new Error("should have thrown");
    } catch (e) {
      // the schema's ADR pattern on supersedes rejects this before the semantic layer
      expect(errOf(e).message).toContain("pattern at supersedes");
    }
  });

  it("rejects cross-type id collisions", () => {
    const { km } = setup();
    km.createDraft("convention", baseConvention({ id: "CVN-001" }));
    // A constraint cannot reuse CVN-001 either (wrong prefix → allocated), so test the direct same-string case:
    const r = km.createDraft("constraint", baseConstraint({ id: "CVN-001" } as never));
    // wrong prefix for the type is not accepted verbatim; a new CON id is allocated instead
    expect(r.id).toMatch(/^CON-\d{3}$/);
  });

  it("revises an existing draft (same id) but never overwrites an effective record", () => {
    const { km } = setup();
    const first = km.createDraft("constraint", baseConstraint({ id: "CON-001" }));
    expect(first.revised).toBe(false);
    const second = km.createDraft("constraint", baseConstraint({ id: "CON-001", title: "Updated title" }));
    expect(second.revised).toBe(true);
    expect(second.doc.title).toBe("Updated title");
    expect(km.listKnowledge().items).toHaveLength(1);

    km.approve("CON-001");
    expect(km.getKnowledge("CON-001").doc.status).toBe("approved");
    try {
      km.createDraft("constraint", baseConstraint({ id: "CON-001", title: "sneaky overwrite" }));
      throw new Error("should have thrown");
    } catch (e) {
      const err = errOf(e);
      expect(err.code).toBe("INVALID_ARTIFACT");
      expect(err.message).toContain("not \"draft\"");
    }
    expect((km.getKnowledge("CON-001").doc as { title: string }).title).toBe("Updated title");
  });

  it("rejects non-object documents with an actionable error", () => {
    const { km } = setup();
    try {
      km.createDraft("constraint", "just a string");
      throw new Error("should have thrown");
    } catch (e) {
      expect(errOf(e).message).toContain("not a JSON object");
    }
  });
});

describe("KnowledgeManager: lifecycle (human-gated transitions)", () => {
  it("constraint: draft -> proposed -> approved; then only deprecated allowed", () => {
    const { km } = setup();
    km.createDraft("constraint", baseConstraint());
    km.approve("CON-001"); // draft -> approved (proposed optional)
    expect(km.getKnowledge("CON-001").doc.status).toBe("approved");
    let threw = false;
    try {
      km.approve("CON-001"); // approved -> approved is not a transition
      throw new Error("should have thrown");
    } catch (e) {
      if (isWorkflowError(e) && e.code === "ILLEGAL_TRANSITION") threw = true;
      else throw e;
    }
    expect(threw).toBe(true);
    km.deprecate("CON-001");
    expect(km.getKnowledge("CON-001").doc.status).toBe("deprecated");
    try {
      km.deprecate("CON-001");
      throw new Error("should have thrown");
    } catch (e) {
      expect(errOf(e).code).toBe("ILLEGAL_TRANSITION");
    }
  });

  it("tech decision: draft -> accepted via approve", () => {
    const { km } = setup();
    km.createDraft("tech-decision", baseDecision());
    km.approve("ADR-001");
    expect(km.getKnowledge("ADR-001").doc.status).toBe("accepted");
  });

  it("approve refuses records with illegal current status (rejected is terminal)", () => {
    const { km } = setup();
    km.createDraft("tech-decision", baseDecision());
    km.rejectDecision("ADR-001", "not now");
    expect(km.getKnowledge("ADR-001").doc.status).toBe("rejected");
    try {
      km.approve("ADR-001");
      throw new Error("should have thrown");
    } catch (e) {
      const err = errOf(e);
      expect(err.code).toBe("ILLEGAL_TRANSITION");
      expect(err.message).toContain("rejected");
    }
  });

  it("reject is only valid for tech decisions and non-effective statuses", () => {
    const { km } = setup();
    km.createDraft("constraint", baseConstraint());
    try {
      km.rejectDecision("CON-001", "no");
      throw new Error("should have thrown");
    } catch (e) {
      expect(errOf(e).code).toBe("ILLEGAL_TRANSITION");
    }
  });

  it("tech decision deprecation = withdrawn (no deprecated state for ADRs)", () => {
    const { km } = setup();
    km.createDraft("tech-decision", baseDecision());
    km.approve("ADR-001");
    km.deprecate("ADR-001");
    expect(km.getKnowledge("ADR-001").doc.status).toBe("withdrawn");
  });

  it("supersession: approving a new ADR supersedes the old accepted one (both preserved)", () => {
    const { km, root } = setup();
    km.createDraft("tech-decision", baseDecision({ id: "ADR-000" }));
    km.approve("ADR-000");

    const second = km.createDraft(
      "tech-decision",
      baseDecision({ id: "ADR-001", title: "Migrate to PostgreSQL", supersedes: "ADR-000" }),
    );
    expect(second.id).toBe("ADR-001");
    const r = km.approve("ADR-001");
    expect(r.changes).toEqual([
      { id: "ADR-000", from: "accepted", to: "superseded" },
      { id: "ADR-001", from: "draft", to: "accepted" },
    ]);
    expect(km.getKnowledge("ADR-000").doc.status).toBe("superseded");
    expect(km.getKnowledge("ADR-001").doc.status).toBe("accepted");
    // Both records still exist on disk (superseded ≠ deleted).
    expect(existsSync(path.join(root, ".factory", "knowledge", "tech-decisions", "ADR-000.json"))).toBe(true);
    expect(existsSync(path.join(root, ".factory", "knowledge", "tech-decisions", "ADR-001.json"))).toBe(true);
    const show = km.getKnowledge("ADR-000");
    expect(show.supersededBy).toEqual(["ADR-001"]);
    // Markdown of the superseded record is also re-rendered with its new status.
    expect(readFileSync(path.join(root, ".factory", "generated", "knowledge", "tech-decisions", "ADR-000.md"), "utf8")).toContain("- **Status:** superseded");
  });

  it("superseding a non-accepted decision is refused (at draft time and again at approval time)", () => {
    const { km } = setup();
    km.createDraft("tech-decision", baseDecision({ id: "ADR-000" }));
    km.approve("ADR-000");
    km.deprecate("ADR-000"); // withdrawn
    try {
      km.createDraft("tech-decision", baseDecision({ id: "ADR-001", supersedes: "ADR-000" }));
      throw new Error("should have thrown");
    } catch (e) {
      const err = errOf(e);
      expect(err.code).toBe("INVALID_ARTIFACT");
      expect(err.message).toContain('status "withdrawn"');
    }

    // approve-time guard: a legal draft's target may become non-accepted before approval.
    const { km: km2 } = setup();
    km2.createDraft("tech-decision", baseDecision({ id: "ADR-000" }));
    km2.approve("ADR-000");
    km2.createDraft("tech-decision", baseDecision({ id: "ADR-001", supersedes: "ADR-000" }));
    km2.deprecate("ADR-000"); // target withdrawn after the draft was created
    try {
      km2.approve("ADR-001");
      throw new Error("should have thrown");
    } catch (e) {
      const err = errOf(e);
      expect(err.code).toBe("ILLEGAL_TRANSITION");
      expect(err.message).toContain('not "accepted"');
    }
    // the new decision was NOT accepted
    expect(km2.getKnowledge("ADR-001").doc.status).toBe("draft");
  });
});

describe("KnowledgeManager: listing / showing", () => {
  it("lists valid records and reports malformed ones separately", () => {
    const { km, root } = setup();
    km.createDraft("constraint", baseConstraint());
    km.createDraft("convention", baseConvention());
    km.createDraft("tech-decision", baseDecision());
    const dir = path.join(root, ".factory", "knowledge", "constraints");
    writeFileSync(path.join(dir, "CON-999.json"), "{ not json", "utf8");
    const { items, errors } = km.listKnowledge();
    expect(items).toHaveLength(3); // malformed file does not hide valid records
    expect(errors).toHaveLength(1);
    expect(errors[0]!.file).toContain("CON-999.json");
    expect(errors[0]!.error).toContain("malformed JSON");
    rmSync(path.join(dir, "CON-999.json"));
  });

  it("filters by type and status", () => {
    const { km } = setup();
    km.createDraft("constraint", baseConstraint());
    km.approve("CON-001");
    km.createDraft("convention", baseConvention());
    expect(km.listKnowledge({ type: "constraint" }).items).toHaveLength(1);
    expect(km.listKnowledge({ status: "approved" }).items).toHaveLength(1);
    expect(km.listKnowledge({ type: "convention", status: "approved" }).items).toHaveLength(0);
    expect(km.listKnowledge({ status: "draft" }).items).toHaveLength(1);
  });

  it("shows canonical JSON, markdown state, references and history", () => {
    const { km } = setup();
    km.createDraft("constraint", baseConstraint(), { changeId: "chg-1", requirementRef: "R3", source: "test" });
    const show = km.getKnowledge("CON-001");
    expect(show.doc).toEqual(expect.objectContaining({ id: "CON-001", status: "draft" }));
    expect(show.markdownState).toBe("ok");
    expect(show.jsonRel).toBe(".factory/knowledge/constraints/CON-001.json");
    expect(show.mdRel).toBe(".factory/generated/knowledge/constraints/CON-001.md");
    const kinds = show.events.map((e) => e.kind);
    expect(kinds).toContain("DRAFT_CREATED");
    const ev = show.events.find((e) => e.kind === "DRAFT_CREATED")!;
    expect(ev.changeId).toBe("chg-1");
    expect(ev.detail).toContain("req=R3");
  });

  it("unknown id → CHANGE_NOT_FOUND with an actionable message", () => {
    const { km } = setup();
    try {
      km.getKnowledge("CON-777");
      throw new Error("should have thrown");
    } catch (e) {
      const err = errOf(e);
      expect(err.code).toBe("CHANGE_NOT_FOUND");
      expect(err.message).toContain("/factory knowledge list");
    }
  });
});

describe("KnowledgeManager: validation", () => {
  it("validates a clean knowledge base as PASSED", () => {
    const { km } = setup();
    km.createDraft("constraint", baseConstraint());
    km.approve("CON-001");
    const report = km.validateKnowledge();
    expect(report.globalErrors).toEqual([]);
    expect(report.items.every((i) => i.errors.length === 0)).toBe(true);
    expect(report.items[0]!.markdownState).toBe("ok");
  });

  it("detects out-of-sync Markdown (manual edit of the projection)", () => {
    const { km, root } = setup();
    km.createDraft("constraint", baseConstraint());
    const md = path.join(root, ".factory", "generated", "knowledge", "constraints", "CON-001.md");
    writeFileSync(md, "hacked by hand\n", "utf8");
    const report = km.validateKnowledge("CON-001");
    expect(report.items[0]!.errors.join(" ")).toContain("out of sync");
    expect(report.items[0]!.markdownState).toBe("out-of-sync");
    // regenerate repairs it
    km.regenerateMarkdown("CON-001");
    const after = km.validateKnowledge("CON-001");
    expect(after.items[0]!.errors).toEqual([]);
    expect(after.items[0]!.markdownState).toBe("ok");
  });

  it("detects a malformed JSON file without modifying it", () => {
    const { km, root } = setup();
    km.createDraft("convention", baseConvention());
    const dir = path.join(root, ".factory", "knowledge", "constraints");
    mkdirSync(dir, { recursive: true });
    const bad = path.join(dir, "CON-500.json");
    writeFileSync(bad, "oops", "utf8");
    const report = km.validateKnowledge();
    const item = report.items.find((i) => i.file.includes("CON-500"))!;
    expect(item.errors[0]).toContain("malformed JSON");
    expect(readFileSync(bad, "utf8")).toBe("oops"); // untouched
    rmSync(bad);
  });

  it("detects duplicate ids across the base", () => {
    const { km, root } = setup();
    km.createDraft("constraint", baseConstraint({ id: "CON-001" }));
    const dir = path.join(root, ".factory", "knowledge", "constraints");
    writeFileSync(path.join(dir, "CON-002.json"), JSON.stringify(baseConstraint({ id: "CON-001" })), "utf8");
    const report = km.validateKnowledge();
    expect(report.globalErrors.join(" ")).toContain('duplicate id "CON-001"');
  });

  it("detects broken supersedes references in historical files (warning in read-only mode)", () => {
    const { km, root } = setup();
    const dir = path.join(root, ".factory", "knowledge", "tech-decisions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "ADR-001.json"), JSON.stringify(baseDecision({ supersedes: "ADR-009" })), "utf8");
    const report = km.validateKnowledge();
    const item = report.items.find((i) => i.file.includes("ADR-001"))!;
    expect(item.warnings.join(" ")).toContain('supersedes references "ADR-009"');
  });

  it("reports multiple accepted project-level decisions as a conflict warning", () => {
    const { km } = setup();
    km.createDraft("tech-decision", baseDecision({ id: "ADR-000" }));
    km.approve("ADR-000");
    km.createDraft("tech-decision", baseDecision({ id: "ADR-001" }));
    km.approve("ADR-001");
    const report = km.validateKnowledge();
    expect(report.globalWarnings.join(" ")).toContain("conflict");
  });

  it("validate of a single id only reports that record", () => {
    const { km } = setup();
    km.createDraft("constraint", baseConstraint());
    km.createDraft("convention", baseConvention());
    const report = km.validateKnowledge("CON-001");
    expect(report.items).toHaveLength(1);
    expect(report.items[0]!.file).toContain("CON-001.json");
  });

  it("refuses operations on invalid records with INVALID_ARTIFACT (previous state preserved)", () => {
    const { km, root } = setup();
    km.createDraft("constraint", baseConstraint());
    const json = path.join(root, ".factory", "knowledge", "constraints", "CON-001.json");
    const broken = JSON.parse(readFileSync(json, "utf8")) as Record<string, unknown>;
    broken.severity = "fatal"; // schema-invalid
    writeFileSync(json, JSON.stringify(broken), "utf8");
    try {
      km.approve("CON-001");
      throw new Error("should have thrown");
    } catch (e) {
      const err = errOf(e);
      expect(err.code).toBe("INVALID_ARTIFACT");
      expect(err.message).toContain("refused");
    }
    expect((JSON.parse(readFileSync(json, "utf8")) as { status: string }).status).toBe("draft"); // untouched
  });
});

describe("KnowledgeManager: failure paths and invariants", () => {
  it("reports PERSISTENCE_ERROR when the canonical store cannot be created", () => {
    const { km, root } = setup();
    // Make .factory/knowledge/constraints a regular FILE so directory creation fails.
    const kdir = path.join(root, ".factory", "knowledge");
    mkdirSync(kdir, { recursive: true });
    writeFileSync(path.join(kdir, "constraints"), "blocker", "utf8");
    try {
      km.createDraft("constraint", baseConstraint());
      throw new Error("should have thrown");
    } catch (e) {
      const err = errOf(e);
      expect(err.code).toBe("PERSISTENCE_ERROR");
    }
    rmSync(path.join(kdir, "constraints"));
  });

  it("flags an INCOMPLETE update when the Markdown projection cannot be written", () => {
    const { km, root } = setup();
    // Block the generated markdown directory.
    const gdir = path.join(root, ".factory", "generated", "knowledge");
    mkdirSync(gdir, { recursive: true });
    writeFileSync(path.join(gdir, "constraints"), "blocker", "utf8");
    try {
      km.createDraft("constraint", baseConstraint());
      throw new Error("should have thrown");
    } catch (e) {
      const err = errOf(e);
      expect(err.code).toBe("PERSISTENCE_ERROR");
      expect(err.message).toContain("INCOMPLETE");
      expect(err.message).toContain("/factory knowledge regenerate CON-001");
    }
    rmSync(path.join(gdir, "constraints"));
    // Canonical JSON exists, markdown missing → validate detects the problem,
    // and regenerate repairs it.
    const report = km.validateKnowledge("CON-001");
    expect(report.items[0]!.warnings.join(" ")).toContain("missing");
    km.regenerateMarkdown("CON-001");
    const after = km.validateKnowledge("CON-001");
    expect(after.items[0]!.errors).toEqual([]);
    expect(after.items[0]!.markdownState).toBe("ok");
  });

  it("audit log records the full history of a record", () => {
    const { km } = setup();
    km.createDraft("tech-decision", baseDecision({ id: "ADR-000" }));
    km.approve("ADR-000");
    km.createDraft("tech-decision", baseDecision({ id: "ADR-001", supersedes: "ADR-000" }));
    km.approve("ADR-001");
    km.deprecate("ADR-001");
    const show = km.getKnowledge("ADR-000");
    const kinds = show.events.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["DRAFT_CREATED", "KNOWLEDGE_ACCEPTED", "KNOWLEDGE_SUPERSEDED"]));
    const show2 = km.getKnowledge("ADR-001");
    expect(show2.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["DRAFT_CREATED", "KNOWLEDGE_ACCEPTED", "KNOWLEDGE_WITHDRAWN"]),
    );
  });

  it("never lets a draft enter with a non-draft status, even after multiple revisions", () => {
    const { km } = setup();
    km.createDraft("constraint", baseConstraint({ id: "CON-001", status: "approved" as never }));
    km.createDraft("constraint", baseConstraint({ id: "CON-001", status: "deprecated" as never, title: "v2" }));
    expect(km.getKnowledge("CON-001").doc.status).toBe("draft");
  });

  it("summaryForPrompt lists existing records (so the agent can reuse ids, not duplicate)", () => {
    const { km } = setup();
    km.createDraft("constraint", baseConstraint());
    km.approve("CON-001");
    const s = km.summaryForPrompt();
    expect(s).toContain("CON-001");
    expect(s).toContain("[approved]");
    expect(s).toContain("No credentials in logs");
  });
});
