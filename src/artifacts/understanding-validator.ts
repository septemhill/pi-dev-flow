import { getContract } from "./artifact-registry.ts";
import type { ArtifactContract, ArtifactValidationResult, ValidationIssue } from "./artifact-types.ts";
import type { PhaseContext } from "./validation-context.ts";
import { schemaIssues } from "./schema-validator.ts";
import {
  renderUnderstandingMarkdown,
  validateUnderstandingMarkdown,
  understandingIds,
  type UnderstandingDoc,
} from "./understanding-renderer.ts";

/**
 * The understanding-phase validation pipeline. Unlike the other phases
 * (Markdown-first: parse Markdown → JSON → validate), understanding is
 * JSON-first:
 *
 *   1. STRUCTURE    — the candidate must parse as JSON (malformed ⇒ rejected)
 *   2. SCHEMA       — Draft 2020-12 schema (Ajv, pinned in code, fail closed)
 *   3. SEMANTICS    — change-id / source-prompt agreement, revision, status,
 *                     duplicate local ids, reference integrity
 *   4. PROJECTION   — understanding.md must exist, equal the deterministic
 *                     re-render of the validated JSON, and carry the fixed
 *                     heading structure with every local id rendered
 *
 * Only a candidate that passes every layer may be persisted/recorded. The
 * Markdown checks run after (and only when) the JSON itself is valid: a
 * broken JSON must not produce a spurious Markdown error list.
 */

export interface UnderstandingValidateInput {
  /** Candidate canonical JSON text (what will be / was persisted). */
  rawText: string;
  /** Current understanding.md on disk (null = missing). */
  mdText: string | null;
  /**
   * True when the Markdown projection MUST exist and match (phase completion,
   * /factory validate). False while validating a JSON candidate before the
   * extension renders the Markdown (submit pipeline).
   */
  requireMarkdown: boolean;
  /** sha256 of rawText (the candidate's hash). */
  artifactHash: string;
  ctx: PhaseContext;
}

export const UNDERSTANDING_PHASE = "understanding" as const;

function mk(contract: ArtifactContract, code: string, message: string, rule: ValidationIssue["rule"], extra: Partial<ValidationIssue> = {}): ValidationIssue {
  return { code, severity: "ERROR", message, artifactType: contract.artifactType, rule, ...extra };
}

function parseUnderstandingJson(rawText: string): { doc?: UnderstandingDoc; error?: string } {
  let value: unknown;
  try {
    value = JSON.parse(rawText);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "the top-level JSON value must be an object" };
  }
  return { doc: value as UnderstandingDoc };
}

export function validateUnderstandingArtifact(input: UnderstandingValidateInput): ArtifactValidationResult {
  const contract = getContract(UNDERSTANDING_PHASE);
  const { rawText, mdText, requireMarkdown, artifactHash, ctx } = input;
  const issues: ValidationIssue[] = [];

  // 1) Structure: must be valid JSON
  const { doc, error } = parseUnderstandingJson(rawText);
  if (doc === undefined || error) {
    issues.push(
      mk(contract, "STRUCTURE_INVALID_JSON", `understanding.json is not valid JSON: ${error}. Malformed JSON is rejected; resubmit well-formed JSON via factory_understanding_submit.`, "structural"),
    );
    return result(contract, ctx, artifactHash, issues);
  }

  // 2) Schema
  const schemaProblems = schemaIssues(contract, doc as unknown as Record<string, unknown>);
  issues.push(...schemaProblems);

  // 3) Semantics (only meaningful when the document at least has a metadata block)
  const meta = (doc as unknown as { metadata?: Record<string, unknown> }).metadata;
  if (meta && typeof meta === "object") {
    const changeId = typeof meta.changeId === "string" ? meta.changeId : "";
    if (changeId !== ctx.changeId) {
      issues.push(
        mk(contract, "SEM_CHANGE_ID_MISMATCH", `metadata.changeId is "${changeId}" but the active change is "${ctx.changeId}".`, "semantic", {
          fieldPath: "metadata.changeId",
          suggestedFix: `Set metadata.changeId to "${ctx.changeId}".`,
        }),
      );
    }
    const revision = typeof meta.revision === "number" ? meta.revision : NaN;
    if (revision !== ctx.expectedRevision) {
      issues.push(
        mk(contract, "SEM_REVISION_MISMATCH", `metadata.revision is ${String(meta.revision)} but the expected revision for this candidate is ${ctx.expectedRevision}.`, "semantic", {
          fieldPath: "metadata.revision",
          suggestedFix: `Set metadata.revision to ${ctx.expectedRevision}.`,
        }),
      );
    }
    if (meta.status !== "complete") {
      issues.push(
        mk(contract, "SEM_STATUS_NOT_COMPLETE", `metadata.status is ${JSON.stringify(meta.status)}; a submitted understanding candidate must be "complete" (drafts are not accepted as phase artifacts).`, "semantic", {
          fieldPath: "metadata.status",
          suggestedFix: 'Set metadata.status to "complete" when the interpretation is ready for review.',
        }),
      );
    }
  }
  if (typeof doc.sourcePrompt === "string" && typeof ctx.changeDescription === "string") {
    if (doc.sourcePrompt.trim() !== ctx.changeDescription.trim()) {
      issues.push(
        mk(contract, "SEM_SOURCE_PROMPT_MISMATCH", "sourcePrompt does not match the change description recorded by the extension; the original prompt must be quoted VERBATIM.", "semantic", {
          fieldPath: "sourcePrompt",
          suggestedFix: "The canonical understanding.json must keep the recorded change description verbatim; restore the file (or regenerate the projection) and re-validate.",
        }),
      );
    }
  }

  // 3b) Duplicate local ids
  const all: Array<{ id: unknown; where: string }> = [];
  for (const e of doc.explicitInformation ?? []) all.push({ id: e.id, where: "explicitInformation" });
  for (const i of doc.inferences ?? []) all.push({ id: i.id, where: "inferences" });
  for (const q of doc.ambiguities ?? []) all.push({ id: q.id, where: "ambiguities" });
  for (const c of doc.candidateRequirements ?? []) all.push({ id: c.id, where: "candidateRequirements" });
  const seen = new Map<string, string>();
  for (const { id, where } of all) {
    if (typeof id !== "string") continue;
    const first = seen.get(id);
    if (first) {
      issues.push(
        mk(contract, "SEM_DUPLICATE_ID", `Duplicate local id ${id} (declared in ${first} and ${where}); every entry needs a unique stable id.`, "semantic", {
          fieldPath: where,
          relatedId: id,
        }),
      );
    } else {
      seen.set(id, where);
    }
  }

  // 3c) Reference integrity: candidates must cite declared entries or "prompt"
  const declared = new Set([...seen.keys()]);
  for (const c of doc.candidateRequirements ?? []) {
    for (const ref of c.sourceRefs ?? []) {
      if (ref === "prompt") continue;
      if (!declared.has(ref)) {
        issues.push(
          mk(contract, "SEM_BAD_REF", `Candidate ${String(c.id)} cites "${ref}", which is not declared in this document (known ids: ${[...declared].join(", ") || "none"}).`, "semantic", {
            fieldPath: "candidateRequirements.sourceRefs",
            relatedId: String(c.id),
            suggestedFix: `Cite an existing EXP/INF/Q id from this document, or use "prompt".`,
          }),
        );
      }
    }
    for (const ref of c.relatedIds ?? []) {
      if (!declared.has(ref)) {
        issues.push(
          mk(contract, "SEM_BAD_REF", `Candidate ${String(c.id)} lists related id "${ref}", which is not declared in this document.`, "semantic", {
            fieldPath: "candidateRequirements.relatedIds",
            relatedId: String(c.id),
          }),
        );
      }
    }
  }

  // 4) Projection: Markdown must match the deterministic re-render.
  //    Only when the JSON itself is valid, so a broken JSON does not add
  //    spurious Markdown noise.
  if (issues.every((i) => i.rule !== "schema" && i.rule !== "structural" && i.rule !== "semantic")) {
    if (mdText === null && requireMarkdown) {
      issues.push(
        mk(contract, "UNDERSTANDING_MD_MISSING", "understanding.md is missing; the canonical JSON is valid but its deterministic Markdown projection was never persisted. Regenerate it (extension re-render) before completing the phase.", "structural"),
      );
    } else if (mdText !== null) {
      const rendered = renderUnderstandingMarkdown(doc);
      if (mdText !== rendered) {
        issues.push(
          mk(contract, "UNDERSTANDING_MD_STALE", "understanding.md does not match the deterministic re-render of understanding.json; the Markdown is out of sync with the canonical JSON.", "structural", {
            suggestedFix: "Do not hand-edit understanding.md — regenerate it from the validated JSON via the extension.",
          }),
        );
      }
      issues.push(...validateUnderstandingMarkdown(mdText, contract.artifactType));
      for (const id of understandingIds(doc)) {
        if (!mdText.includes(id)) {
          issues.push(
            mk(contract, "UNDERSTANDING_MD_ID_MISSING", `Local id ${id} is present in the JSON but not rendered in understanding.md.`, "structural", { relatedId: id }),
          );
        }
      }
    }
  }

  issues.sort((a, b) => (a.line ?? 10_000) - (b.line ?? 10_000) || a.code.localeCompare(b.code));
  return result(contract, ctx, artifactHash, issues);
}

function result(
  contract: ArtifactContract,
  ctx: PhaseContext,
  artifactHash: string,
  issues: ValidationIssue[],
): ArtifactValidationResult {
  return {
    valid: !issues.some((i) => i.severity === "ERROR"),
    artifactType: contract.artifactType,
    contractVersion: contract.templateVersion,
    templateId: contract.templateId,
    templateVersion: contract.templateVersion,
    schemaId: contract.schemaId,
    schemaVersion: contract.schemaVersion,
    parserVersion: contract.parserVersion,
    artifactHash,
    expectedRevision: ctx.expectedRevision,
    issues,
    validatedAt: new Date().toISOString(),
  };
}
