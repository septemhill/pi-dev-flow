import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { WorkflowError } from "../workflow/errors.ts";
import {
  PHASES,
  PHASE_ARTIFACT_FILE,
  REQUIREMENT_HISTORY_FILE,
  type Phase,
} from "../workflow/phases.ts";

/**
 * Artifact files live at <root>/.factory/changes/<change_id>/<file>.
 * Paths are always derived from the fixed phase->file map and a validated
 * change_id, so no user/LLM input can reach a path outside the change dir.
 */

export const FACTORY_DIR = ".factory";
export const CHANGES_DIR = "changes";

export const CHANGE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function factoryRoot(root: string): string {
  return path.join(root, FACTORY_DIR);
}

export function dbPath(root: string): string {
  return path.join(factoryRoot(root), "factory.db");
}

export function changeDir(root: string, changeId: string): string {
  if (!CHANGE_ID_RE.test(changeId)) {
    throw new WorkflowError("CHANGE_NOT_FOUND", `Invalid change id "${changeId}".`);
  }
  const dir = path.join(factoryRoot(root), CHANGES_DIR, changeId);
  assertInside(root, dir);
  return dir;
}

/** fileName must come from the fixed phase map (or the history file), never from free input. */
export function changeFile(root: string, changeId: string, phase: Phase, extraFile?: string): string {
  const dir = changeDir(root, changeId);
  const name = extraFile ?? PHASE_ARTIFACT_FILE[phase];
  const f = path.join(dir, name);
  assertInside(root, f);
  return f;
}

export function assertInside(root: string, p: string): void {
  const rel = path.relative(root, path.resolve(p));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new WorkflowError("PERSISTENCE_ERROR", `Refusing unsafe artifact path: ${p}`);
  }
}

export { REQUIREMENT_HISTORY_FILE };

export function sha256File(absPath: string): string {
  if (!existsSync(absPath)) {
    throw new WorkflowError("MISSING_ARTIFACT", `Artifact file is missing: ${absPath}`);
  }
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

/** sha256 of a string (UTF-8). */
export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Atomic write: temp file in the same directory, then rename over the target. */
export function writeArtifactAtomic(absPath: string, content: string): void {
  mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, absPath);
}

/** Append-only write for the requirement history (fs append is atomic enough for one process). */
export function appendFile(absPath: string, line: string): void {
  mkdirSync(path.dirname(absPath), { recursive: true });
  if (!existsSync(absPath)) {
    writeFileSync(absPath, `# Requirement History\n\n`, "utf8");
  }
  const fd = openSync(absPath, "a");
  try {
    // writeFileSync with fd append is simplest:
    writeFileSync(fd, line.endsWith("\n") ? line : line + "\n", "utf8");
  } finally {
    closeSync(fd);
  }
}

export function readFileOrNull(absPath: string): string | null {
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}
