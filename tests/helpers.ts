import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FactoryEngine } from "../src/engine.ts";
import {
  PHASE_ARTIFACT_FILE,
  REQUIREMENT_HISTORY_FILE,
  REQUIRED_SECTIONS,
  type Phase,
} from "../src/workflow/phases.ts";
import { WorkflowError } from "../src/workflow/errors.ts";

export function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "pi-factory-test-"));
}

export function cleanup(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function changeFile(root: string, changeId: string, name = ""): string {
  return path.join(root, ".factory", "changes", changeId, name);
}

export function writeChangeFile(root: string, changeId: string, name: string, content: string): void {
  const p = changeFile(root, changeId, name);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
}

/** Artifact body that satisfies the required-section contract for a phase. */
export function makeArtifact(phase: Phase): string {
  const lines = [`# ${phase} artifact`, ""];
  for (const s of REQUIRED_SECTIONS[phase]) lines.push(s, "- placeholder content", "");
  return lines.join("\n");
}

/** Drive the engine through every phase up to (excluding) `target`. */
export function advanceTo(root: string, engine: FactoryEngine, target: Phase): void {
  const order: Phase[] = ["requirement", "spec", "design", "task_planning", "implementation", "verification"];
  for (const phase of order) {
    if (phase === target) return;
    completePhase(root, engine, phase);
  }
}

/** Satisfy the current phase's contract and complete it (no approval yet). */
export function completePhase(root: string, engine: FactoryEngine, phase: Phase): void {
  const w = engine.requireActive();
  if (w.current_phase !== phase) throw new Error(`expected phase ${phase}, got ${w.current_phase}`);
  engine.beginCurrentPhase();

  switch (phase) {
    case "requirement": {
      engine.appendRequirement("The tool must do the thing.");
      writeChangeFile(root, w.change_id, PHASE_ARTIFACT_FILE.requirement, makeArtifact("requirement"));
      break;
    }
    case "spec": {
      writeChangeFile(root, w.change_id, PHASE_ARTIFACT_FILE.spec, makeArtifact("spec"));
      break;
    }
    case "design": {
      writeChangeFile(root, w.change_id, PHASE_ARTIFACT_FILE.design, makeArtifact("design"));
      break;
    }
    case "task_planning": {
      engine.setTaskPlan(
        [
          { title: "Add feature", scope: "src/feature.ts only", references: "AC-1, D1", verification: "npm test passes" },
          { title: "Wire it up", scope: "src/index.ts only", references: "AC-1", verification: "manual smoke test" },
        ],
        false,
      );
      writeChangeFile(root, w.change_id, PHASE_ARTIFACT_FILE.task_planning, makeArtifact("task_planning"));
      break;
    }
    case "implementation": {
      const tasks = engine.listTasks();
      for (const t of tasks) {
        engine.updateTask(t.seq, "IN_PROGRESS", "");
        engine.updateTask(t.seq, "DONE", `Ran: node --test — ${t.seq} tests passed`);
      }
      writeChangeFile(root, w.change_id, PHASE_ARTIFACT_FILE.implementation, makeArtifact("implementation"));
      break;
    }
    case "verification": {
      engine.recordCheck("unit-tests", true, "PASSED", "npm test → 12 pass");
      engine.recordCheck("typecheck", true, "PASSED", "tsc --noEmit clean");
      writeChangeFile(root, w.change_id, PHASE_ARTIFACT_FILE.verification, makeArtifact("verification"));
      break;
    }
  }
  engine.completeCurrentPhase();
  engine.approve("");
}

/** Run a full six-phase workflow; returns the final (COMPLETED) workflow record. */
export function runFullWorkflow(root: string, engine: FactoryEngine) {
  const changeId = engine.requireActive().change_id;
  for (const phase of ["requirement", "spec", "design", "task_planning", "implementation", "verification"] as Phase[]) {
    completePhase(root, engine, phase);
  }
  return engine.getWorkflow(changeId)!;
}

export function assertThrowsWorkflowError(fn: () => unknown, code?: string): WorkflowError {
  try {
    fn();
  } catch (e) {
    if (e instanceof WorkflowError) {
      if (code && e.code !== code) {
        throw new Error(`expected WorkflowError code ${code}, got ${e.code}: ${e.message}`);
      }
      return e;
    }
    throw new Error(`expected WorkflowError, got: ${e instanceof Error ? e.stack : String(e)}`);
  }
  throw new Error(`expected a WorkflowError but the call succeeded`);
}

export function newEngine(root: string): FactoryEngine {
  return new FactoryEngine(root);
}

export type Engine = FactoryEngine;

export function rawArtifactText(root: string, changeId: string, name: string): string {
  return readFileSync(changeFile(root, changeId, name), "utf8");
}

export function artifactExists(root: string, changeId: string, name: string): boolean {
  return existsSync(changeFile(root, changeId, name));
}
