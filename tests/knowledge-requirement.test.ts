import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRoot, newEngine, cleanup, completePhase, advanceTo } from "./helpers.ts";
import { PHASES } from "../src/workflow/phases.ts";
import { buildPhasePrompt } from "../src/execution/phase-executor.ts";
import { baseConstraint, baseConvention, baseDecision } from "./knowledge-fixtures.ts";
import { buildKnowledgeDiscoverySection, buildKnowledgeWorkOrder } from "../src/knowledge/prompt.ts";

let tmp: string | null = null;
afterEach(() => {
  if (tmp) {
    cleanup(tmp);
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

function setup() {
  const root = makeRoot();
  tmp = root;
  const engine = newEngine(root);
  return { root, engine };
}

describe("requirement phase: knowledge discovery is wired into the work order", () => {
  it("the requirement work order carries the knowledge discovery section with existing records", () => {
    const { root, engine } = setup();
    const w = engine.initChange("Test change");
    engine.beginCurrentPhase(); // requirement RUNNING
    const km = engine.knowledge;
    km.createDraft("constraint", baseConstraint());
    km.approve("CON-001");

    const s = engine.snapshot();
    const prompt = buildPhasePrompt({
      workflow: s.workflow!,
      artifacts: s.artifacts,
      rejection: s.lastRejection,
      tasks: s.tasks,
      checks: s.checks,
      restarted: false,
      repoRoot: root,
      projectKnowledge: km.summaryForPrompt() || "(none yet)",
    });
    expect(prompt).toContain("## Project Knowledge discovery");
    expect(prompt).toContain("CON-001");
    expect(prompt).toContain("[approved]");
    expect(prompt).toContain("factory_knowledge_draft");
    expect(prompt).toContain(`"${w.change_id}"`);
    expect(prompt).toContain("Never silently change the project baseline");
  });

  it("the section is absent from non-requirement phases (design, etc.)", () => {
    const { root, engine } = setup();
    engine.initChange("Test change");
    advanceTo(root, engine, "design");
    const s = engine.snapshot();
    expect(s.workflow!.current_phase).toBe("design");
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
    expect(prompt).not.toContain("## Project Knowledge discovery");
  });

  it("the six-phase order is unchanged", () => {
    expect(PHASES).toEqual(["requirement", "spec", "design", "task_planning", "implementation", "verification"]);
  });
});

describe("requirement phase: knowledge stays out of the workflow", () => {
  it("creating knowledge during requirement does not move the workflow", () => {
    const { engine } = setup();
    const w = engine.initChange("Test change");
    engine.beginCurrentPhase();
    expect(engine.requireActive().status).toBe("RUNNING");

    const km = engine.knowledge;
    km.createDraft("constraint", baseConstraint(), { changeId: w.change_id, requirementRef: "R3", source: "test" });
    km.createDraft("convention", baseConvention(), { changeId: w.change_id, requirementRef: "R4", source: "test" });

    expect(engine.requireActive().current_phase).toBe("requirement");
    expect(engine.requireActive().status).toBe("RUNNING");
    // The draft is not "approved" just by being created.
    expect(km.getKnowledge("CON-001").doc.status).toBe("draft");
    expect(km.getKnowledge("CVN-001").doc.status).toBe("draft");
  });

  it("ordinary requirements do not create knowledge records", () => {
    const { root, engine } = setup();
    engine.initChange("Test change");
    completePhase(root, engine, "requirement"); // plain requirement artifact, no knowledge
    expect(engine.knowledge.listKnowledge().items).toEqual([]);
    // ...and the workflow moved on exactly as before.
    expect(engine.requireActive().current_phase).toBe("spec");
  });

  it("multiple candidates are stored as independent, individually approvable drafts", () => {
    const { engine } = setup();
    engine.initChange("Test change");
    const km = engine.knowledge;
    km.createDraft("constraint", baseConstraint({ id: undefined as never }), { requirementRef: "R3" });
    km.createDraft("tech-decision", baseDecision({ id: undefined as never }), { requirementRef: "R5" });
    const items = km.listKnowledge().items;
    expect(items.map((i) => i.id).sort()).toEqual(["ADR-001", "CON-001"]);
    // Approving one does not affect the other.
    km.approve("CON-001");
    expect(km.getKnowledge("CON-001").doc.status).toBe("approved");
    expect(km.getKnowledge("ADR-001").doc.status).toBe("draft");
    km.approve("ADR-001");
    expect(km.getKnowledge("ADR-001").doc.status).toBe("accepted");
  });

  it("traceability: drafts carry the originating change id and requirement ref", () => {
    const { engine } = setup();
    const w = engine.initChange("Test change");
    const km = engine.knowledge;
    km.createDraft("constraint", baseConstraint(), { changeId: w.change_id, requirementRef: "R3", source: "agent-tool" });
    const show = km.getKnowledge("CON-001");
    const ev = show.events.find((e) => e.kind === "DRAFT_CREATED")!;
    expect(ev.changeId).toBe(w.change_id);
    expect(ev.detail).toContain("req=R3");
  });

  it("candidate notes format for the artifact Open Questions", () => {
    const section = buildKnowledgeDiscoverySection("(none yet)", "chg-1");
    expect(section).toContain("[knowledge-candidate]");
    expect(section).toContain("drafted as");
    expect(section).toContain("pending approval (source R<n>)");
  });
});

describe("work order content: guardrails against self-approval and duplicates", () => {
  it("tells the agent it cannot set status and the gate is human", () => {
    const p = buildKnowledgeWorkOrder({ requestedType: "constraint", description: "x", existingKnowledge: "(none yet)", changeContext: null, repoRoot: "/tmp" });
    expect(p).toContain('forced to "draft"');
    expect(p).toContain("only becomes effective after they run: `/factory knowledge approve <id>`");
    expect(p).toContain("You do NOT control workflow state");
  });

  it("auto classification is explicitly NOT automatic approval", () => {
    const p = buildKnowledgeWorkOrder({ requestedType: "auto", description: "x", existingKnowledge: "(none yet)", changeContext: null, repoRoot: "/tmp" });
    expect(p).toContain("AUTOMATIC CLASSIFICATION, NOT automatic approval");
    expect(p).toContain("do not manufacture all three");
  });

  it("duplicate avoidance is required against the existing list", () => {
    const p = buildKnowledgeWorkOrder({ requestedType: "constraint", description: "x", existingKnowledge: "- CON-001 [approved] (project) Old rule — .factory/knowledge/constraints/CON-001.json", changeContext: null, repoRoot: "/tmp" });
    expect(p).toContain("do NOT create a duplicate");
    expect(p).toContain("CON-001");
  });

  it("mentions that the approval gate is a human command", () => {
    const p = buildKnowledgeWorkOrder({ requestedType: "tech-decision", description: "x", existingKnowledge: "(none yet)", changeContext: null, repoRoot: "/tmp" });
    expect(p).toContain("/factory knowledge approve <id>");
  });
});
