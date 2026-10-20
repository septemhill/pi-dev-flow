export type WorkflowErrorCode =
  | "NO_ACTIVE_CHANGE" // no workflow exists
  | "CHANGE_NOT_FOUND" // requested change id does not exist
  | "ACTIVE_CHANGE_EXISTS" // a non-completed workflow already exists
  | "ILLEGAL_TRANSITION" // state machine rejected the operation
  | "PENDING_APPROVAL" // an approval gate blocks this operation
  | "STALE_APPROVAL" // artifact changed after the approval request was created
  | "INVALID_ARTIFACT" // artifact missing required structure
  | "MISSING_ARTIFACT" // artifact file does not exist on disk
  | "NO_TASKS" // task plan is empty
  | "TASKS_INCOMPLETE" // implementation finished with unfinished tasks
  | "VERIFICATION_FAILED" // a required check failed or was not executed
  | "PERSISTENCE_ERROR" // database or artifact store is unreadable/corrupted
  | "REASON_REQUIRED" // a mandatory argument (e.g. rejection reason) is empty
  | "DESCRIPTION_REQUIRED"; // /factory init without a description

/** Error with a machine-readable code so commands/tools can give actionable messages. */
export class WorkflowError extends Error {
  code: WorkflowErrorCode;
  constructor(code: WorkflowErrorCode, message: string) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}

export function isWorkflowError(e: unknown): e is WorkflowError {
  return e instanceof WorkflowError;
}

/** Normalize any thrown value into an actionable message. */
export function describeError(e: unknown): string {
  if (isWorkflowError(e)) return `[${e.code}] ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}
