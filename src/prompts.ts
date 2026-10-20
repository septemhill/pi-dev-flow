import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Phase } from "./workflow/phases.ts";

/**
 * Phase instruction templates live in <extension root>/prompts/*.md.
 * They are pure instructions: they never control workflow state, which the
 * extension enforces in code.
 */
const TEMPLATE_FILE: Record<Phase, string> = {
  requirement: "requirement.md",
  spec: "spec.md",
  design: "design.md",
  task_planning: "task-planning.md",
  implementation: "implementation.md",
  verification: "verification.md",
};

export function extensionDir(): string {
  // jiti (pi runtime) provides __dirname; native Node ESM does not.
  try {
    if (typeof __dirname !== "undefined") return __dirname;
  } catch {
    /* fall through */
  }
  return path.dirname(fileURLToPath(import.meta.url));
}

export function phaseTemplate(phase: Phase, promptsDir?: string): string {
  const dir = promptsDir ?? path.join(extensionDir(), "..", "prompts");
  const file = path.join(dir, TEMPLATE_FILE[phase]);
  if (!existsSync(file)) {
    throw new Error(`Missing phase prompt template: ${file}`);
  }
  return readFileSync(file, "utf8");
}
