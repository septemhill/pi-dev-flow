import { WorkflowError } from "../workflow/errors.ts";
import type { KnowledgeType } from "./types.ts";
import { effectiveStatus } from "./types.ts";

/**
 * Project Knowledge lifecycle — pure transition rules, enforced by
 * KnowledgeManager. The exact allowed transitions are:
 *
 *   constraint / convention:
 *     draft     -> proposed | approved | deprecated
 *     proposed  -> draft | approved | deprecated
 *     approved  -> deprecated
 *     deprecated-> approved   (explicit reinstatement)
 *
 *   tech-decision (ADR-consistent):
 *     draft     -> proposed | accepted | rejected | withdrawn
 *     proposed  -> draft | accepted | rejected | withdrawn
 *     accepted  -> superseded | withdrawn
 *     rejected / superseded : terminal (history is preserved, never deleted)
 *     withdrawn                     : terminal
 *
 * Only extension-controlled operations may perform these transitions. An
 * invalid transition throws BEFORE any file is written, so the previous
 * effective state is always preserved.
 */

const CC_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ["proposed", "approved", "deprecated"],
  proposed: ["draft", "approved", "deprecated"],
  approved: ["deprecated"],
  deprecated: ["approved"],
};

const ADR_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ["proposed", "accepted", "rejected", "withdrawn"],
  proposed: ["draft", "accepted", "rejected", "withdrawn"],
  accepted: ["superseded", "withdrawn"],
  rejected: [],
  superseded: [],
  withdrawn: [],
};

export function allowedTransitions(type: KnowledgeType, from: string): readonly string[] {
  const table = type === "tech-decision" ? ADR_TRANSITIONS : CC_TRANSITIONS;
  return table[from] ?? [];
}

/** @throws ILLEGAL_TRANSITION when `from` -> `to` is not allowed. */
export function assertTransition(type: KnowledgeType, id: string, from: string, to: string): void {
  if (!allowedTransitions(type, from).includes(to)) {
    const allowed = allowedTransitions(type, from);
    throw new WorkflowError(
      "ILLEGAL_TRANSITION",
      `Illegal knowledge lifecycle transition ${from} -> ${to} for ${type} record ${id}. ` +
        (allowed.length > 0 ? `Allowed from "${from}": ${allowed.join(" | ")}.` : `"${from}" is a terminal state.`) +
        ` The previous state was left unchanged.`,
    );
  }
}

/** The status `approve` drives a record to. */
export function approvalTarget(type: KnowledgeType): string {
  return effectiveStatus(type);
}

/** A record is "effective" (governs new work) only in its terminal-positive status. */
export function isEffective(type: KnowledgeType, status: string): boolean {
  return status === effectiveStatus(type);
}
