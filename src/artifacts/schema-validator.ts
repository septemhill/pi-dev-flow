import Ajv2020Default from "ajv/dist/2020.js";
import addFormatsDefault from "ajv-formats";
import type { ErrorObject } from "ajv/dist/2020.js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { WorkflowError } from "../workflow/errors.ts";
import { extensionDir } from "../prompts.ts";
import { SCHEMA_DRAFT } from "./artifact-registry.ts";
import type { ArtifactContract, ValidationIssue } from "./artifact-types.ts";

/**
 * JSON Schema validation layer.
 *
 * Schemas are trusted, version-controlled files (src/schemas/*.schema.json),
 * validated against draft 2020-12 with Ajv + ajv-formats (so `format`
 * keywords like "date-time" are actually enforced). The validator instance is
 * pinned in code; the LLM has no way to swap in a different schema.
 *
 * A missing/unreadable/uncompilable schema is an explicit CONTRACT_ERROR —
 * never a reason to skip validation (fail closed).
 */

/**
 * CJS-interop type bridges: ajv / ajv-formats ship CommonJS with ESM-style
 * d.ts. At runtime Node's ESM loader binds the default import to
 * module.exports (the Ajv class / the addFormats function); tsgo types them
 * as namespaces. Pin the exact runtime shape here so the rest of the module
 * can rely on it.
 */
type AjvValidate = ((data: unknown) => boolean) & { errors?: ErrorObject[] | null };
type Ajv2020Ctor = new (opts?: { allErrors?: boolean; strict?: boolean; validateFormats?: boolean }) => {
  compile(schema: unknown): AjvValidate;
};
const Ajv2020 = Ajv2020Default as unknown as Ajv2020Ctor;
const addFormats = addFormatsDefault as unknown as (ajv: unknown, opts?: { modes?: string[] }) => void;

interface CompileEntry {
  fn: AjvValidate;
  errors: ErrorObject[] | null;
}

const compiled = new Map<string, CompileEntry>();

export function schemasDir(): string {
  return path.join(extensionDir(), "schemas");
}

/** Load + compile the pinned schema for a contract. Throws CONTRACT_ERROR if it fails. */
export function getSchema(contract: ArtifactContract, dir?: string): CompileEntry {
  const cacheKey = contract.schemaId;
  const hit = compiled.get(cacheKey);
  if (hit) return hit;

  const file = path.join(dir ?? schemasDir(), contract.schemaFile);
  if (!existsSync(file)) {
    throw new WorkflowError(
      "CONTRACT_ERROR",
      `Artifact schema file is missing: ${file} (contract ${contract.schemaId}). Validation is refused — fix the installation, do not skip validation.`,
    );
  }
  let schema: unknown;
  try {
    schema = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new WorkflowError(
      "CONTRACT_ERROR",
      `Artifact schema ${file} is not valid JSON: ${e instanceof Error ? e.message : e}. Validation is refused.`,
    );
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
  addFormats(ajv, { modes: ["fast"] });
  if ((schema as { $schema?: string }).$schema !== SCHEMA_DRAFT) {
    throw new WorkflowError(
      "CONTRACT_ERROR",
      `Artifact schema ${file} declares draft ${(schema as { $schema?: string }).$schema ?? "none"}; the factory pins draft ${SCHEMA_DRAFT}. Validation is refused.`,
    );
  }
  let fn: (data: unknown) => boolean;
  try {
    fn = ajv.compile(schema) as (data: unknown) => boolean;
  } catch (e) {
    throw new WorkflowError(
      "CONTRACT_ERROR",
      `Artifact schema ${file} does not compile under draft ${SCHEMA_DRAFT}: ${e instanceof Error ? e.message : e}. Validation is refused.`,
    );
  }
  const entry: CompileEntry = { fn, errors: null };
  compiled.set(cacheKey, entry);
  return entry;
}

/** Validate a parsed document; converts Ajv errors into typed diagnostics. */
export function schemaIssues(contract: ArtifactContract, doc: Record<string, unknown>, dir?: string): ValidationIssue[] {
  const { fn } = getSchema(contract, dir);
  const ok = fn(doc);
  const errors = fn.errors ?? [];
  const issues: ValidationIssue[] = [];
  for (const e of errors) {
    const fieldPath = e.instancePath.replace(/^\//, "").replace(/\//g, ".") || "(root)";
    const kw = e.keyword;
    let message: string;
    let suggestedFix: string | undefined;
    switch (kw) {
      case "required":
        message = `Missing required property "${e.params.missingProperty}" at ${fieldPath}.`;
        suggestedFix = `Add "${e.params.missingProperty}" to the document (see the ${contract.templateId} template).`;
        break;
      case "additionalProperties":
        message = `Undocumented property "${e.params.additionalProperty}" at ${fieldPath}; the contract allows no extra fields.`;
        suggestedFix = "Remove the extra field or move its content into a documented section.";
        break;
      case "type":
        message = `Wrong type at ${fieldPath}: expected ${e.params.type}, got ${jsonType(doc, fieldPath)}.`;
        suggestedFix = "Check the section's syntax against the template.";
        break;
      case "enum":
        message = `Invalid value at ${fieldPath}: must be one of ${(e.params.allowedValues ?? []).join(" | ")}.`;
        suggestedFix = `Use one of: ${(e.params.allowedValues ?? []).join(", ")}.`;
        break;
      case "const":
        message = `Invalid value at ${fieldPath}: must be exactly ${JSON.stringify(e.params.allowedValue)}.`;
        suggestedFix = `Set it to ${JSON.stringify(e.params.allowedValue)}.`;
        break;
      case "format":
        message = `Invalid ${e.params.format} format at ${fieldPath} ("${jsonValue(doc, fieldPath)}").`;
        suggestedFix = `Use a proper ${e.params.format} value (e.g. 2026-01-01T12:00:00.000Z).`;
        break;
      case "pattern":
        message = `Value at ${fieldPath} does not match the required format (${e.params.pattern}).`;
        suggestedFix = patternFix(fieldPath);
        break;
      case "minItems":
        message = `Section at ${fieldPath} must contain at least ${e.params.limit} item(s).`;
        suggestedFix = "Add the missing item(s).";
        break;
      case "maxItems":
        message = `Section at ${fieldPath} may contain at most ${e.params.limit} item(s).`;
        suggestedFix = "Split the section; keep artifacts small.";
        break;
      case "minLength":
        message = `Value at ${fieldPath} is empty but must not be.`;
        suggestedFix = "Fill in the value, or use the documented not-applicable marker if allowed.";
        break;
      case "minimum":
        message = `Value at ${fieldPath} must be >= ${e.params.limit}.`;
        break;
      case "if":
        message = `Conditional constraint failed at ${fieldPath}: when status is PASS or FAIL, "Actual" and "Evidence" are required.`;
        suggestedFix = "Record the actual result and the key evidence output.";
        break;
      default:
        message = e.message ?? `Schema violation (${kw}) at ${fieldPath}.`;
    }
    issues.push({
      code: `SCHEMA_${kw.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`,
      severity: "ERROR",
      message,
      artifactType: contract.artifactType,
      rule: "schema",
      fieldPath,
      section: sectionForProp(contract, fieldPath),
      suggestedFix,
    });
  }
  return issues;
}

function sectionForProp(contract: ArtifactContract, fieldPath: string): string | undefined {
  const top = fieldPath.split(".")[0]!;
  const spec = contract.sectionOrder.find((s) => s.prop === top);
  return spec?.name;
}

function jsonType(doc: unknown, fieldPath: string): string {
  const v = lookup(doc, fieldPath);
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function jsonValue(doc: unknown, fieldPath: string): string {
  const v = lookup(doc, fieldPath);
  return typeof v === "string" ? v.slice(0, 60) : JSON.stringify(v);
}

function lookup(doc: unknown, fieldPath: string): unknown {
  let v: unknown = doc;
  for (const part of fieldPath.split(".")) {
    if (v && typeof v === "object" && part in (v as Record<string, unknown>)) {
      v = (v as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return v;
}

function patternFix(fieldPath: string): string {
  if (fieldPath.endsWith(".contractVersion")) return "Use the contract version exactly as given in the template (e.g. 1.0.0).";
  if (fieldPath.endsWith(".changeId")) return "Use the change id from the phase prompt, exactly as given.";
  if (/\.id$/.test(fieldPath)) return "Use the stable id format from the template (e.g. REQ-001, AC-001, TASK-001) with zero-padded numbers.";
  if (fieldPath.includes("upstreamReferences") || fieldPath.includes("approvedTaskPlan") || fieldPath.includes("pinnedRevisions"))
    return "Copy the exact revision number / full sha256 from the phase prompt or /factory status.";
  return "Follow the documented format for this field.";
}

/** Test-only: clear the compile cache (schemas are pinned; no runtime re-registration). */
export function resetSchemaCache(): void {
  compiled.clear();
}
