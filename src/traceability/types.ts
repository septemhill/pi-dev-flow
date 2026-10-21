import type { Phase } from "../workflow/phases.ts";

/**
 * Traceability model (end-to-end coverage).
 *
 * Canonical direction: a LINK always points DOWNSTREAM → UPSTREAM.
 * `source` is the item that declares the relationship (the later-phase item),
 * `target` is the upstream obligation it addresses. Example:
 *   FR-001 --SATISFIES--> REQ-001  (FR-001 is the source, REQ-001 the target).
 *
 * A link proves only that a relationship was DECLARED in the pinned artifact
 * text. Coverage, evidence and verdicts are computed separately by
 * coverage.ts and are never read from model claims.
 *
 * Item identity is composite: (changeId, artifactType, artifactRevision,
 * itemId). Within one change, id prefixes are unique per item type
 * (REQ/FR/AC/DES/TASK/CHK), so "REQ-001" is unambiguous inside a change.
 * Cross-change references are NOT supported and never resolve.
 */

export type TraceItemType =
  | "requirement"
  | "functional_requirement"
  | "acceptance_criterion"
  | "design_decision"
  | "task"
  | "implementation_result"
  | "verification_check";

export type TraceRelationType =
  | "SATISFIES"
  | "DERIVED_FROM"
  | "REALIZES"
  | "IMPLEMENTS"
  | "VERIFIES"
  | "DEPENDS_ON";

/** One item of a validated artifact revision. */
export interface TraceItem {
  changeId: string;
  /** Parsed-artifact type: requirement | spec | design | task-plan | implementation-report | verification-report. */
  artifactType: string;
  /** The artifact phase this item was extracted from. */
  phase: Phase;
  artifactRevision: number;
  /** true when the item comes from a recorded (approved) artifact; false for the current candidate. */
  approved: boolean;
  itemType: TraceItemType;
  /** Stable id, e.g. REQ-001 (zero-padded). */
  id: string;
  title: string;
  /** Requirement priority (MUST | SHOULD | COULD) — only for requirements. */
  priority?: string;
  /** Declared status (task result status, check report status). */
  status?: string;
  /** Recorded evidence (task evidence, check evidence). */
  evidence?: string;
  required?: boolean;
  /** 1-based line of the item's record heading. */
  line?: number;
}

/** One declared relationship, downstream (source) → upstream (target). */
export interface TraceLink {
  relation: TraceRelationType;
  source: Pick<TraceItem, "itemType" | "id">;
  target: Pick<TraceItem, "itemType" | "id">;
  /** Where the link was declared (candidate document line, when known). */
  line?: number;
}

/** A traceability graph derived from normalized, validated artifact data. */
export interface TraceGraph {
  changeId: string;
  items: TraceItem[];
  links: TraceLink[];
}

export type CoverageStage =
  | "requirement_to_spec"
  | "spec_to_design"
  | "spec_to_tasks"
  | "tasks_to_implementation"
  | "acceptance_to_verification";

export const COVERAGE_STAGES: CoverageStage[] = [
  "requirement_to_spec",
  "spec_to_design",
  "spec_to_tasks",
  "tasks_to_implementation",
  "acceptance_to_verification",
];

/**
 * Stage-specific coverage state.
 *  UNCOVERED  — no valid downstream relationship/evidence satisfies the rule.
 *  PARTIAL    — some obligations addressed, a mandatory one remains.
 *  COVERED    — all required obligations at this stage are addressed.
 *  VERIFIED   — an executed check with a PASS result satisfies the contract.
 *  FAILED     — required verification evidence demonstrates failure.
 *  WAIVED     — an explicitly authorized, recorded exception applies.
 */
export type CoverageStatus = "UNCOVERED" | "PARTIAL" | "COVERED" | "VERIFIED" | "FAILED" | "WAIVED";

export interface CoverageAssessment {
  stage: CoverageStage;
  item: Pick<TraceItem, "itemType" | "id">;
  /** Whether this item is mandatory for the stage (blocks the gate when uncovered). */
  mandatory: boolean;
  status: CoverageStatus;
  /** The valid links used to reach this status. */
  links: TraceLink[];
  /** Human-readable reasons (one per finding), persisted with the report. */
  reasons: string[];
  /** Uncovered while a NEEDS_HUMAN check is the only evidence — not a hard block. */
  humanPending?: boolean;
  /** The waiver record id when status is WAIVED. */
  waiverId?: string;
}

export interface StageSummary {
  stage: CoverageStage;
  /** Denominator: all eligible upstream items (waived items stay in the denominator, reported separately). */
  total: number;
  covered: number;
  partial: number;
  uncovered: number;
  failed: number;
  waived: number;
  /** 0..100, or null when the denominator is 0. */
  percent: number | null;
  uncoveredIds: string[];
  partialIds: string[];
  failedIds: string[];
  waivedIds: string[];
}

export interface CoverageReport {
  changeId: string;
  assessments: CoverageAssessment[];
  stages: Record<CoverageStage, StageSummary>;
}

/** An auditable exception that exempts one item at one stage. */
export interface WaiverInfo {
  id: string;
  changeId: string;
  itemId: string;
  stage: CoverageStage;
  rationale: string;
  created_at: string;
  status: "ACTIVE" | "REVOKED";
  /** Upstream artifact revisions pinned when the waiver was granted. */
  pinnedRevisions: Partial<Record<Phase, number>>;
}

/** Waiver + whether it still applies (pinned revisions unchanged). */
export interface ActiveWaiver {
  waiver: WaiverInfo;
  /** Names of phases whose recorded revision no longer matches the pin. */
  staleBecause: Phase[];
}
