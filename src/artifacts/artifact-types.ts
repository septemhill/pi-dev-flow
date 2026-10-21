import type { Phase } from "../workflow/phases.ts";

/**
 * Artifact contract types.
 *
 * The contract is owned by the EXTENSION, not by the LLM: a contract pins the
 * template, the JSON Schema, the parser version, the required sections and
 * their order, and the semantic validation profile. Nothing exposed to the
 * model can change any of that at runtime.
 */

export type ValidationSeverity = "ERROR" | "WARNING" | "INFO";

/** One actionable validation finding. `code` is stable — tests and tooling rely on it. */
export interface ValidationIssue {
  code: string;
  severity: ValidationSeverity;
  message: string;
  artifactType: string;
  /** Canonical section name (e.g. "Acceptance Criteria") when applicable. */
  section?: string;
  /** Dotted path into the parsed document (e.g. "metadata.revision"). */
  fieldPath?: string;
  /** 1-based line number in the Markdown source when known. */
  line?: number;
  /** Which rule class produced the issue: structural | schema | semantic | traceability. */
  rule?: "structural" | "schema" | "semantic" | "traceability";
  /** Upstream phase the issue relates to (cross-artifact findings). */
  relatedArtifact?: string;
  /** Upstream id involved (e.g. "AC-001"). */
  relatedId?: string;
  /** How to fix it. */
  suggestedFix?: string;
}

/**
 * The result of validating one candidate artifact against one pinned contract.
 * `valid` is COMPUTED from the issues (no ERROR ⇒ valid); it is never taken
 * from model output.
 */
export interface ArtifactValidationResult {
  valid: boolean;
  artifactType: string;
  contractVersion: string;
  templateId: string;
  templateVersion: string;
  schemaId: string;
  schemaVersion: string;
  parserVersion: string;
  artifactHash: string;
  expectedRevision: number;
  issues: ValidationIssue[];
  validatedAt: string;
}

export type SectionKind = "text" | "list" | "records" | "keyvalue";

/** A field inside a record (### REQ-001: … → "- Field: value" bullets). */
export interface RecordFieldSpec {
  /** Markdown bullet key, e.g. "Priority". */
  name: string;
  /** JSON property, e.g. "priority". */
  prop: string;
  required: boolean;
}

/** A key inside a keyvalue section ("- Key: value" bullets). */
export interface KeyValueSpec {
  key: string;
  prop: string;
  required: boolean;
}

/**
 * One top-level `## ` section of an artifact. `name` is the exact Markdown
 * heading text; `prop` is the parsed JSON property. The mapping lives in
 * trusted code — property names are never derived from model-generated
 * headings.
 */
export interface SectionSpec {
  name: string;
  prop: string;
  kind: SectionKind;
  required: boolean;
  /** A documented marker ("None identified", "Not applicable", …) satisfies the section. */
  allowsNA: boolean;
  recordIdPrefix?: string;
  recordFields?: readonly RecordFieldSpec[];
  kvKeys?: readonly KeyValueSpec[];
  /** Record body (description) may be empty. */
  allowEmptyDescription?: boolean;
}

/**
 * The immutable contract for one phase's artifact. Versioned; a new version
 * is a new contract — artifacts validated under version X are never
 * reinterpreted as having passed version Y.
 */
export interface ArtifactContract {
  artifactType: string;
  phase: Phase;
  /** Required H1 of the document, e.g. "Requirement". */
  title: string;
  templateId: string;
  templateVersion: string;
  schemaId: string;
  schemaVersion: string;
  parserVersion: string;
  templateFile: string;
  schemaFile: string;
  /** Required section headings (subset of sectionOrder, same relative order). */
  requiredSections: readonly string[];
  /** Every allowed `## ` heading in the exact legal order (required + optional). */
  sectionOrder: readonly SectionSpec[];
  validationProfile: string;
}

export interface ParsedRecord {
  id: string;
  title: string;
  /** Field name → value (Markdown bullet keys, e.g. "Priority"). */
  fields: Record<string, string>;
  /** Field name → 1-based line of the bullet. */
  fieldLines: Record<string, number>;
  /** Free-form body after the field bullets. */
  description: string;
  /** 1-based line of the record's `### ` heading. */
  line: number;
}

export interface ParsedSection {
  spec: SectionSpec;
  line: number;
  /** Body was only HTML comments (untouched template placeholder). */
  placeholder: boolean;
  /** Body satisfied a documented not-applicable marker. */
  na: boolean;
  text?: string;
  items?: string[];
  kv?: Record<string, string>;
  records?: ParsedRecord[];
}

/**
 * Deterministic parse of one Markdown artifact against one contract.
 * `doc` is the schema-bound JSON representation; `issues` are structural
 * findings (headings, records, metadata syntax). Parsing never throws on a
 * malformed document — it reports and degrades best-effort.
 */
export interface ParsedDocument {
  title: string | null;
  titleLine: number | null;
  /** Canonical section name → parsed section. */
  sections: Record<string, ParsedSection>;
  /** Schema-bound JSON (partial when structural errors exist). */
  doc: Record<string, unknown>;
  issues: ValidationIssue[];
}
