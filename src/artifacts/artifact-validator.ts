import type { Phase } from "../workflow/phases.ts";
import { getContract } from "./artifact-registry.ts";
import type { ArtifactContract, ArtifactValidationResult, ValidationIssue } from "./artifact-types.ts";
import { parseArtifact } from "./markdown-parser.ts";
import { schemaIssues } from "./schema-validator.ts";
import { semanticIssues } from "./semantic-validator.ts";
import { traceabilityIssues } from "./traceability-validator.ts";
import type { PhaseContext } from "./validation-context.ts";
import { extractTraceGraph, type GraphInput } from "../traceability/items.ts";
import { assessCoverage } from "../traceability/coverage.ts";
import { coverageIssues } from "../traceability/issues.ts";
import { semanticReviewIssues } from "../traceability/semantic-review.ts";
import { buildWaiverMapFromContext } from "../traceability/waivers.ts";
import type { CoverageStage } from "../traceability/types.ts";

/**
 * The artifact validation pipeline — the single choke point through which
 * every phase artifact must pass before it can be recorded or approved.
 *
 *   1. STRUCTURE    — deterministic Markdown → JSON parse (markdown-parser)
 *   2. SCHEMA       — JSON Schema draft 2020-12 (Ajv, pinned in code)
 *   3. TRACEABILITY — upstream integrity + explicit relationship contract
 *                     (typed items + declared links) + stage coverage
 *   4. SEMANTICS    — phase rules + agreement with persisted extension state
 *
 * The traceability graph is DERIVED from the normalized, pinned artifacts
 * (documented: the content-hashed artifact files are the single source of
 * truth; nothing is stored separately). Coverage is computed per phase gate:
 * spec → requirement coverage, design → spec coverage, task-planning →
 * spec/design task coverage, verification → AC verification coverage.
 * Uncovered MANDATORY items block the gate (fail closed); explicit waivers
 * are applied on top and reported as WAIVED, never as success.
 */

export interface ValidateInput {
  contract: ArtifactContract;
  rawText: string;
  ctx: PhaseContext;
  /** sha256 of rawText (the candidate's hash). */
  artifactHash: string;
  /** Raw text of each upstream artifact (null = file missing). */
  upstreamRaw: Map<Phase, string | null>;
}

export function validateArtifact(input: ValidateInput): ArtifactValidationResult {
  const { contract, rawText, ctx, artifactHash, upstreamRaw } = input;

  // 1) Structure
  const parsed = parseArtifact(contract, rawText);
  const issues: ValidationIssue[] = [...parsed.issues];

  // 2) Schema (runs even when structure failed, so the model sees everything)
  issues.push(...schemaIssues(contract, parsed.doc));

  // 3) Traceability (parse upstreams, integrity + id resolution)
  const upstreamByPhase = new Map<Phase, ReturnType<typeof parseArtifact> | null>();
  for (const ref of ctx.upstream) {
    const text = upstreamRaw.get(ref.phase);
    if (text === null || text === undefined) {
      upstreamByPhase.set(ref.phase, null);
      continue;
    }
    try {
      upstreamByPhase.set(ref.phase, parseArtifact(getContract(ref.phase), text));
    } catch {
      upstreamByPhase.set(ref.phase, null);
    }
  }
  const trace = traceabilityIssues(contract, rawText, ctx.upstream, upstreamByPhase);
  issues.push(...trace.issues);

  // 3b) Traceability graph: explicit relationship contract + stage coverage
  const graphInputs: GraphInput[] = [];
  for (const ref of ctx.upstream) {
    const doc = upstreamByPhase.get(ref.phase);
    if (!doc || ref.legacy) continue; // legacy upstream: flagged, ids untrusted
    graphInputs.push({
      phase: ref.phase,
      artifactType: getContract(ref.phase).artifactType,
      revision: ref.revision,
      approved: true,
      parsed: doc,
    });
  }
  graphInputs.push({
    phase: contract.phase,
    artifactType: contract.artifactType,
    revision: ctx.expectedRevision,
    approved: false,
    parsed,
  });
  const { graph, issues: graphIssues } = extractTraceGraph(ctx.changeId, graphInputs);
  issues.push(...graphIssues);

  // Stage coverage for THIS phase's gate (fail closed for mandatory items).
  const gateStage = GATE_STAGE[contract.phase];
  if (gateStage) {
    const waivers = buildWaiverMapFromContext(ctx);
    const report = assessCoverage({ graph, waivers, stages: [gateStage] });
    issues.push(...coverageIssues(contract, report.assessments));
    if (contract.phase === "spec" || contract.phase === "design") {
      // Bounded semantic attestation, validated against the deterministic result.
      issues.push(...semanticReviewIssues(contract, parsed, graph, report.assessments));
    }
  }

  // 4) Semantics (phase rules + persisted-state agreement)
  issues.push(...semanticIssues(contract, parsed, ctx));

  // Deduplicate identical diagnostics across layers
  const seen = new Set<string>();
  const deduped = issues.filter((i) => {
    const key = `${i.code}|${i.relatedId ?? ""}|${i.fieldPath ?? ""}|${i.relatedArtifact ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) => (a.line ?? 10_000) - (b.line ?? 10_000) || a.code.localeCompare(b.code));

  return {
    valid: !deduped.some((i) => i.severity === "ERROR"),
    artifactType: contract.artifactType,
    contractVersion: contract.templateVersion,
    templateId: contract.templateId,
    templateVersion: contract.templateVersion,
    schemaId: contract.schemaId,
    schemaVersion: contract.schemaVersion,
    parserVersion: contract.parserVersion,
    artifactHash,
    expectedRevision: ctx.expectedRevision,
    issues: deduped,
    validatedAt: new Date().toISOString(),
  };
}

export function errorIssues(result: ArtifactValidationResult): ValidationIssue[] {
  return result.issues.filter((i) => i.severity === "ERROR");
}

/** Which coverage stage each phase gate enforces (implementation is enforced via task-evidence semantics). */
const GATE_STAGE: Partial<Record<Phase, CoverageStage>> = {
  spec: "requirement_to_spec",
  design: "spec_to_design",
  task_planning: "spec_to_tasks",
  verification: "acceptance_to_verification",
};

export function warningIssues(result: ArtifactValidationResult): ValidationIssue[] {
  return result.issues.filter((i) => i.severity !== "ERROR");
}

/** Human/model-readable rendering of a validation result (bounded length). */
export function formatValidationResult(result: ArtifactValidationResult, maxIssues = 25): string {
  const errors = errorIssues(result);
  const warnings = warningIssues(result);
  const lines: string[] = [];
  lines.push(
    `Validation ${result.valid ? "PASSED" : "FAILED"}: ${errors.length} error(s), ${warnings.length} warning(s)`,
  );
  lines.push(
    `Contract ${result.templateId}@${result.templateVersion} · schema ${result.schemaId} · parser ${result.parserVersion} · expected revision ${result.expectedRevision}`,
  );
  const byRule = new Map<string, ValidationIssue[]>();
  for (const i of result.issues) {
    const arr = byRule.get(i.rule ?? "structural") ?? [];
    arr.push(i);
    byRule.set(i.rule ?? "structural", arr);
  }
  let shown = 0;
  for (const rule of ["structural", "schema", "traceability", "semantic"]) {
    const list = byRule.get(rule) ?? [];
    if (list.length === 0) continue;
    const e = list.filter((i) => i.severity === "ERROR").length;
    lines.push(`[${rule.toUpperCase()}] ${e} error(s), ${list.length - e} warning(s)`);
    for (const i of list) {
      if (shown >= maxIssues) {
        lines.push(`  … ${result.issues.length - shown} more issue(s) — fix the listed ones, re-validate, and the rest will be shown if any remain.`);
        return lines.join("\n");
      }
      shown++;
      const where = [i.section, i.line ? `line ${i.line}` : null, i.fieldPath, i.relatedId].filter(Boolean).join(", ");
      lines.push(`  ${i.severity === "ERROR" ? "✖" : "⚠"} ${i.code}${where ? ` (${where})` : ""}: ${i.message}`);
      if (i.suggestedFix) lines.push(`     fix: ${i.suggestedFix}`);
    }
  }
  return lines.join("\n");
}
