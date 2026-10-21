import type { CoverageStage, TraceItemType, TraceRelationType } from "./types.ts";

/**
 * The traceability RELATIONSHIP CONTRACT — trusted extension code.
 *
 * Canonical direction: source = downstream item (declares the link),
 * target = upstream obligation (the id cited in the link's source field).
 *
 * Only (source itemType, target id-prefix) pairs listed here are legal.
 * Anything else is a TRACE_INVALID_RELATION error — the LLM may not invent
 * relationship types or endpoints.
 */

export interface RelationSpec {
  relation: TraceRelationType;
  sources: TraceItemType[];
  /** Allowed target prefixes → their item type. */
  targets: Record<string, TraceItemType>;
  /** Which coverage stage this relation contributes to (null = provenance/dependency only). */
  coversStage: CoverageStage | null;
  /** Whether the declaring item must carry a rationale (checked by its record fields). */
  rationaleRequired: boolean;
  /** Whether evidence is required beyond the declared link. */
  evidenceRequired: boolean;
  /** Cross-change references are never allowed for any relation. */
  crossChangeAllowed: false;
  /** Targets must exist in APPROVED (pinned) upstream revisions. */
  targetsMustBeApproved: boolean;
  description: string;
}

export const RELATION_CONTRACT: Record<TraceRelationType, RelationSpec> = {
  SATISFIES: {
    relation: "SATISFIES",
    sources: ["functional_requirement", "acceptance_criterion"],
    targets: { REQ: "requirement" },
    coversStage: "requirement_to_spec",
    rationaleRequired: false,
    evidenceRequired: false,
    crossChangeAllowed: false,
    targetsMustBeApproved: true,
    description: "A specification item (FR) or acceptance criterion (AC) addresses a requirement.",
  },
  DERIVED_FROM: {
    relation: "DERIVED_FROM",
    sources: ["acceptance_criterion"],
    targets: { FR: "functional_requirement" },
    coversStage: null,
    rationaleRequired: false,
    evidenceRequired: false,
    crossChangeAllowed: false,
    targetsMustBeApproved: true,
    description: "An acceptance criterion is derived from a functional requirement (spec-internal provenance).",
  },
  REALIZES: {
    relation: "REALIZES",
    sources: ["design_decision"],
    targets: { FR: "functional_requirement", AC: "acceptance_criterion" },
    coversStage: "spec_to_design",
    rationaleRequired: true,
    evidenceRequired: false,
    crossChangeAllowed: false,
    targetsMustBeApproved: true,
    description: "A design decision realizes a specified behavior (FR) or acceptance criterion (AC).",
  },
  IMPLEMENTS: {
    relation: "IMPLEMENTS",
    sources: ["task"],
    targets: {
      REQ: "requirement",
      FR: "functional_requirement",
      AC: "acceptance_criterion",
      DES: "design_decision",
    },
    coversStage: "spec_to_tasks",
    rationaleRequired: false,
    evidenceRequired: false,
    crossChangeAllowed: false,
    targetsMustBeApproved: true,
    description: "A task implements an upstream obligation (requirement, FR, AC, or design decision).",
  },
  VERIFIES: {
    relation: "VERIFIES",
    sources: ["verification_check"],
    targets: {
      REQ: "requirement",
      FR: "functional_requirement",
      AC: "acceptance_criterion",
    },
    coversStage: "acceptance_to_verification",
    rationaleRequired: false,
    evidenceRequired: true,
    crossChangeAllowed: false,
    targetsMustBeApproved: true,
    description: "A verification check validates an obligation. The check's executed output is the evidence.",
  },
  DEPENDS_ON: {
    relation: "DEPENDS_ON",
    sources: ["task"],
    targets: { TASK: "task" },
    coversStage: null,
    rationaleRequired: false,
    evidenceRequired: false,
    crossChangeAllowed: false,
    // Tasks may only depend on tasks in the SAME plan (same artifact revision).
    targetsMustBeApproved: false,
    description: "A task depends on an earlier task in the same plan.",
  },
};

/** id prefix → item type (global within a change). */
export const PREFIX_ITEM_TYPE: Record<string, TraceItemType> = {
  REQ: "requirement",
  FR: "functional_requirement",
  AC: "acceptance_criterion",
  DES: "design_decision",
  TASK: "task",
  CHK: "verification_check",
};

export function prefixOfId(id: string): string {
  const m = /^([A-Z]+)-/.exec(id);
  return m ? m[1]! : "";
}

/** The relation a (source, target) pair must have, or null when the pair is not allowed. */
export function relationForPair(source: TraceItemType, targetPrefix: string): TraceRelationType | null {
  for (const spec of Object.values(RELATION_CONTRACT)) {
    if (!spec.sources.includes(source)) continue;
    if (targetPrefix in spec.targets) return spec.relation;
  }
  return null;
}

/** All relations a source item type may declare (for diagnostics). */
export function allowedTargetsFor(source: TraceItemType): string[] {
  const out: string[] = [];
  for (const spec of Object.values(RELATION_CONTRACT)) {
    if (spec.sources.includes(source)) {
      for (const p of Object.keys(spec.targets)) out.push(`${p} (${spec.relation})`);
    }
  }
  return out.sort();
}

/** The coverage stage a declared pair belongs to (null = does not contribute to coverage). */
export function stageForPair(source: TraceItemType, targetPrefix: string): CoverageStage | null {
  const relation = relationForPair(source, targetPrefix);
  if (!relation) return null;
  return RELATION_CONTRACT[relation].coversStage;
}

/**
 * Which item types a record field may legally cite, per (artifactType, field).
 * This is the document-level projection of RELATION_CONTRACT:
 *  - FR References    → SATISFIES:        REQ
 *  - AC References    → SATISFIES/DERIVED_FROM: REQ, FR
 *  - DES References   → REALIZES:         FR, AC
 *  - TASK References  → IMPLEMENTS:       REQ, FR, AC, DES
 *  - TASK Dependencies→ DEPENDS_ON:       TASK
 *  - CHK Reference    → VERIFIES:         REQ, FR, AC  ("tooling" = no link)
 */
export const FIELD_ALLOWED_PREFIXES: Record<string, string[]> = {
  "spec:Functional Requirements:References": ["REQ"],
  "spec:Acceptance Criteria:References": ["REQ", "FR"],
  "design:Design Decisions:References": ["FR", "AC"],
  "task-plan:Tasks:References": ["REQ", "FR", "AC", "DES"],
  "task-plan:Tasks:Dependencies": ["TASK"],
  "verification-report:Checks:Reference": ["REQ", "FR", "AC"],
};

export function allowedPrefixes(artifactType: string, section: string, field: string): string[] {
  return FIELD_ALLOWED_PREFIXES[`${artifactType}:${section}:${field}`] ?? [];
}
