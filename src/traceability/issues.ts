import type { ArtifactContract, ValidationIssue } from "../artifacts/artifact-types.ts";
import type { CoverageAssessment } from "./types.ts";
import { STAGE_FIX, STAGE_LABEL, STAGE_MISSING_CODE } from "./coverage.ts";

/**
 * Map deterministic coverage assessments to gate diagnostics.
 *
 *  - UNCOVERED mandatory item      → ERROR   (blocks the phase gate)
 *  - UNCOVERED non-mandatory item  → WARNING (MUST vs SHOULD/COULD requirements)
 *  - FAILED item                   → ERROR   TRACE_REQUIRED_CHECK_FAILED
 *  - WAIVED item                   → INFO    (auditable exception, never success)
 *  - UNCOVERED with humanPending   → WARNING (explicitly unresolved, human decides at approval)
 *
 * The mapping is pure: same assessments → same issues, always.
 */
export function coverageIssues(contract: ArtifactContract, assessments: CoverageAssessment[]): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const push = (a: CoverageAssessment, severity: ValidationIssue["severity"], code: string, message: string) => {
    out.push({
      code,
      severity,
      message,
      artifactType: contract.artifactType,
      rule: "traceability",
      relatedId: a.item.id,
      suggestedFix: STAGE_FIX[a.stage],
    });
    void message;
  };
  for (const a of assessments) {
    const label = STAGE_LABEL[a.stage];
    if (a.status === "UNCOVERED") {
      const code = STAGE_MISSING_CODE[a.stage];
      if (a.humanPending) {
        push(a, "WARNING", code, `Coverage stage ${label}: ${a.item.id} has no passing verification evidence — ${a.reasons[0]}. The item remains explicitly unresolved until a human adjudicates.`);
      } else if (a.mandatory) {
        push(a, "ERROR", code, `Coverage stage ${label}: mandatory item ${a.item.id} is UNCOVERED — ${a.reasons[0]}.`);
      } else {
        push(a, "WARNING", code, `Coverage stage ${label}: optional item ${a.item.id} is uncovered — ${a.reasons[0]}. Non-blocking, but it stays visible in /factory traceability.`);
      }
    } else if (a.status === "FAILED") {
      push(a, "ERROR", "TRACE_REQUIRED_CHECK_FAILED", `Coverage stage ${label}: ${a.item.id} FAILED verification — ${a.reasons[0]}. A required failure cannot count as successful verification.`);
    } else if (a.status === "WAIVED") {
      out.push({
        code: "TRACE_WAIVER_ACTIVE",
        severity: "INFO",
        message: `Coverage stage ${label}: ${a.item.id} is WAIVED (${a.waiverId}) — ${a.reasons[a.reasons.length - 1]}. A waiver is an auditable exception, not verification success.`,
        artifactType: contract.artifactType,
        rule: "traceability",
        relatedId: a.item.id,
      });
    }
  }
  return out;
}
