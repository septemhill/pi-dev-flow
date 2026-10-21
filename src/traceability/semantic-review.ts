import type { ArtifactContract, ParsedDocument, ValidationIssue } from "../artifacts/artifact-types.ts";
import { normalizeId } from "../artifacts/traceability-validator.ts";
import { RELATION_CONTRACT } from "./relations.ts";
import { STAGE_LABEL } from "./coverage.ts";
import type { CoverageAssessment, TraceGraph } from "./types.ts";

/**
 * Bounded semantic coverage review — validation side.
 *
 * The model may attest (in the Coverage Review section) that a declared
 * relationship actually covers the upstream obligation. The extension then
 * validates every attestation:
 *
 *  - TRACE_REVIEW_UNKNOWN_ID    — Upstream/Downstream does not exist in the graph
 *  - TRACE_INVALID_RELATION     — the attested pair has no declared link
 *  - TRACE_REVIEW_STAGE_MISMATCH— the record's Stage is not the stage the
 *                                 linked relationship contributes to
 *  - TRACE_REVIEW_INCONSISTENT  — PARTIAL/NEEDS_REVIEW without naming the
 *                                 missing obligations
 *  - TRACE_SEMANTIC_CONFLICT    — record claims COVERED while deterministic
 *                                 coverage reports the item UNCOVERED/FAILED.
 *                                 Deterministic findings ALWAYS win (ERROR).
 *  - TRACE_SEMANTIC_REVIEW      — record says PARTIAL/NEEDS_REVIEW (WARNING:
 *                                 surfaced at approval for human attention,
 *                                 never auto-rejected, never promoted).
 *
 * No retries happen here: the artifact gate simply reports. The executor may
 * fix the artifact once (bounded, see prompts), but an inconclusive attestation
 * never becomes a pass.
 */

export function semanticReviewIssues(
  contract: ArtifactContract,
  parsed: ParsedDocument,
  graph: TraceGraph,
  stageAssessments: CoverageAssessment[],
): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const records = parsed.sections["Coverage Review"]?.records;
  if (!records) return out; // "None identified" — nothing attested, deterministic checks only

  const knownIds = new Set(graph.items.map((it) => it.id));
  const linkKey = (sourceId: string, targetId: string) => `${sourceId}->${targetId}`;
  const declaredLinks = new Set(graph.links.map((l) => linkKey(l.source.id, l.target.id)));

  for (const rec of records) {
    const id = rec.id;
    const upstream = normalizeId(rec.fields["Upstream"] ?? "");
    const downstream = normalizeId(rec.fields["Downstream"] ?? "");
    const stage = rec.fields["Stage"];
    const status = rec.fields["Status"];
    const missing = rec.fields["Missing Obligations"] ?? "";
    const line = rec.fieldLines["Upstream"] ?? rec.line;

    if (!/^SR-\d{3,}$/.test(id)) continue; // structural layer reports malformed ids

    if (upstream === "" || !knownIds.has(upstream)) {
      out.push(mk(contract, "TRACE_REVIEW_UNKNOWN_ID", "ERROR",
        `Coverage review ${id}: Upstream "${rec.fields["Upstream"] ?? ""}" is not an item in the current traceability graph.`,
        { relatedId: id, line, suggestedFix: "Cite an existing item id (see /factory traceability)." }));
    }
    if (downstream === "" || !knownIds.has(downstream)) {
      out.push(mk(contract, "TRACE_REVIEW_UNKNOWN_ID", "ERROR",
        `Coverage review ${id}: Downstream "${rec.fields["Downstream"] ?? ""}" is not an item in the current traceability graph.`,
        { relatedId: id, line, suggestedFix: "Cite an existing item id (see /factory traceability)." }));
    }
    if (upstream === "" || downstream === "") continue;

    const linkExists = declaredLinks.has(linkKey(downstream, upstream));
    if (!linkExists) {
      out.push(mk(contract, "TRACE_INVALID_RELATION", "ERROR",
        `Coverage review ${id} attests that ${downstream} covers ${upstream}, but no such reference exists in the References field. An attestation cannot declare a relationship the artifact does not.`,
        { relatedId: id, line, suggestedFix: `Add ${upstream} to the References of ${downstream}, or remove this attestation.` }));
      continue;
    }

    const link = graph.links.find((l) => l.source.id === downstream && l.target.id === upstream)!;
    const coversStage = RELATION_CONTRACT[link.relation]?.coversStage;
    if (coversStage === null) {
      out.push(mk(contract, "TRACE_REVIEW_STAGE_MISMATCH", "ERROR",
        `Coverage review ${id}: a ${link.relation} relationship carries no coverage obligation and cannot be attested.`,
        { relatedId: id, line }));
      continue;
    }
    if (stage !== coversStage) {
      out.push(mk(contract, "TRACE_REVIEW_STAGE_MISMATCH", "ERROR",
        `Coverage review ${id}: Stage "${stage}" does not match the coverage stage of the linked relationship (${STAGE_LABEL[coversStage]}).`,
        { relatedId: id, line, suggestedFix: `Set Stage: ${coversStage}.` }));
    }

    const isNA = /^none identified$/i.test(missing.trim()) || /^not applicable/i.test(missing.trim());
    if (status !== "COVERED" && isNA) {
      out.push(mk(contract, "TRACE_REVIEW_INCONSISTENT", "ERROR",
        `Coverage review ${id} has Status "${status}" but names no missing obligations.`,
        { relatedId: id, line, suggestedFix: 'Describe the missing obligations, or use Status: COVERED when truly complete.' }));
    }

    const det = stageAssessments.find((a) => a.item.id === upstream && a.stage === stage);
    if (status === "COVERED" && det && (det.status === "UNCOVERED" || det.status === "FAILED")) {
      out.push(mk(contract, "TRACE_SEMANTIC_CONFLICT", "ERROR",
        `Coverage review ${id} claims ${upstream} is semantically COVERED, but deterministic coverage reports ${det.status} (${det.reasons[0]}). Deterministic findings take precedence — the reference problem must be fixed, not talked over.`,
        { relatedId: id, line }));
    } else if (status === "COVERED" && stageAssessments.some((a) => a.item.id === upstream) && !det) {
      out.push(mk(contract, "TRACE_REVIEW_STAGE_MISMATCH", "ERROR",
        `Coverage review ${id}: item ${upstream} is not part of the assessed stage "${stage}".`,
        { relatedId: id, line }));
    } else if (status === "PARTIAL" || status === "NEEDS_REVIEW") {
      out.push(mk(contract, "TRACE_SEMANTIC_REVIEW", "WARNING",
        `Coverage review ${id}: ${upstream} is flagged ${status} — ${missing}. A human must review this at approval; it will not be auto-rejected nor auto-accepted.`,
        { relatedId: id, line }));
    }
  }
  return out;
}

function mk(contract: ArtifactContract, code: string, severity: ValidationIssue["severity"], message: string, opts: { relatedId?: string; line?: number; suggestedFix?: string } = {}): ValidationIssue {
  return {
    code,
    severity,
    message,
    artifactType: contract.artifactType,
    rule: "traceability",
    relatedId: opts.relatedId,
    line: opts.line,
    suggestedFix: opts.suggestedFix,
  };
}
