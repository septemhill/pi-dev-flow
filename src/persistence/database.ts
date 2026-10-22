import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { WorkflowError } from "../workflow/errors.ts";
import type {
  ApprovalRecord,
  ArtifactRecord,
  CheckRecord,
  EventRecord,
  TaskRecord,
  WaiverRecord,
  WorkflowRecord,
} from "../workflow/state.ts";
import { isPhase, type Phase } from "../workflow/phases.ts";

/**
 * SQLite persistence via node:sqlite (built into the Node runtime pi ships
 * with). A single file at <root>/.factory/factory.db holds workflow state,
 * artifact metadata, approvals, tasks, checks, and the review event log.
 * The artifact FILE contents live next to it under .factory/changes/.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  current_phase TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  pending_approval_id TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  revision INTEGER NOT NULL,
  path TEXT NOT NULL,
  hash TEXT NOT NULL,
  contract TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (change_id, phase, revision)
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  change_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  artifact_revision INTEGER NOT NULL,
  artifact_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  reviewer TEXT,
  review_comment TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS review_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL,
  change_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  scope TEXT NOT NULL,
  task_refs TEXT NOT NULL,
  verification TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  evidence TEXT,
  UNIQUE (change_id, seq)
);
CREATE TABLE IF NOT EXISTS checks (
  change_id TEXT NOT NULL,
  name TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  output TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (change_id, name)
);
CREATE TABLE IF NOT EXISTS validation_results (
  change_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  candidate_hash TEXT NOT NULL,
  valid INTEGER NOT NULL,
  error_count INTEGER NOT NULL,
  warning_count INTEGER NOT NULL,
  template_version TEXT NOT NULL,
  schema_id TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (change_id, phase, candidate_hash)
);
CREATE TABLE IF NOT EXISTS waivers (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  pinned_revisions TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (change_id, item_id, stage, id)
);
CREATE TABLE IF NOT EXISTS knowledge_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  knowledge_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  change_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
`;

function asPhase(v: string): Phase {
  if (!isPhase(v)) {
    throw new WorkflowError("PERSISTENCE_ERROR", `Corrupted workflow state: unknown phase "${v}".`);
  }
  return v;
}

function mapWaiver(r: Record<string, unknown>): WaiverRecord {
  return {
    id: r.id as string,
    change_id: r.change_id as string,
    item_id: r.item_id as string,
    stage: r.stage as WaiverRecord["stage"],
    rationale: r.rationale as string,
    status: r.status as WaiverRecord["status"],
    pinned_revisions: (r.pinned_revisions as string) ?? "{}",
    created_at: r.created_at as string,
  };
}

function mapWorkflow(r: Record<string, unknown>): WorkflowRecord {
  return {
    id: r.id as string,
    change_id: r.change_id as string,
    description: r.description as string,
    current_phase: asPhase(r.current_phase as string),
    status: r.status as WorkflowRecord["status"],
    revision: r.revision as number,
    pending_approval_id: (r.pending_approval_id as string | null) ?? null,
    failure_reason: (r.failure_reason as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

export class Database {
  db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    try {
      this.db = new DatabaseSync(dbPath);
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec(SCHEMA);
      this.migrate();
      // Fail fast on a database that is not a database (corrupted/truncated file).
      this.db.prepare("SELECT count(*) FROM workflows").get();
    } catch (e) {
      throw new WorkflowError(
        "PERSISTENCE_ERROR",
        `Cannot open factory database at ${dbPath}: ${e instanceof Error ? e.message : e}. ` +
          "The file may be corrupted. Do NOT delete it without a backup; fix or restore it, then retry.",
      );
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  /**
   * Additive, idempotent migrations for databases created before a column
   * existed. Legacy rows keep NULL in newly-added columns; that NULL is the
   * legacy marker ("recorded before template-driven validation").
   */
  private migrate(): void {
    const cols = new Set<string>(
      (this.db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has("contract")) {
      this.db.exec("ALTER TABLE artifacts ADD COLUMN contract TEXT");
    }
  }

  /** Run fn inside a single transaction; rollback on throw. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* rollback best effort */
      }
      throw e;
    }
  }

  newId(prefix: string): string {
    return `${prefix}_${randomBytes(8).toString("hex")}`;
  }

  // ---- workflows ----

  insertWorkflow(w: WorkflowRecord): void {
    this.db
      .prepare(
        `INSERT INTO workflows (id, change_id, description, current_phase, status, revision, pending_approval_id, failure_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        w.id, w.change_id, w.description, w.current_phase, w.status,
        w.revision, w.pending_approval_id, w.failure_reason, w.created_at, w.updated_at,
      );
  }

  updateWorkflow(w: WorkflowRecord, expectedRevision: number): void {
    const r = this.db
      .prepare(
        `UPDATE workflows
         SET current_phase = ?, status = ?, revision = ?, pending_approval_id = ?, failure_reason = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(w.current_phase, w.status, w.revision, w.pending_approval_id, w.failure_reason, w.updated_at, w.id, expectedRevision);
    if (r.changes !== 1) {
      throw new WorkflowError(
        "PERSISTENCE_ERROR",
        `Concurrent modification detected on workflow ${w.id} (expected revision ${expectedRevision}).`,
      );
    }
  }

  getWorkflow(id: string): WorkflowRecord | null {
    const r = this.db.prepare("SELECT * FROM workflows WHERE id = ?").get(id);
    return r ? mapWorkflow(r as Record<string, unknown>) : null;
  }

  getWorkflowByChange(changeId: string): WorkflowRecord | null {
    const r = this.db.prepare("SELECT * FROM workflows WHERE change_id = ?").get(changeId);
    return r ? mapWorkflow(r as Record<string, unknown>) : null;
  }

  /** The active workflow: the most recently updated non-COMPLETED one (there is at most one by construction). */
  getActiveWorkflow(): WorkflowRecord | null {
    const r = this.db
      .prepare("SELECT * FROM workflows WHERE status != 'COMPLETED' ORDER BY updated_at DESC, rowid DESC LIMIT 1")
      .get();
    return r ? mapWorkflow(r as Record<string, unknown>) : null;
  }

  listWorkflows(): WorkflowRecord[] {
    const rows = this.db.prepare("SELECT * FROM workflows ORDER BY created_at").all();
    return (rows as Record<string, unknown>[]).map(mapWorkflow);
  }

  // ---- artifacts ----

  insertArtifact(a: ArtifactRecord): void {
    this.db
      .prepare("INSERT INTO artifacts (id, change_id, phase, revision, path, hash, contract, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(a.id, a.change_id, a.phase, a.revision, a.path, a.hash, a.contract, a.created_at);
  }

  latestArtifact(changeId: string, phase: Phase): ArtifactRecord | null {
    const r = this.db
      .prepare("SELECT * FROM artifacts WHERE change_id = ? AND phase = ? ORDER BY revision DESC LIMIT 1")
      .get(changeId, phase);
    if (!r) return null;
    const o = r as Record<string, unknown>;
    return {
      id: o.id as string,
      change_id: o.change_id as string,
      phase: asPhase(o.phase as string),
      revision: o.revision as number,
      path: o.path as string,
      hash: o.hash as string,
      contract: (o.contract as string | null) ?? null,
      created_at: o.created_at as string,
    };
  }

  allArtifacts(changeId: string): ArtifactRecord[] {
    const rows = this.db.prepare("SELECT * FROM artifacts WHERE change_id = ? ORDER BY phase, revision").all(changeId);
    return (rows as Record<string, unknown>[]).map((o) => ({
      id: o.id as string,
      change_id: o.change_id as string,
      phase: asPhase(o.phase as string),
      revision: o.revision as number,
      path: o.path as string,
      hash: o.hash as string,
      contract: (o.contract as string | null) ?? null,
      created_at: o.created_at as string,
    }));
  }

  // ---- approvals ----

  insertApproval(a: ApprovalRecord): void {
    this.db
      .prepare(
        `INSERT INTO approvals (id, workflow_id, change_id, phase, artifact_revision, artifact_hash, status, reviewer, review_comment, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id, a.workflow_id, a.change_id, a.phase, a.artifact_revision, a.artifact_hash,
        a.status, a.reviewer, a.review_comment, a.created_at, a.resolved_at,
      );
  }

  getApproval(id: string): ApprovalRecord | null {
    const r = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
    if (!r) return null;
    const o = r as Record<string, unknown>;
    return {
      id: o.id as string,
      workflow_id: o.workflow_id as string,
      change_id: o.change_id as string,
      phase: asPhase(o.phase as string),
      artifact_revision: o.artifact_revision as number,
      artifact_hash: o.artifact_hash as string,
      status: o.status as ApprovalRecord["status"],
      reviewer: (o.reviewer as string | null) ?? null,
      review_comment: (o.review_comment as string | null) ?? null,
      created_at: o.created_at as string,
      resolved_at: (o.resolved_at as string | null) ?? null,
    };
  }

  /** Set a PENDING approval to INVALIDATED (artifact changed after the request). */
  invalidateApproval(id: string, at: string): void {
    this.db
      .prepare(`UPDATE approvals SET status = 'INVALIDATED', resolved_at = ? WHERE id = ? AND status = 'PENDING'`)
      .run(at, id);
  }

  resolveApproval(id: string, status: "APPROVED" | "REJECTED", reviewer: string, comment: string, at: string): void {
    this.db
      .prepare(`UPDATE approvals SET status = ?, reviewer = ?, review_comment = ?, resolved_at = ? WHERE id = ?`)
      .run(status, reviewer, comment, at, id);
  }

  lastRejection(changeId: string, phase: Phase): ApprovalRecord | null {
    const r = this.db
      .prepare(
        `SELECT * FROM approvals WHERE change_id = ? AND phase = ? AND status = 'REJECTED'
         ORDER BY resolved_at DESC, rowid DESC LIMIT 1`,
      )
      .get(changeId, phase);
    if (!r) return null;
    const o = r as Record<string, unknown>;
    return {
      id: o.id as string,
      workflow_id: o.workflow_id as string,
      change_id: o.change_id as string,
      phase: asPhase(o.phase as string),
      artifact_revision: o.artifact_revision as number,
      artifact_hash: o.artifact_hash as string,
      status: "REJECTED",
      reviewer: (o.reviewer as string | null) ?? null,
      review_comment: (o.review_comment as string | null) ?? null,
      created_at: o.created_at as string,
      resolved_at: (o.resolved_at as string | null) ?? null,
    };
  }

  // ---- events ----

  insertEvent(workflowId: string, changeId: string, phase: Phase, kind: string, detail: string | null, at: string): void {
    this.db
      .prepare("INSERT INTO review_events (workflow_id, change_id, phase, kind, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(workflowId, changeId, phase, kind, detail, at);
  }

  recentEvents(changeId: string, limit = 8): EventRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM review_events WHERE change_id = ? ORDER BY id DESC LIMIT ?")
      .all(changeId, limit);
    return (rows as Record<string, unknown>[]).map((o) => ({
      id: o.id as number,
      workflow_id: o.workflow_id as string,
      change_id: o.change_id as string,
      phase: asPhase(o.phase as string),
      kind: o.kind as string,
      detail: (o.detail as string | null) ?? null,
      created_at: o.created_at as string,
    })).reverse();
  }

  // ---- tasks ----

  setTasks(changeId: string, tasks: TaskRecord[]): void {
    this.db.prepare("DELETE FROM tasks WHERE change_id = ?").run(changeId);
    const ins = this.db.prepare(
      `INSERT INTO tasks (change_id, seq, title, scope, task_refs, verification, status, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const t of tasks) {
      ins.run(changeId, t.seq, t.title, t.scope, t.references, t.verification, t.status, t.evidence);
    }
  }

  listTasks(changeId: string): TaskRecord[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE change_id = ? ORDER BY seq").all(changeId);
    return (rows as Record<string, unknown>[]).map((o) => ({
      change_id: o.change_id as string,
      seq: o.seq as number,
      title: o.title as string,
      scope: o.scope as string,
      references: (o.task_refs as string) ?? "",
      verification: o.verification as string,
      status: o.status as TaskRecord["status"],
      evidence: (o.evidence as string | null) ?? null,
    }));
  }

  updateTask(changeId: string, seq: number, status: TaskRecord["status"], evidence: string | null): void {
    const r = this.db
      .prepare("UPDATE tasks SET status = ?, evidence = ? WHERE change_id = ? AND seq = ?")
      .run(status, evidence, changeId, seq);
    if (r.changes !== 1) {
      throw new WorkflowError("CHANGE_NOT_FOUND", `Task ${seq} does not exist for this change.`);
    }
  }

  // ---- checks ----

  upsertCheck(c: CheckRecord): void {
    this.db
      .prepare(
        `INSERT INTO checks (change_id, name, required, status, output, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (change_id, name) DO UPDATE SET required = excluded.required, status = excluded.status,
           output = excluded.output, updated_at = excluded.updated_at`,
      )
      .run(c.change_id, c.name, c.required ? 1 : 0, c.status, c.output, c.updated_at);
  }

  listChecks(changeId: string): CheckRecord[] {
    const rows = this.db.prepare("SELECT * FROM checks WHERE change_id = ? ORDER BY name").all(changeId);
    return (rows as Record<string, unknown>[]).map((o) => ({
      change_id: o.change_id as string,
      name: o.name as string,
      required: (o.required as number) === 1,
      status: o.status as CheckRecord["status"],
      output: (o.output as string | null) ?? null,
      updated_at: o.updated_at as string,
    }));
  }

  saveValidationResult(
    changeId: string,
    phase: string,
    candidateHash: string,
    result: {
      valid: boolean;
      errorCount: number;
      warningCount: number;
      templateVersion: string;
      schemaId: string;
      parserVersion: string;
      resultJson: string;
    },
  ): void {
    this.db.prepare(
      `INSERT INTO validation_results (change_id, phase, candidate_hash, valid, error_count, warning_count, template_version, schema_id, parser_version, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(change_id, phase, candidate_hash) DO UPDATE SET
         valid = excluded.valid,
         error_count = excluded.error_count,
         warning_count = excluded.warning_count,
         template_version = excluded.template_version,
         schema_id = excluded.schema_id,
         parser_version = excluded.parser_version,
         result_json = excluded.result_json,
         created_at = excluded.created_at`,
    ).run(
      changeId,
      phase,
      candidateHash,
      result.valid ? 1 : 0,
      result.errorCount,
      result.warningCount,
      result.templateVersion,
      result.schemaId,
      result.parserVersion,
      result.resultJson,
      new Date().toISOString(),
    );
  }

  listValidationResults(changeId: string): Array<{
    changeId: string;
    phase: string;
    candidateHash: string;
    valid: boolean;
    errorCount: number;
    warningCount: number;
    templateVersion: string;
    schemaId: string;
    parserVersion: string;
    resultJson: string;
    createdAt: string;
  }> {
    return this.db
      .prepare(
        `SELECT change_id AS changeId, phase, candidate_hash AS candidateHash, valid, error_count AS errorCount, warning_count AS warningCount,
                template_version AS templateVersion, schema_id AS schemaId, parser_version AS parserVersion,
                result_json AS resultJson, created_at AS createdAt
         FROM validation_results WHERE change_id = ? ORDER BY created_at ASC`,
      )
      .all(changeId)
      .map((r) => ({ ...(r as object), valid: Boolean((r as { valid: number }).valid) })) as Array<{
      changeId: string;
      phase: string;
      candidateHash: string;
      valid: boolean;
      errorCount: number;
      warningCount: number;
      templateVersion: string;
      schemaId: string;
      parserVersion: string;
      resultJson: string;
      createdAt: string;
    }>;
  }

  // ---- waivers ----

  /**
   * Grant a coverage waiver. Exactly one ACTIVE waiver per (item, stage);
   * re-granting returns the existing one (idempotent) unless a different
   * rationale is forced, in which case the old one is revoked and replaced.
   */
  addWaiver(w: WaiverRecord): { waiver: WaiverRecord; created: boolean } {
    const existing = this.db
      .prepare("SELECT * FROM waivers WHERE change_id = ? AND item_id = ? AND stage = ? AND status = 'ACTIVE'")
      .get(w.change_id, w.item_id, w.stage);
    if (existing) {
      return { waiver: mapWaiver(existing as Record<string, unknown>), created: false };
    }
    this.db
      .prepare(
        `INSERT INTO waivers (id, change_id, item_id, stage, rationale, status, pinned_revisions, created_at)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      )
      .run(w.id, w.change_id, w.item_id, w.stage, w.rationale, w.pinned_revisions, w.created_at);
    return { waiver: w, created: true };
  }

  revokeWaiver(id: string): boolean {
    const r = this.db.prepare("UPDATE waivers SET status = 'REVOKED' WHERE id = ? AND status = 'ACTIVE'").run(id);
    return (r.changes ?? 0) === 1;
  }

  listWaivers(changeId: string): WaiverRecord[] {
    const rows = this.db.prepare("SELECT * FROM waivers WHERE change_id = ? ORDER BY created_at ASC, id ASC").all(changeId);
    return (rows as Record<string, unknown>[]).map(mapWaiver);
  }

  getWaiver(id: string): WaiverRecord | null {
    const r = this.db.prepare("SELECT * FROM waivers WHERE id = ?").get(id);
    return r ? mapWaiver(r as Record<string, unknown>) : null;
  }

  // ---- knowledge events (Project Knowledge audit log; project-level, no workflow row) ----

  insertKnowledgeEvent(knowledgeId: string, kind: string, changeId: string | null, detail: string | null, at: string): void {
    this.db
      .prepare("INSERT INTO knowledge_events (knowledge_id, kind, change_id, detail, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(knowledgeId, kind, changeId, detail, at);
  }

  listKnowledgeEvents(knowledgeId: string, limit = 10): Array<{ kind: string; changeId: string | null; detail: string | null; createdAt: string }> {
    const rows = this.db
      .prepare("SELECT kind, change_id AS changeId, detail, created_at AS createdAt FROM knowledge_events WHERE knowledge_id = ? ORDER BY id DESC LIMIT ?")
      .all(knowledgeId, limit);
    return (rows as Array<Record<string, unknown>>).map((o) => ({
      kind: o.kind as string,
      changeId: (o.changeId as string | null) ?? null,
      detail: (o.detail as string | null) ?? null,
      createdAt: o.createdAt as string,
    }));
  }
}
