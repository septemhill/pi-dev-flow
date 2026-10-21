import type { Phase } from "./phases.ts";

export type WorkflowStatus =
  | "IDLE"
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "REJECTED"
  | "COMPLETED"
  | "FAILED";

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "INVALIDATED";

export type TaskStatus = "PENDING" | "IN_PROGRESS" | "DONE";

export type CheckStatus = "PASSED" | "FAILED" | "SKIPPED" | "MANUAL";

export type WaiverStatus = "ACTIVE" | "REVOKED";

export type CoverageStageName =
  | "requirement_to_spec"
  | "spec_to_design"
  | "spec_to_tasks"
  | "tasks_to_implementation"
  | "acceptance_to_verification";

/**
 * An explicit, auditable exception: one item is exempt from one coverage
 * stage. A waiver never changes the deterministic assessment — it is stored
 * alongside it and reported as WAIVED. It pins the upstream artifact
 * revisions at grant time; any of those advancing STALEs the waiver.
 */
export interface WaiverRecord {
  id: string;
  change_id: string;
  item_id: string;
  stage: CoverageStageName;
  rationale: string;
  status: WaiverStatus;
  /** JSON: { phase: revision } at grant time. */
  pinned_revisions: string;
  created_at: string;
}

export interface WorkflowRecord {
  id: string;
  change_id: string;
  description: string;
  current_phase: Phase;
  status: WorkflowStatus;
  /** Bumped on every persisted state change; used to detect lost updates. */
  revision: number;
  pending_approval_id: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface ArtifactRecord {
  id: string;
  change_id: string;
  phase: Phase;
  revision: number;
  /** Repo-relative path, e.g. .factory/changes/<id>/spec.md */
  path: string;
  /** sha256 of the artifact file content at this revision. */
  hash: string;
  /**
   * The pinned artifact contract this artifact was validated against,
   * `templateId@templateVersion`. NULL for legacy artifacts recorded before
   * template-driven validation existed — they are marked legacy and must be
   * regenerated (re-validated) before they can be trusted as upstream.
   */
  contract: string | null;
  created_at: string;
}

export interface ApprovalRecord {
  id: string;
  workflow_id: string;
  change_id: string;
  phase: Phase;
  artifact_revision: number;
  /** Must still match the artifact file's hash when the approval is resolved. */
  artifact_hash: string;
  status: ApprovalStatus;
  reviewer: string | null;
  review_comment: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface TaskRecord {
  change_id: string;
  seq: number;
  title: string;
  scope: string;
  /** Spec/design criteria this task implements, e.g. "spec AC-2, design D1". */
  references: string;
  verification: string;
  status: TaskStatus;
  evidence: string | null;
}

export interface CheckRecord {
  change_id: string;
  name: string;
  required: boolean;
  status: CheckStatus;
  output: string | null;
  updated_at: string;
}

export interface EventRecord {
  id: number;
  workflow_id: string;
  change_id: string;
  phase: Phase;
  kind: string;
  detail: string | null;
  created_at: string;
}

/** Everything /factory status needs, in one read. */
export interface WorkflowSnapshot {
  workflow: WorkflowRecord | null;
  artifacts: ArtifactRecord[];
  pendingApproval: ApprovalRecord | null;
  lastRejection: ApprovalRecord | null;
  tasks: TaskRecord[];
  checks: CheckRecord[];
  recentEvents: EventRecord[];
}
