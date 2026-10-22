import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { ErrorObject } from "ajv/dist/2020.js";
import { WorkflowError } from "../workflow/errors.ts";
import { extensionDir } from "../prompts.ts";
import { compileSchema2020, type CompileEntry } from "../artifacts/schema-validator.ts";
import { KNOWLEDGE_TYPES, type KnowledgeType } from "./types.ts";

/**
 * Project Knowledge JSON Schema validation (Draft 2020-12, pinned schemas in
 * <extension>/src/schemas/project-knowledge/).
 *
 * Same trust model as the artifact pipeline: the schemas are version-controlled
 * extension code; the LLM cannot swap, relax, or skip them. A missing or
 * uncompilable schema is a CONTRACT_ERROR (fail closed).
 *
 * NOTE: schema validity is STRUCTURAL only. Identifier uniqueness, lifecycle
 * authorization, reference integrity and semantic consistency are enforced
 * separately in manager.ts.
 */

const SCHEMA_FILE: Record<KnowledgeType, string> = {
  constraint: "constraint.schema.json",
  convention: "convention.schema.json",
  "tech-decision": "tech-decision.schema.json",
};

const compiled = new Map<KnowledgeType, CompileEntry>();

export function knowledgeSchemasDir(): string {
  return path.join(extensionDir(), "schemas", "project-knowledge");
}

function getKnowledgeSchema(type: KnowledgeType, dir?: string): CompileEntry {
  const hit = compiled.get(type);
  if (hit) return hit;
  const file = path.join(dir ?? knowledgeSchemasDir(), SCHEMA_FILE[type]);
  if (!existsSync(file)) {
    throw new WorkflowError(
      "CONTRACT_ERROR",
      `Knowledge schema file is missing: ${file}. Validation is refused — fix the installation, do not skip validation.`,
    );
  }
  let schema: unknown;
  try {
    schema = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new WorkflowError(
      "CONTRACT_ERROR",
      `Knowledge schema ${file} is not valid JSON: ${e instanceof Error ? e.message : e}. Validation is refused.`,
    );
  }
  const entry = compileSchema2020(schema, `knowledge schema ${file}`);
  compiled.set(type, entry);
  return entry;
}

/** Structurally validate a parsed document against the pinned type schema. */
export function knowledgeSchemaErrors(type: KnowledgeType, doc: unknown, dir?: string): string[] {
  const { fn } = getKnowledgeSchema(type, dir);
  const ok = fn(doc);
  if (ok) return [];
  const errors = fn.errors ?? [];
  const out: string[] = [];
  for (const e of errors) {
    const fieldPath = e.instancePath.replace(/^\//, "").replace(/\//g, ".") || "(root)";
    out.push(`${describeAjv(e)} at ${fieldPath}`);
  }
  return out;
}

function describeAjv(e: ErrorObject): string {
  switch (e.keyword) {
    case "required":
      return `missing required property "${(e.params as { missingProperty?: string }).missingProperty}"`;
    case "additionalProperties":
      return `unknown property "${(e.params as { additionalProperty?: string }).additionalProperty}"`;
    case "type":
      return `wrong type (expected ${(e.params as { type?: string }).type})`;
    case "enum":
      return `invalid value (must be one of ${(e.params as { allowedValues?: unknown[] }).allowedValues?.join(" | ")})`;
    case "const":
      return `invalid value (must be ${JSON.stringify((e.params as { allowedValue?: unknown }).allowedValue)})`;
    case "pattern":
      return `value does not match the required pattern`;
    case "minLength":
      return `value must not be empty`;
    default:
      return e.params && Object.keys(e.params).length > 0
        ? `${e.message ?? `schema violation (${e.keyword})`} ${JSON.stringify(e.params)}`
        : e.message ?? `schema violation (${e.keyword})`;
  }
}

/** Test hook: clear the compile cache. */
export function resetKnowledgeSchemaCache(): void {
  compiled.clear();
}

export const KNOWN_TYPES = KNOWLEDGE_TYPES;
