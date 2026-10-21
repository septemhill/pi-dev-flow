import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { WorkflowError } from "../workflow/errors.ts";
import { extensionDir } from "../prompts.ts";
import type { ArtifactContract } from "./artifact-types.ts";

/**
 * Template loading. Templates are trusted, versioned files in src/templates/
 * referenced by the pinned contract. A missing template is an explicit
 * CONTRACT_ERROR — never a silent skip (fail closed).
 */

export function templatesDir(): string {
  return path.join(extensionDir(), "templates");
}

export function templatePath(contract: ArtifactContract, dir?: string): string {
  return path.join(dir ?? templatesDir(), contract.templateFile);
}

export function loadTemplate(contract: ArtifactContract, dir?: string): string {
  const file = templatePath(contract, dir);
  if (!existsSync(file)) {
    throw new WorkflowError(
      "CONTRACT_ERROR",
      `Template file is missing: ${file} (contract ${contract.templateId}@${contract.templateVersion}). The phase prompt cannot be built and validation is refused — fix the installation, do not skip validation.`,
    );
  }
  return readFileSync(file, "utf8");
}
