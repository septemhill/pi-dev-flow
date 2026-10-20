/** The fixed, ordered workflow. The extension enforces this order; prompts do not. */
export type Phase =
  | "requirement"
  | "spec"
  | "design"
  | "task_planning"
  | "implementation"
  | "verification";

export const PHASES: readonly Phase[] = [
  "requirement",
  "spec",
  "design",
  "task_planning",
  "implementation",
  "verification",
];

/** Artifact file (inside .factory/changes/<change_id>/) required by each phase. */
export const PHASE_ARTIFACT_FILE: Record<Phase, string> = {
  requirement: "requirement.md",
  spec: "spec.md",
  design: "design.md",
  task_planning: "task-plan.md",
  implementation: "implementation-report.md",
  verification: "verification-report.md",
};

/** Append-only requirement history maintained by the factory_requirement_append tool. */
export const REQUIREMENT_HISTORY_FILE = "requirements-history.md";

export function isPhase(x: string): x is Phase {
  return (PHASES as readonly string[]).includes(x);
}

/** The legal successor of a phase, or null for the final phase. */
export function nextPhase(p: Phase): Phase | null {
  const i = PHASES.indexOf(p);
  if (i < 0 || i >= PHASES.length - 1) return null;
  return PHASES[i + 1];
}

/**
 * Minimum structural contract for each phase's artifact.
 * These headings are checked by extension code, not by the LLM.
 */
export const REQUIRED_SECTIONS: Record<Phase, string[]> = {
  requirement: ["## Consolidated Requirements", "## Open Questions & Assumptions"],
  spec: ["## Expected Behavior", "## Inputs", "## Outputs", "## Acceptance Criteria"],
  design: ["## Architecture", "## Constraints", "## Decisions & Trade-offs", "## Affected Areas"],
  task_planning: ["## Tasks", "## Sequencing Notes"],
  implementation: ["## Modified Files", "## Commands Executed", "## Results", "## Unresolved Problems"],
  verification: ["## Checks", "## Overall Result"],
};
