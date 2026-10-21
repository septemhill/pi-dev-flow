import type { Phase } from "../workflow/phases.ts";
import type { CheckRecord, TaskRecord, WaiverRecord } from "../workflow/state.ts";

/**
 * Everything the validator needs to know about the rest of the workflow in
 * order to validate one candidate artifact. Built by the engine from
 * PERSISTED state only (database rows + recorded artifact files) — never
 * from conversational memory or model claims.
 */

export interface UpstreamArtifactRef {
  phase: Phase;
  /** Revision recorded in the artifact registry for this phase. */
  revision: number;
  /** sha256 recorded in the artifact registry for this phase. */
  hash: string;
  /** Current on-disk text (null when the file is missing). */
  text: string | null;
  /**
   * True when this upstream artifact was recorded before template-driven
   * validation existed (no pinned contract). Its structure is not guaranteed,
   * so its ids cannot be trusted for resolution and the phase must be
   * re-run to regenerate a conforming, re-approved artifact.
   */
  legacy?: boolean;
}

export interface PhaseContext {
  changeId: string;
  /** Revision the engine would record if this candidate passes (latest+1, or 1). */
  expectedRevision: number;
  /** Raw entry lines of requirements-history.md ("- [ts] (R1) statement"). */
  requirementHistory: string[];
  /** Numeric history entry ids present (R1 → 1). */
  historyIds: number[];
  tasks: TaskRecord[];
  checks: CheckRecord[];
  /** Approved upstream artifacts, in phase order. */
  upstream: UpstreamArtifactRef[];
  /** Coverage waivers recorded for this change (ACTIVE and REVOKED; the engine computes staleness). */
  waivers: WaiverRecord[];
}

/** Map persisted check status → report status (documented contract). */
export function reportStatusForCheck(status: CheckRecord["status"]): "PASS" | "FAIL" | "SKIPPED" | "NEEDS_HUMAN" {
  switch (status) {
    case "PASSED":
      return "PASS";
    case "FAILED":
      return "FAIL";
    case "SKIPPED":
      return "SKIPPED";
    case "MANUAL":
      return "NEEDS_HUMAN";
  }
}
