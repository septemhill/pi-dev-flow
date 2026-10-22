import type { Phase } from "../workflow/phases.ts";
import type { ArtifactContract, ParsedDocument, ValidationIssue } from "./artifact-types.ts";
import { sha256 } from "./artifact-store.ts";
import type { PhaseContext, UpstreamArtifactRef } from "./validation-context.ts";
import type { UpstreamIds } from "./semantic-validator.ts";

/**
 * Cross-artifact TRACEABILITY validation layer.
 *
 *  - Upstream integrity: every approved upstream artifact must still exist on
 *    disk with exactly the recorded hash (tamper/staleness detection).
 *  - Id resolution: every REQ/FR/AC/DES id mentioned in the document (any
 *    section, including free-form text) must exist in the pinned upstream
 *    documents. Ids are compared numerically so "AC-1" resolves to "AC-001".
 *    An unresolvable mention is TRACE_UNKNOWN_ITEM (one report per id).
 */

export function buildUpstreamIds(
  parsedByPhase: Map<Phase, ParsedDocument | null>,
  excluded: ReadonlySet<Phase> = new Set(),
): UpstreamIds {
  const ids: UpstreamIds = { requirement: new Set(), functional: new Set(), acceptance: new Set(), design: new Set() };
  const add = (set: Set<string>, recs: Array<{ id: string }>) => {
    for (const r of recs) set.add(normalizeId(r.id));
  };
  const req = excluded.has("requirement") ? null : parsedByPhase.get("requirement");
  if (req) add(ids.requirement, req.sections["Requirements"]?.records ?? []);
  const spec = excluded.has("spec") ? null : parsedByPhase.get("spec");
  if (spec) {
    add(ids.acceptance, spec.sections["Acceptance Criteria"]?.records ?? []);
    add(ids.functional, spec.sections["Functional Requirements"]?.records ?? []);
  }
  const design = excluded.has("design") ? null : parsedByPhase.get("design");
  if (design) add(ids.design, design.sections["Design Decisions"]?.records ?? []);
  return ids;
}

/** Normalize "AC-1" → "AC-001" (3-digit zero padding) for robust comparison. */
export function normalizeId(id: string): string {
  const m = /^([A-Z]+)-(\d+)$/.exec(id.trim());
  if (!m) return id.trim().toUpperCase();
  return `${m[1]}-${m[2]!.padStart(3, "0")}`;
}

const SCAN_PREFIXES: Record<Phase, string[]> = {
  understanding: [],
  requirement: [],
  spec: ["REQ"],
  design: ["REQ", "FR", "AC"],
  task_planning: ["REQ", "FR", "AC", "DES"],
  implementation: ["REQ", "FR", "AC", "DES"],
  verification: ["REQ", "FR", "AC"],
};

const UPSTREAM_OF: Record<string, { phase: Phase; ids: keyof UpstreamIds }> = {
  REQ: { phase: "requirement", ids: "requirement" },
  FR: { phase: "spec", ids: "functional" },
  AC: { phase: "spec", ids: "acceptance" },
  DES: { phase: "design", ids: "design" },
};

export interface UpstreamScanResult {
  issues: ValidationIssue[];
  ids: UpstreamIds;
}

/**
 * Validate the candidate against its upstream documents.
 *
 * @param rawText the candidate's raw markdown (all mentions are scanned)
 * @param upstreamByPhase parsed upstream documents (null when the file is missing)
 */
export function traceabilityIssues(
  contract: ArtifactContract,
  rawText: string,
  upstream: UpstreamArtifactRef[],
  upstreamByPhase: Map<Phase, ParsedDocument | null>,
): UpstreamScanResult {
  const issues: ValidationIssue[] = [];
  const phase = contract.phase;

  // 1) Upstream integrity + legacy detection
  const legacyPhases = new Set<Phase>();
  for (const ref of upstream) {
    if (ref.legacy) legacyPhases.add(ref.phase);
    if (ref.text === null) {
      issues.push(
        mk(contract, "TRACE_UPSTREAM_MISSING", "ERROR",
          `The approved ${ref.phase} artifact (revision ${ref.revision}) is missing from disk; its recorded references cannot be verified. Validation is refused.`,
          { relatedArtifact: ref.phase }),
      );
      continue;
    }
    if (sha256(ref.text) !== ref.hash) {
      issues.push(
        mk(contract, "TRACE_UPSTREAM_MODIFIED", "ERROR",
          `The ${ref.phase} artifact on disk no longer matches the approved revision ${ref.revision} (recorded sha256 ${ref.hash.slice(0, 16)}…). Either the file was modified after approval, or it is stale.`,
          { relatedArtifact: ref.phase, suggestedFix: "Restore the approved file, or re-run the upstream phase to produce a new approved revision." }),
      );
    }
  }
  for (const ref of upstream) {
    if (!ref.legacy) continue;
    issues.push(
      mk(contract, "TRACE_UPSTREAM_LEGACY", "ERROR",
        `The approved ${ref.phase} artifact (revision ${ref.revision}) is LEGACY: it was recorded before template-driven validation existed, so its structure and ids are not guaranteed.`,
        { relatedArtifact: ref.phase, suggestedFix: `Re-run the "${ref.phase}" phase to produce a contract-conformant artifact and get it re-approved before proceeding.` }),
    );
  }

  const ids = buildUpstreamIds(upstreamByPhase, legacyPhases);

  // 2) Mention resolution (any section, including free-form text)
  const prefixes = SCAN_PREFIXES[phase];
  if (prefixes.length > 0) {
    const seen = new Map<string, number>(); // normalized id → first line
    const re = new RegExp(`\\b(${prefixes.join("|")})-(\\d+)\\b`, "g");
    const lines = rawText.split(/\r?\n/);
    let inFence = false;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li]!;
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      for (const m of line.matchAll(re)) {
        const norm = normalizeId(m[0]!);
        const prefix = m[1]!;
        const upstreamPhase = UPSTREAM_OF[prefix]!.phase;
        // A legacy upstream already produces a single actionable
        // TRACE_UPSTREAM_LEGACY error; do not flood the report with one
        // SEM_BAD_REF per mention of that phase.
        if (legacyPhases.has(upstreamPhase)) continue;
        const set = ids[UPSTREAM_OF[prefix]!.ids];
        if (set.has(norm)) continue;
        if (seen.has(norm)) continue;
        seen.set(norm, li + 1);
        issues.push(
          mk(contract, "TRACE_UNKNOWN_ITEM", "ERROR",
            `${norm} is referenced (line ${li + 1}) but does not exist in the approved ${upstreamPhase} artifact. References to upstream items must resolve.`,
            { relatedId: norm, relatedArtifact: upstreamPhase, line: li + 1, suggestedFix: `Cite an existing ${prefix}-### id from the approved ${upstreamPhase} artifact, or remove the reference.` }),
        );
      }
    }
  }

  return { issues, ids };
}

function mk(
  contract: ArtifactContract,
  code: string,
  severity: ValidationIssue["severity"],
  message: string,
  opts: { section?: string; relatedArtifact?: string; relatedId?: string; line?: number; suggestedFix?: string } = {},
): ValidationIssue {
  return {
    code,
    severity,
    message,
    artifactType: contract.artifactType,
    rule: "traceability",
    section: opts.section,
    line: opts.line,
    relatedArtifact: opts.relatedArtifact,
    relatedId: opts.relatedId,
    suggestedFix: opts.suggestedFix,
  };
}
