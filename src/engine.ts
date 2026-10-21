import { userInfo } from "node:os";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  Database,
} from "./persistence/database.ts";
import {
  appendFile,
  changeDir,
  changeFile,
  dbPath as resolveDbPath,
  readFileOrNull,
  sha256,
  sha256File,
} from "./artifacts/artifact-store.ts";
import { getContract } from "./artifacts/artifact-registry.ts";
import { validateArtifact, formatValidationResult, errorIssues, warningIssues } from "./artifacts/artifact-validator.ts";
import type { ArtifactValidationResult } from "./artifacts/artifact-types.ts";
import type { PhaseContext, UpstreamArtifactRef } from "./artifacts/validation-context.ts";
import {
  PHASES,
  PHASE_ARTIFACT_FILE,
  REQUIREMENT_HISTORY_FILE,
  nextPhase,
  type Phase,
} from "./workflow/phases.ts";
import { WorkflowError, describeError, isWorkflowError } from "./workflow/errors.ts";
import {
  beginPhase,
  completePhase,
  failWorkflow,
  approvePhase,
  rejectPhase,
  reopenForReview,
  resumeWorkflow,
} from "./workflow/transitions.ts";
import {
  assertApprovalPending,
  assertWorkflowAwaitsApproval,
} from "./approvals/approval-manager.ts";
import type {
  ApprovalRecord,
  ArtifactRecord,
  CheckRecord,
  CheckStatus,
  TaskRecord,
  TaskStatus,
  WaiverRecord,
  CoverageStageName,
  WorkflowRecord,
  WorkflowSnapshot,
} from "./workflow/state.ts";
import { buildChangeTrace, renderTraceabilityReport } from "./traceability/report.ts";

export interface NewTaskInput {
  title: string;
  scope: string;
  references: string;
  verification: string;
}

/**
 * FactoryEngine: the single authority on workflow state for one repository.
 *
 * Every state-changing operation is:
 *   1. load current state,
 *   2. run a pure transition function (throws on illegal input, before any write),
 *   3. persist all related rows (workflow, artifact, approval, event) in ONE
 *      SQLite transaction,
 *   4. only then report success.
 *
 * The engine has no dependency on the pi runtime, so it is fully unit-testable.
 */
export class FactoryEngine {
  root: string;
  db: Database;
  /** Result of the most recent full artifact validation (set by validatePhaseContract / validateActivePhase). */
  private lastValidation: { phase: Phase; result: ArtifactValidationResult } | null = null;

  constructor(root: string) {
    this.root = root;
    this.db = new Database(resolveDbPath(root));
  }

  close(): void {
    this.db.close();
  }

  private now(): string {
    return new Date().toISOString();
  }

  private reviewer(): string {
    try {
      return userInfo().username;
    } catch {
      return "local-user";
    }
  }

  // ------------------------------------------------------------- queries

  getWorkflow(changeId: string): WorkflowRecord | null {
    return this.db.getWorkflowByChange(changeId);
  }

  getActiveWorkflow(): WorkflowRecord | null {
    return this.db.getActiveWorkflow();
  }

  requireActive(): WorkflowRecord {
    const w = this.getActiveWorkflow();
    if (!w) {
      throw new WorkflowError(
        "NO_ACTIVE_CHANGE",
        "No active change. Start one with: /factory init <description>",
      );
    }
    return w;
  }

  snapshot(): WorkflowSnapshot {
    const w = this.getActiveWorkflow();
    if (!w) return { workflow: null, artifacts: [], pendingApproval: null, lastRejection: null, tasks: [], checks: [], recentEvents: [] };
    const pending = w.pending_approval_id ? this.db.getApproval(w.pending_approval_id) : null;
    return {
      workflow: w,
      artifacts: this.db.allArtifacts(w.change_id),
      pendingApproval: pending,
      lastRejection: this.db.lastRejection(w.change_id, w.current_phase),
      tasks: this.db.listTasks(w.change_id),
      checks: this.db.listChecks(w.change_id),
      recentEvents: this.db.recentEvents(w.change_id),
    };
  }

  readArtifactText(phase: Phase): string | null {
    const w = this.requireActive();
    return readFileOrNull(changeFile(this.root, w.change_id, phase));
  }

  // ------------------------------------------------------------- init

  /**
   * Create a new change at phase `requirement`, status IDLE.
   * Never touches an existing non-completed workflow (no silent replacement).
   */
  initChange(description: string): WorkflowRecord {
    const desc = description.trim();
    if (!desc) {
      throw new WorkflowError("DESCRIPTION_REQUIRED", "Usage: /factory init <description of the change>");
    }
    const active = this.getActiveWorkflow();
    if (active) {
      throw new WorkflowError(
        "ACTIVE_CHANGE_EXISTS",
        `Change "${active.change_id}" is still active (status ${active.status}, phase ${active.current_phase}). ` +
          "Finish it (approve through verification) before starting a new change.",
      );
    }
    const changeId = this.makeChangeId(desc);
    const w: WorkflowRecord = {
      id: this.db.newId("wf"),
      change_id: changeId,
      description: desc,
      current_phase: "requirement",
      status: "IDLE",
      revision: 1,
      pending_approval_id: null,
      failure_reason: null,
      created_at: this.now(),
      updated_at: this.now(),
    };
    this.db.tx(() => {
      this.db.insertWorkflow(w);
      this.db.insertEvent(w.id, w.change_id, w.current_phase, "CHANGE_CREATED", desc, w.created_at);
    });
    // Create the (empty) change directory after the DB commit; harmless if it fails.
    try {
      mkdirSync(changeDir(this.root, changeId), { recursive: true });
    } catch (e) {
      throw new WorkflowError("PERSISTENCE_ERROR", `Created workflow but could not create change directory: ${describeError(e)}`);
    }
    return w;
  }

  private makeChangeId(description: string): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const slug = description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "");
    let id = `chg-${stamp}${slug ? "-" + slug : ""}`;
    let n = 2;
    while (this.db.getWorkflowByChange(id)) {
      id = `chg-${stamp}${slug ? "-" + slug : ""}-${n++}`;
    }
    return id;
  }

  // ------------------------------------------------------------- run phase

  /**
   * Transition for /factory run:
   *  - IDLE / REJECTED  -> RUNNING (fresh start or revision after rejection)
   *  - RUNNING          -> unchanged (safe re-prompt of an in-flight phase)
   *  - AWAITING_APPROVAL with a live PENDING approval -> PENDING_APPROVAL error
   *  - AWAITING_APPROVAL whose approval was INVALIDATED (artifact changed) ->
   *    RUNNING again: the old review is void, a new one must be requested
   *  - COMPLETED / FAILED -> actionable errors
   * Returns whether the status changed (true = freshly started / revision / reopen).
   */
  beginCurrentPhase(): boolean {
    const w = this.requireActive();
    if (w.status === "RUNNING") return false;
    const at = this.now();
    let nw: WorkflowRecord;
    let eventKind: string;
    let detail: string;
    if (w.status === "AWAITING_APPROVAL") {
      const pending = w.pending_approval_id ? this.db.getApproval(w.pending_approval_id) : null;
      if (pending && pending.status === "PENDING") {
        // beginPhase refuses AWAITING_APPROVAL and throws the actionable PENDING_APPROVAL error.
        beginPhase(w, at);
      }
      nw = reopenForReview(w, at);
      eventKind = "REVIEW_REOPENED";
      detail = "Pending approval was no longer PENDING; the phase must be re-run and re-reviewed";
    } else {
      nw = beginPhase(w, at);
      eventKind = w.status === "REJECTED" ? "PHASE_REVISION_STARTED" : "PHASE_STARTED";
      detail = w.status === "REJECTED"
        ? `Revising phase "${nw.current_phase}" after rejection`
        : `Starting phase "${nw.current_phase}"`;
    }
    this.db.tx(() => {
      this.db.updateWorkflow(nw, w.revision);
      this.db.insertEvent(nw.id, nw.change_id, nw.current_phase, eventKind, detail, nw.updated_at);
    });
    return true;
  }

  notePromptSent(detail: string): void {
    const w = this.requireActive();
    if (w.status !== "RUNNING") return;
    this.db.tx(() => {
      this.db.insertEvent(w.id, w.change_id, w.current_phase, "PHASE_PROMPT_SENT", detail, this.now());
    });
  }

  // ------------------------------------------------------------- complete phase

  /**
   * Called by the factory_phase_complete tool (LLM) — but the LLM only triggers
   * it; ALL validation below is extension code:
   *   - artifact file exists and satisfies the phase's structural contract,
   *   - phase-specific invariants (tasks all done / required checks passed),
   *   - revision + sha256 computed and persisted,
   *   - old pending approval invalidated if the artifact changed,
   *   - NEW pending approval created, workflow -> AWAITING_APPROVAL,
   *     all in one transaction.
   */
  completeCurrentPhase(): { workflow: WorkflowRecord; approval: ApprovalRecord; artifact: ArtifactRecord } {
    const w = this.requireActive();
    const phase = w.current_phase;
    this.validatePhaseContract(phase);

    const file = changeFile(this.root, w.change_id, phase);
    const hash = sha256File(file);

    const latest = this.db.latestArtifact(w.change_id, phase);
    const revision = latest && latest.hash === hash ? latest.revision : (latest ? latest.revision + 1 : 1);
    const approvalId = this.db.newId("ap");
    const at = this.now();
    const nw = completePhase(w, phase, approvalId, at);
    const artifact: ArtifactRecord = {
      id: this.db.newId("art"),
      change_id: w.change_id,
      phase,
      revision,
      path: path.join(".factory", "changes", w.change_id, PHASE_ARTIFACT_FILE[phase]),
      hash,
      // The contract this candidate was just validated against — persisted so
      // the artifact can be audited and legacy (pre-contract) rows stay NULL.
      contract: `${getContract(phase).templateId}@${getContract(phase).templateVersion}`,
      created_at: at,
    };
    const approval: ApprovalRecord = {
      id: approvalId,
      workflow_id: w.id,
      change_id: w.change_id,
      phase,
      artifact_revision: revision,
      artifact_hash: hash,
      status: "PENDING",
      reviewer: this.reviewer(),
      review_comment: null,
      created_at: at,
      resolved_at: null,
    };
    const v = this.lastValidation;
    this.db.tx(() => {
      // Insert a new revision row only when the content actually changed
      // (same hash + same revision would violate the uniqueness constraint).
      if (!latest || latest.hash !== hash) this.db.insertArtifact(artifact);
      // Any earlier pending approval for this workflow becomes invalid: the
      // artifact it covered is no longer the one under review.
      if (w.pending_approval_id) this.db.invalidateApproval(w.pending_approval_id, at);
      this.db.insertApproval(approval);
      this.db.updateWorkflow(nw, w.revision);
      this.db.insertEvent(
        nw.id, w.change_id, phase, "PHASE_COMPLETED",
        `${PHASE_ARTIFACT_FILE[phase]} revision ${revision} sha256:${hash.slice(0, 16)} → approval ${approvalId}` +
          (v && v.phase === phase
            ? `; validation PASSED (contract ${v.result.templateId}@${v.result.templateVersion}, ${warningIssues(v.result).length} warning(s))`
            : ""),
        at,
      );
    });
    return { workflow: nw, approval, artifact };
  }

  /**
   * Build the validation context from PERSISTED state only: the requirement
   * history file, recorded tasks, recorded checks, and the approved upstream
   * artifacts (recorded revision + hash + on-disk text). Never from memory.
   */
  buildPhaseContext(changeId: string, phase: Phase, expectedRevision: number): PhaseContext {
    const historyFile = changeFile(this.root, changeId, phase, REQUIREMENT_HISTORY_FILE);
    const historyText = readFileOrNull(historyFile);
    const requirementHistory = (historyText ?? "").split("\n").filter((l) => /^\s*-\s*\[[^\]]*\]\s*\(R\d+\)/.test(l));
    const historyIds = requirementHistory
      .map((l) => /\(R(\d+)\)/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]));
    const upstream: UpstreamArtifactRef[] = [];
    for (const p of PHASES) {
      if (p === phase) break;
      const row = this.db.latestArtifact(changeId, p);
      if (!row) continue;
      upstream.push({
        phase: p,
        revision: row.revision,
        hash: row.hash,
        text: readFileOrNull(changeFile(this.root, changeId, p)),
        // Recorded before template-driven validation existed (pre-contract).
        legacy: row.contract === null,
      });
    }
    return {
      changeId,
      expectedRevision,
      requirementHistory,
      historyIds,
      tasks: this.db.listTasks(changeId),
      checks: this.db.listChecks(changeId),
      upstream,
      waivers: this.db.listWaivers(changeId),
    };
  }

  /**
   * Run the full artifact validation pipeline for one candidate artifact and
   * persist the result for audit. Throws CONTRACT_ERROR when the pinned
   * template/schema cannot be loaded (fail closed — never skip validation).
   */
  runArtifactValidation(
    changeId: string,
    phase: Phase,
    text: string,
    hash: string,
    expectedRevision: number,
  ): ArtifactValidationResult {
    const contract = getContract(phase);
    const ctx = this.buildPhaseContext(changeId, phase, expectedRevision);
    const upstreamRaw = new Map<Phase, string | null>();
    for (const u of ctx.upstream) upstreamRaw.set(u.phase, u.text);
    let result: ArtifactValidationResult;
    try {
      result = validateArtifact({ contract, rawText: text, ctx, artifactHash: hash, upstreamRaw });
    } catch (e) {
      if (isWorkflowError(e)) throw e;
      throw new WorkflowError(
        "CONTRACT_ERROR",
        `Artifact validation could not run: ${describeError(e)} Refusing to record an unvalidated artifact — fix the installation (template/schema files) and retry.`,
      );
    }
    this.db.saveValidationResult(changeId, phase, hash, {
      valid: result.valid,
      errorCount: errorIssues(result).length,
      warningCount: warningIssues(result).length,
      templateVersion: result.templateVersion,
      schemaId: result.schemaId,
      parserVersion: result.parserVersion,
      resultJson: JSON.stringify(result),
    });
    return result;
  }

  /**
   * Validate the active workflow's current-phase artifact (for /factory
   * validate). Returns the full result instead of throwing on INVALID;
   * still throws on missing artifact / contract errors.
   */
  validateActivePhase(): { phase: Phase; result: ArtifactValidationResult; latest: ArtifactRecord | null } {
    const w = this.requireActive();
    const phase = w.current_phase;
    const file = changeFile(this.root, w.change_id, phase);
    const text = readFileOrNull(file);
    if (text === null) {
      throw new WorkflowError(
        "MISSING_ARTIFACT",
        `No artifact file yet for phase "${phase}" (${path.relative(this.root, file)}). Run the phase first, then /factory validate.`,
      );
    }
    const latest = this.db.latestArtifact(w.change_id, phase);
    const hash = sha256(text);
    const expectedRevision = latest && latest.hash === hash ? latest.revision : (latest ? latest.revision + 1 : 1);
    const result = this.runArtifactValidation(w.change_id, phase, text, hash, expectedRevision);
    this.lastValidation = { phase, result };
    return { phase, result, latest };
  }

  /**
   * /factory traceability — the deterministic coverage report for the active
   * change: every stage, every item's coverage state, uncovered items,
   * stale references and active/stale waivers. Built from the recorded
   * artifacts only; it never invents links or status.
   */
  traceabilityReport(): string {
    const w = this.requireActive();
    const trace = buildChangeTrace(this.root, w.change_id, this.db);
    return renderTraceabilityReport(trace);
  }

  /**
   * Grant an explicit, auditable coverage waiver for ONE item at ONE stage.
   * Only items that exist in the recorded traceability graph can be waived
   * (no waivers for phantom ids), and the waiver pins the current revision
   * of every recorded artifact — any upstream change STALEs it. A waiver
   * never changes the deterministic assessment; it is reported as WAIVED.
   */
  waiveItem(
    itemId: string,
    stage: CoverageStageName,
    rationale: string,
  ): { waiver: WaiverRecord; created: boolean } {
    const w = this.requireActive();
    if (rationale.trim().length < 10) {
      throw new WorkflowError("CONTRACT_ERROR", `Waiver rationale too short for ${itemId} @ ${stage}. State precisely why the obligation is acceptable without coverage (≥10 characters), or cover the item properly.`);
    }
    const trace = buildChangeTrace(this.root, w.change_id, this.db);
    const known = (trace.report?.assessments ?? []).filter((a) => a.stage === stage);
    const hit = known.find((a) => a.item.id === itemId);
    if (!hit) {
      const list = known.length > 0 ? known.map((a) => a.item.id).join(", ") : "none";
      throw new WorkflowError("CONTRACT_ERROR", `Cannot waive ${itemId} @ ${stage}: the item is not assessable at that stage. Assessable items at ${stage}: ${list}. Waivers can only record exceptions for real, uncovered obligations — they cannot fabricate coverage.`);
    }
    if (hit.status === "VERIFIED" || hit.status === "COVERED") {
      throw new WorkflowError("CONTRACT_ERROR", `${itemId} @ ${stage} is already ${hit.status}. Waivers exist for UNCOVERED/PARTIAL obligations, not to override successful evidence.`);
    }
    const pinned: Partial<Record<Phase, number>> = {};
    for (const a of trace.artifacts) pinned[a.phase] = a.revision;
    const rec: WaiverRecord = {
      id: `wv-${w.change_id.slice(-8)}-${itemId}-${stage}-${Date.now().toString(36)}`,
      change_id: w.change_id,
      item_id: itemId,
      stage,
      rationale: rationale.trim(),
      status: "ACTIVE",
      pinned_revisions: JSON.stringify(pinned),
      created_at: this.now(),
    };
    const { waiver, created } = this.db.addWaiver(rec);
    this.db.insertEvent(w.id, w.change_id, w.current_phase, created ? "WAIVER_GRANTED" : "WAIVER_EXISTS", `${created ? "Granted" : "Already granted"} ${waiver.id} for ${itemId} @ ${stage}: ${waiver.rationale}`, this.now());
    return { waiver, created };
  }

  /** Revoke an active waiver (explicit; the coverage assessment stands again). */
  revokeWaiver(id: string): WaiverRecord {
    const w = this.requireActive();
    const existing = this.db.getWaiver(id);
    if (!existing || existing.change_id !== w.change_id) {
      throw new WorkflowError("CHANGE_NOT_FOUND", `No waiver ${id} recorded for change ${w.change_id}.`);
    }
    if (existing.status !== "ACTIVE") {
      throw new WorkflowError("ILLEGAL_TRANSITION", `Waiver ${id} is ${existing.status}, not ACTIVE — nothing to revoke.`);
    }
    const changed = this.db.revokeWaiver(id);
    if (!changed) throw new WorkflowError("ILLEGAL_TRANSITION", `Waiver ${id} could not be revoked (concurrent change?).`);
    const updated = this.db.getWaiver(id)!;
    this.db.insertEvent(w.id, w.change_id, w.current_phase, "WAIVER_REVOKED", `Revoked ${id} (${updated.item_id} @ ${updated.stage})`, this.now());
    return updated;
  }

  /** Structural + semantic + schema + traceability + phase-specific validation. Throws WorkflowError with the full list of problems. */
  validatePhaseContract(phase: Phase): void {
    const w = this.requireActive();
    const file = changeFile(this.root, w.change_id, phase);
    const text = readFileOrNull(file);
    if (text === null) {
      throw new WorkflowError(
        "MISSING_ARTIFACT",
        `Phase artifact is missing: ${path.relative(this.root, file)}. Write it first, then call factory_phase_complete.`,
      );
    }

    // The artifact must pass the full pinned-contract pipeline: deterministic
    // parse + JSON Schema + cross-artifact traceability + phase semantics.
    // The LLM cannot bypass, reconfigure, or extend this contract.
    const latest = this.db.latestArtifact(w.change_id, phase);
    const hash = sha256(text);
    const expectedRevision = latest && latest.hash === hash ? latest.revision : (latest ? latest.revision + 1 : 1);
    const result = this.runArtifactValidation(w.change_id, phase, text, hash, expectedRevision);
    this.lastValidation = { phase, result };
    if (!result.valid) {
      throw new WorkflowError(
        "INVALID_ARTIFACT",
        `Phase "${phase}" artifact FAILED validation (${errorIssues(result).length} error(s), ${warningIssues(result).length} warning(s)). ` +
          `The candidate was NOT recorded and NO approval was requested. Fix the file and call factory_phase_complete again.\n\n` +
          formatValidationResult(result),
      );
    }

    // Phase-specific persisted-state invariants (kept from the MVP gate).
    const problems: string[] = [];
    if (phase === "requirement") {
      const hist = readFileOrNull(changeFile(this.root, w.change_id, phase, REQUIREMENT_HISTORY_FILE));
      const entries = hist ? hist.split("\n").filter((l) => l.startsWith("- [")).length : 0;
      if (entries === 0) {
        problems.push(`no entries recorded in ${REQUIREMENT_HISTORY_FILE} (use the factory_requirement_append tool for each user requirement)`);
      }
    }
    if (phase === "task_planning") {
      const tasks = this.db.listTasks(w.change_id);
      if (tasks.length === 0) {
        problems.push("no tasks recorded (use the factory_set_task_plan tool with a small ordered task list)");
      } else {
        for (const t of tasks) {
          if (!t.references.trim() || !t.verification.trim()) {
            problems.push(`task ${t.seq} ("${t.title}") is missing spec/design references or verification criteria`);
          }
        }
      }
    }
    if (phase === "implementation") {
      const tasks = this.db.listTasks(w.change_id);
      const open = tasks.filter((t) => t.status !== "DONE");
      if (open.length > 0) {
        problems.push(
          `${open.length} task(s) not DONE (with evidence): ${open.map((t) => `${t.seq}.${t.title}`).join("; ")}`,
        );
      }
      const noEvidence = tasks.filter((t) => t.status === "DONE" && !(t.evidence ?? "").trim());
      if (noEvidence.length > 0) {
        problems.push(`task(s) marked DONE without evidence: ${noEvidence.map((t) => String(t.seq)).join(", ")}`);
      }
    }
    if (phase === "verification") {
      const checks = this.db.listChecks(w.change_id);
      if (checks.length === 0) {
        problems.push("no verification checks recorded (use the factory_check_record tool for every check you run)");
      }
      const bad = checks.filter((c) => c.required && (c.status === "FAILED" || c.status === "SKIPPED"));
      if (bad.length > 0) {
        throw new WorkflowError(
          "VERIFICATION_FAILED",
          `Required check(s) failed or were not executed: ${bad.map((c) => `${c.name}=${c.status}`).join("; ")} — ` +
            "fix the implementation or re-run the checks. Verification cannot be reported as successful.",
        );
      }
    }
    if (problems.length > 0) {
      throw new WorkflowError("INVALID_ARTIFACT", `Phase "${phase}" artifact is not complete:\n  - ${problems.join("\n  - ")}`);
    }
  }

  // ------------------------------------------------------------- approval

  /** Human-only: /factory approve [comment]. Validates record + hash, then advances exactly one phase. */
  /**
   * If the on-disk artifact no longer matches the approval's recorded hash,
   * invalidate the approval (persisted, with an event) and throw STALE_APPROVAL.
   * A stale approval must never be able to resolve a workflow transition.
   */
  private invalidateStaleApproval(w: WorkflowRecord, approval: ApprovalRecord, onDisk: string | null): void {
    if (onDisk !== null && onDisk === approval.artifact_hash) return;
    const at = this.now();
    this.db.tx(() => {
      this.db.invalidateApproval(approval.id, at);
      this.db.insertEvent(
        w.id, w.change_id, w.current_phase, "APPROVAL_INVALIDATED",
        `Artifact changed after the approval request (hash mismatch); approval ${approval.id} is void`,
        at,
      );
    });
    throw new WorkflowError(
      "STALE_APPROVAL",
      `The phase artifact changed after the approval request — approval ${approval.id} was INVALIDATED. ` +
        "Complete the phase again to request a fresh review.",
    );
  }

  approve(comment: string): { workflow: WorkflowRecord; approval: ApprovalRecord } {
    const w = this.requireActive();
    const approvalId = w.pending_approval_id;
    if (!approvalId) throw new WorkflowError("ILLEGAL_TRANSITION", "No pending approval to approve.");
    assertWorkflowAwaitsApproval(w, approvalId);
    const approval = this.db.getApproval(approvalId);
    assertApprovalPending(approval);
    if (approval.phase !== w.current_phase) {
      throw new WorkflowError("ILLEGAL_TRANSITION", `Approval phase "${approval.phase}" != workflow phase "${w.current_phase}".`);
    }
    const onDisk = sha256Safe(changeFile(this.root, w.change_id, w.current_phase));
    this.invalidateStaleApproval(w, approval, onDisk);

    const at = this.now();
    const nw = approvePhase(w, approval.id, at);
    const resolved: ApprovalRecord = { ...approval, status: "APPROVED", reviewer: this.reviewer(), review_comment: comment || null, resolved_at: at };
    this.db.tx(() => {
      this.db.resolveApproval(approval.id, "APPROVED", this.reviewer(), comment || "", at);
      this.db.updateWorkflow(nw, w.revision);
      const next = nextPhase(w.current_phase);
      this.db.insertEvent(
        nw.id, w.change_id, w.current_phase, "PHASE_APPROVED",
        `approval ${approval.id} by ${resolved.reviewer}${comment ? `: ${comment}` : ""}`,
        at,
      );
      if (next) {
        this.db.insertEvent(nw.id, w.change_id, next, "PHASE_ADVANCED", `Advanced from "${w.current_phase}" to "${next}"`, at);
      } else {
        this.db.insertEvent(nw.id, w.change_id, w.current_phase, "WORKFLOW_COMPLETED", "All six phases approved", at);
      }
    });
    return { workflow: nw, approval: resolved };
  }

  /** Human-only: /factory reject <reason>. Same phase stays current; revision required. */
  reject(reason: string): { workflow: WorkflowRecord; approval: ApprovalRecord } {
    const why = reason.trim();
    if (!why) {
      throw new WorkflowError("REASON_REQUIRED", "A rejection reason is required: /factory reject <reason>");
    }
    const w = this.requireActive();
    const approvalId = w.pending_approval_id;
    if (!approvalId) throw new WorkflowError("ILLEGAL_TRANSITION", "No pending approval to reject.");
    assertWorkflowAwaitsApproval(w, approvalId);
    const approval = this.db.getApproval(approvalId);
    assertApprovalPending(approval);
    const onDisk = sha256Safe(changeFile(this.root, w.change_id, w.current_phase));
    this.invalidateStaleApproval(w, approval, onDisk);

    const at = this.now();
    const nw = rejectPhase(w, approval.id, at);
    const resolved: ApprovalRecord = { ...approval, status: "REJECTED", reviewer: this.reviewer(), review_comment: why, resolved_at: at };
    this.db.tx(() => {
      this.db.resolveApproval(approval.id, "REJECTED", this.reviewer(), why, at);
      this.db.updateWorkflow(nw, w.revision);
      this.db.insertEvent(nw.id, w.change_id, w.current_phase, "PHASE_REJECTED", `rejection by ${resolved.reviewer}: ${why}`, at);
    });
    return { workflow: nw, approval: resolved };
  }

  /** The rejection feedback the next revision must address. */
  lastRejection(phase: Phase): ApprovalRecord | null {
    const w = this.requireActive();
    return this.db.lastRejection(w.change_id, phase);
  }

  // ------------------------------------------------------------- failure & recovery

  /** Explicit execution failure (factory_report_failure tool or operator). */
  fail(reason: string): WorkflowRecord {
    const why = reason.trim();
    if (!why) throw new WorkflowError("REASON_REQUIRED", "A failure reason is required.");
    const w = this.requireActive();
    const nw = failWorkflow(w, why, this.now());
    this.db.tx(() => {
      this.db.updateWorkflow(nw, w.revision);
      this.db.insertEvent(nw.id, w.change_id, w.current_phase, "WORKFLOW_FAILED", why, nw.updated_at);
    });
    return nw;
  }

  /**
   * /factory resume: reload persisted state, verify artifact integrity, and
   * recover only FAILED / interrupted-RUNNING workflows (same phase, IDLE).
   * Never bypasses an approval gate; never silently resets state.
   */
  resume(): { workflow: WorkflowRecord; recovered: boolean; integrity: string[] } {
    const w = this.requireActive();
    const problems: string[] = [];
    for (const phase of PHASES) {
      const latest = this.db.latestArtifact(w.change_id, phase);
      if (!latest) continue;
      const abs = changeFile(this.root, w.change_id, phase);
      const disk = sha256Safe(abs);
      if (disk === null) {
        problems.push(`${phase}: artifact file ${latest.path} is missing`);
      } else if (disk !== latest.hash) {
        problems.push(`${phase}: artifact file ${latest.path} was modified after it was recorded (hash mismatch rev ${latest.revision})`);
      }
    }
    if (problems.length > 0) {
      throw new WorkflowError(
        "PERSISTENCE_ERROR",
        "Integrity check failed; no state was changed:\n  - " + problems.join("\n  - ") +
          "\nRestore the files (or re-run the affected phase after a new review) before continuing.",
      );
    }
    if (w.status !== "FAILED" && w.status !== "RUNNING") {
      return { workflow: w, recovered: false, integrity: [] };
    }
    const nw = resumeWorkflow(w, this.now());
    const note = w.status === "FAILED"
      ? `Recovered from FAILED: ${w.failure_reason}`
      : "Recovered from an interrupted RUNNING phase. Inspect existing progress before continuing; do not redo verified work.";
    this.db.tx(() => {
      this.db.updateWorkflow(nw, w.revision);
      this.db.insertEvent(nw.id, w.change_id, nw.current_phase, "WORKFLOW_RESUMED", note, nw.updated_at);
    });
    return { workflow: nw, recovered: true, integrity: [] };
  }

  // ------------------------------------------------------------- phase tools

  /** Requirement phase only: append a user requirement (original statement preserved). */
  appendRequirement(statement: string): { entry: number } {
    const w = this.requireActive();
    const text = statement.trim();
    if (!text) throw new WorkflowError("REASON_REQUIRED", "A non-empty requirement statement is required.");
    if (w.current_phase !== "requirement" || w.status !== "RUNNING") {
      throw new WorkflowError(
        "ILLEGAL_TRANSITION",
        "Requirements are only recorded while the requirement phase is RUNNING (start it with /factory run).",
      );
    }
    const file = changeFile(this.root, w.change_id, "requirement", REQUIREMENT_HISTORY_FILE);
    const before = readFileOrNull(file);
    const count = before ? before.split("\n").filter((l) => l.startsWith("- [")).length : 0;
    const n = count + 1;
    const flat = text.replace(/\n+/g, " ").trim();
    const entry = `- [${this.now()}] (R${n}) ${flat}`;
    appendFile(file, entry);
    this.db.tx(() => {
      this.db.insertEvent(w.id, w.change_id, "requirement", "REQUIREMENT_ADDED", entry, this.now());
    });
    return { entry: n };
  }

  /** Task planning phase only: create (or replace) the ordered task plan. */
  setTaskPlan(tasks: NewTaskInput[], replace: boolean): TaskRecord[] {
    const w = this.requireActive();
    if (w.current_phase !== "task_planning" || w.status !== "RUNNING") {
      throw new WorkflowError(
        "ILLEGAL_TRANSITION",
        "The task plan can only be written while the task_planning phase is RUNNING.",
      );
    }
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new WorkflowError("NO_TASKS", "The task plan needs at least one task.");
    }
    if (tasks.length > 15) {
      throw new WorkflowError("INVALID_ARTIFACT", `Task plan is too large (${tasks.length} tasks). Split the change; keep plans small and ordered.`);
    }
    const existing = this.db.listTasks(w.change_id);
    if (existing.length > 0 && !replace) {
      throw new WorkflowError(
        "ILLEGAL_TRANSITION",
        `A task plan with ${existing.length} task(s) already exists. Pass replace=true to overwrite it.`,
      );
    }
    const problems: string[] = [];
    for (const [i, t] of tasks.entries()) {
      for (const field of ["title", "scope", "references", "verification"] as const) {
        if (!t[field] || !t[field].trim()) problems.push(`task ${i + 1}: missing "${field}"`);
      }
    }
    if (problems.length > 0) {
      throw new WorkflowError("INVALID_ARTIFACT", "Invalid task plan:\n  - " + problems.join("\n  - "));
    }
    const records: TaskRecord[] = tasks.map((t, i) => ({
      change_id: w.change_id,
      seq: i + 1,
      title: t.title.trim(),
      scope: t.scope.trim(),
      references: t.references.trim(),
      verification: t.verification.trim(),
      status: "PENDING",
      evidence: null,
    }));
    const at = this.now();
    this.db.tx(() => {
      this.db.setTasks(w.change_id, records);
      this.db.insertEvent(w.id, w.change_id, "task_planning", "TASK_PLAN_SET", `${records.length} task(s) recorded`, at);
    });
    return records;
  }

  /** Implementation phase only: sequential task progress; DONE requires evidence. */
  updateTask(seq: number, status: TaskStatus, evidence: string): TaskRecord {
    const w = this.requireActive();
    if (w.current_phase !== "implementation" || w.status !== "RUNNING") {
      throw new WorkflowError(
        "ILLEGAL_TRANSITION",
        "Tasks can only be updated while the implementation phase is RUNNING.",
      );
    }
    if (status === "DONE" && !evidence.trim()) {
      throw new WorkflowError(
        "TASKS_INCOMPLETE",
        `Task ${seq} cannot be marked DONE without verification evidence (command + result).`,
      );
    }
    const prev = this.db.listTasks(w.change_id);
    const cur = prev.find((t) => t.seq === seq);
    if (!cur) throw new WorkflowError("CHANGE_NOT_FOUND", `Task ${seq} does not exist in the plan.`);
    const ev = status === "DONE" ? evidence.trim() : cur.evidence;
    this.db.tx(() => {
      this.db.updateTask(w.change_id, seq, status, ev);
      this.db.insertEvent(w.id, w.change_id, "implementation", "TASK_UPDATED", `task ${seq} -> ${status}`, this.now());
    });
    return { ...cur, status, evidence: ev };
  }

  /** Verification phase only: record a check result. */
  recordCheck(name: string, required: boolean, status: CheckStatus, output: string): CheckRecord {
    const w = this.requireActive();
    if (w.current_phase !== "verification" || w.status !== "RUNNING") {
      throw new WorkflowError(
        "ILLEGAL_TRANSITION",
        "Checks can only be recorded while the verification phase is RUNNING.",
      );
    }
    const nm = name.trim();
    if (!nm) throw new WorkflowError("REASON_REQUIRED", "A check name is required.");
    const rec: CheckRecord = {
      change_id: w.change_id,
      name: nm,
      required,
      status,
      output: output.trim() ? output.trim().slice(0, 4000) : null,
      updated_at: this.now(),
    };
    this.db.tx(() => {
      this.db.upsertCheck(rec);
      this.db.insertEvent(w.id, w.change_id, "verification", "CHECK_RECORDED", `${nm} -> ${status}`, rec.updated_at);
    });
    return rec;
  }

  listTasks(): TaskRecord[] {
    const w = this.requireActive();
    return this.db.listTasks(w.change_id);
  }

  listWorkflows(): WorkflowRecord[] {
    return this.db.listWorkflows();
  }

  listChecks(): CheckRecord[] {
    const w = this.requireActive();
    return this.db.listChecks(w.change_id);
  }
}

/** sha256 or null when the file does not exist (for pre-validated paths). */
function sha256Safe(absPath: string): string | null {
  try {
    return sha256File(absPath);
  } catch (e) {
    if (e instanceof WorkflowError && e.code === "MISSING_ARTIFACT") return null;
    throw e;
  }
}
