import { WorkflowError } from "../workflow/errors.ts";
import type { ApprovalRecord, WorkflowRecord } from "../workflow/state.ts";

/**
 * Approval validation rules, as pure functions.
 *
 * An approval is only valid when:
 *  - it is PENDING (already-resolved approvals are one-shot),
 *  - it belongs to the workflow's pending slot and the workflow is AWAITING_APPROVAL,
 *  - its artifact hash still matches the artifact file currently on disk
 *    (a changed artifact invalidates the approval and forces a new review).
 */

export function assertWorkflowAwaitsApproval(w: WorkflowRecord, approvalId: string): void {
  if (w.status !== "AWAITING_APPROVAL") {
    throw new WorkflowError(
      "ILLEGAL_TRANSITION",
      `Nothing to approve/reject from status ${w.status}.`,
    );
  }
  if (!w.pending_approval_id || w.pending_approval_id !== approvalId) {
    throw new WorkflowError(
      "ILLEGAL_TRANSITION",
      `Approval "${approvalId}" is not the pending approval for this workflow (pending: ${w.pending_approval_id ?? "none"}).`,
    );
  }
}

export function assertApprovalPending(a: ApprovalRecord | null): asserts a is ApprovalRecord {
  if (!a) {
    throw new WorkflowError("ILLEGAL_TRANSITION", "Approval record not found. State may be corrupted; run /factory status.");
  }
  if (a.status !== "PENDING") {
    throw new WorkflowError(
      "ILLEGAL_TRANSITION",
      `Approval ${a.id} is already ${a.status}; it cannot be resolved again.`,
    );
  }
}

/**
 * @param onDiskHash  sha256 of the artifact file right now (null if missing)
 * @throws STALE_APPROVAL (or MISSING_ARTIFACT) when the hash no longer matches.
 */
export function assertHashStillMatches(a: ApprovalRecord, onDiskHash: string | null): void {
  if (onDiskHash === null) {
    throw new WorkflowError(
      "MISSING_ARTIFACT",
      `The artifact file for phase "${a.phase}" is missing from disk; the approval cannot be validated. Restore it or re-run the phase.`,
    );
  }
  if (onDiskHash !== a.artifact_hash) {
    throw new WorkflowError(
      "STALE_APPROVAL",
      `The "${a.phase}" artifact changed after the approval request was created ` +
        `(requested hash ${a.artifact_hash.slice(0, 12)}…, file now ${onDiskHash.slice(0, 12)}…). ` +
        "The pending approval is invalidated; revise if needed and run the phase again to request a new review.",
    );
  }
}
