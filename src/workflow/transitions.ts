/**
 * Pure workflow transition functions.
 *
 * These are the ONLY way workflow state may change. Each one:
 *  - validates the current state (throws WorkflowError on illegal input),
 *  - returns a NEW WorkflowRecord (the engine persists it in a transaction),
 *  - never mutates its input.
 *
 * There is deliberately no generic "set state" function: the LLM (or any
 * other caller) cannot assign arbitrary workflow states.
 */
import { nextPhase, type Phase } from "./phases.ts";
import { WorkflowError } from "./errors.ts";
import type { WorkflowRecord } from "./state.ts";

function bump(w: WorkflowRecord, now: string): WorkflowRecord {
  return { ...w, revision: w.revision + 1, updated_at: now };
}

/**
 * IDLE | REJECTED -> RUNNING (start a phase, or start a revision after
 * rejection). AWAITING_APPROVAL is refused: /factory run can never bypass
 * a pending approval. COMPLETED is refused: a finished workflow cannot
 * restart implicitly.
 */
export function beginPhase(w: WorkflowRecord, now: string): WorkflowRecord {
  if (w.status === "AWAITING_APPROVAL") {
    throw new WorkflowError(
      "PENDING_APPROVAL",
      `Phase "${w.current_phase}" is awaiting approval. Approve with /factory approve or reject with /factory reject "<reason>" before running again.`,
    );
  }
  if (w.status === "COMPLETED") {
    throw new WorkflowError(
      "ILLEGAL_TRANSITION",
      "The workflow is COMPLETED and cannot restart. Start a new change with /factory init.",
    );
  }
  if (w.status !== "IDLE" && w.status !== "REJECTED") {
    throw new WorkflowError(
      "ILLEGAL_TRANSITION",
      `Cannot begin phase "${w.current_phase}" from status ${w.status}. ` +
        (w.status === "FAILED"
          ? "Run /factory resume first to recover a failed workflow."
          : "Run /factory resume first to recover an interrupted workflow."),
    );
  }
  return { ...bump(w, now), status: "RUNNING" };
}

/**
 * AWAITING_APPROVAL -> RUNNING, but ONLY when the pending approval is no longer
 * PENDING (e.g. INVALIDATED because the artifact changed after the request).
 * A genuinely PENDING approval must still block: use /factory approve or reject.
 */
export function reopenForReview(w: WorkflowRecord, now: string): WorkflowRecord {
  if (w.status !== "AWAITING_APPROVAL") {
    throw new WorkflowError("ILLEGAL_TRANSITION", `Cannot reopen a review from status ${w.status}.`);
  }
  return { ...bump(w, now), status: "RUNNING", pending_approval_id: null };
}

/**
 * RUNNING -> AWAITING_APPROVAL for the current phase only.
 * The approval record is created by the engine in the same transaction;
 * the id is passed in so the workflow can reference it atomically.
 */
export function completePhase(w: WorkflowRecord, phase: Phase, approvalId: string, now: string): WorkflowRecord {
  if (phase !== w.current_phase) {
    throw new WorkflowError(
      "ILLEGAL_TRANSITION",
      `Cannot complete phase "${phase}": the workflow is on phase "${w.current_phase}".`,
    );
  }
  if (w.status !== "RUNNING") {
    throw new WorkflowError(
      "ILLEGAL_TRANSITION",
      `Cannot complete phase "${phase}" from status ${w.status}; start it with /factory run first.`,
    );
  }
  return { ...bump(w, now), status: "AWAITING_APPROVAL", pending_approval_id: approvalId, failure_reason: null };
}

/**
 * AWAITING_APPROVAL -> IDLE on the NEXT phase, or COMPLETED after the final
 * phase. `approvalId` must be exactly the workflow's pending approval, so a
 * repeated or foreign approval cannot advance the workflow twice.
 */
export function approvePhase(w: WorkflowRecord, approvalId: string, now: string): WorkflowRecord {
  if (w.status !== "AWAITING_APPROVAL") {
    throw new WorkflowError(
      "ILLEGAL_TRANSITION",
      `Nothing to approve from status ${w.status}. An approval exists only while a phase awaits review.`,
    );
  }
  if (!w.pending_approval_id || w.pending_approval_id !== approvalId) {
    throw new WorkflowError(
      "ILLEGAL_TRANSITION",
      `Approval "${approvalId}" is not the pending approval for this workflow.`,
    );
  }
  const next = nextPhase(w.current_phase);
  const base = bump(w, now);
  if (!next) {
    return { ...base, status: "COMPLETED", pending_approval_id: null };
  }
  return { ...base, status: "IDLE", current_phase: next, pending_approval_id: null };
}

/** AWAITING_APPROVAL -> REJECTED, same phase. The phase must be revised and re-reviewed. */
export function rejectPhase(w: WorkflowRecord, approvalId: string, now: string): WorkflowRecord {
  if (w.status !== "AWAITING_APPROVAL") {
    throw new WorkflowError("ILLEGAL_TRANSITION", `Nothing to reject from status ${w.status}.`);
  }
  if (!w.pending_approval_id || w.pending_approval_id !== approvalId) {
    throw new WorkflowError(
      "ILLEGAL_TRANSITION",
      `Approval "${approvalId}" is not the pending approval for this workflow.`,
    );
  }
  return { ...bump(w, now), status: "REJECTED", pending_approval_id: null };
}

/** IDLE | RUNNING -> FAILED (explicit, recorded execution failure). */
export function failWorkflow(w: WorkflowRecord, reason: string, now: string): WorkflowRecord {
  if (w.status !== "RUNNING" && w.status !== "IDLE") {
    throw new WorkflowError("ILLEGAL_TRANSITION", `Cannot mark FAILED from status ${w.status}.`);
  }
  return { ...bump(w, now), status: "FAILED", failure_reason: reason };
}

/** FAILED | RUNNING (interrupted) -> IDLE, same phase. Explicit recovery only. */
export function resumeWorkflow(w: WorkflowRecord, now: string): WorkflowRecord {
  if (w.status !== "FAILED" && w.status !== "RUNNING") {
    throw new WorkflowError(
      "ILLEGAL_TRANSITION",
      `Nothing to recover from status ${w.status}. Only FAILED or interrupted RUNNING workflows can be resumed.`,
    );
  }
  return { ...bump(w, now), status: "IDLE", failure_reason: null };
}
