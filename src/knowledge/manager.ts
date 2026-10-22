import path from "node:path";
import { WorkflowError } from "../workflow/errors.ts";
import { writeArtifactAtomic, readFileOrNull } from "../artifacts/artifact-store.ts";
import type { Database } from "../persistence/database.ts";
import { knowledgeSchemaErrors } from "./schema.ts";
import {
  knowledgeDir,
  knowledgeJsonFile,
  knowledgeMdFile,
  nextKnowledgeId,
  scanKnowledgeFiles,
  isKnowledgeId,
  saveKnowledgeJson,
  type ScannedKnowledgeFile,
} from "./store.ts";
import { allowedTransitions, assertTransition, approvalTarget } from "./lifecycle.ts";
import { renderKnowledgeMarkdown, RENDERER_VERSION } from "./renderer.ts";
import {
  KNOWLEDGE_SUBDIR,
  KNOWLEDGE_TYPES,
  KNOWLEDGE_TYPE_LABEL,
  type ConstraintDoc,
  type ConventionDoc,
  type KnowledgeDoc,
  type KnowledgeScope,
  type KnowledgeType,
  type TechDecisionDoc,
} from "./types.ts";

/**
 * KnowledgeManager: the extension-side authority for Project Knowledge.
 *
 * - JSON under .factory/knowledge/ is canonical; Markdown under
 *   .factory/generated/knowledge/ is a deterministic render of it.
 * - Drafts arrive from the LLM through the factory_knowledge_draft tool and
 *   are UNTRUSTED until schema + semantic validation passes in THIS class.
 *   The extension forces status to "draft" and owns identifier allocation.
 * - Only extension operations (approve / deprecate / reject, called from the
 *   human-facing /factory knowledge command) change the effective status.
 * - Every mutation validates BEFORE any write; a failed operation leaves the
 *   previous state untouched and is reported, never swallowed.
 */

export interface KnowledgeDraftMeta {
  /** Source change id for traceability (requirement phase), if any. */
  changeId?: string | null;
  /** Source requirement history entry (e.g. "R3"), if any. */
  requirementRef?: string | null;
  /** Where the draft came from: the requirement phase or the add command. */
  source?: string;
}

export interface KnowledgeItemView {
  type: KnowledgeType;
  id: string;
  title: string;
  status: string;
  scope: string;
  jsonRel: string;
  mdRel: string;
}

export interface KnowledgeFileError {
  file: string;
  error: string;
}

export interface KnowledgeCreateResult {
  type: KnowledgeType;
  id: string;
  revised: boolean;
  statusForcedFrom: string | null;
  doc: KnowledgeDoc;
  jsonRel: string;
  mdRel: string;
  markdown: string;
}

export interface KnowledgeShowResult {
  type: KnowledgeType;
  doc: KnowledgeDoc;
  jsonRel: string;
  mdRel: string;
  markdown: string | null;
  markdownState: "ok" | "missing" | "out-of-sync";
  supersedes: string | null;
  supersededBy: string[];
  events: Array<{ kind: string; changeId: string | null; detail: string | null; createdAt: string }>;
}

export interface KnowledgeTransitionResult {
  type: KnowledgeType;
  changes: Array<{ id: string; from: string; to: string }>;
  jsonRel: string;
  mdRel: string;
  markdown: string;
}

export interface KnowledgeValidationItem {
  file: string;
  type: KnowledgeType;
  id: string | null;
  status: string | null;
  errors: string[];
  warnings: string[];
  markdownState: "ok" | "missing" | "out-of-sync";
}

export interface KnowledgeValidationReport {
  items: KnowledgeValidationItem[];
  globalErrors: string[];
  globalWarnings: string[];
}

export class KnowledgeManager {
  constructor(private root: string, private db: Database) {}

  private now(): string {
    return new Date().toISOString();
  }

  /** Convert low-level fs failures into the canonical PERSISTENCE_ERROR. */
  private persist(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      throw new WorkflowError(
        "PERSISTENCE_ERROR",
        `${what}: ${e instanceof Error ? e.message : e}. The previous on-disk state was left unchanged — ` +
          `run /factory knowledge validate to check the current state.`,
      );
    }
  }

  private logEvent(knowledgeId: string, kind: string, changeId: string | null, detail: string | null): void {
    try {
      this.db.insertKnowledgeEvent(knowledgeId, kind, changeId, detail, this.now());
    } catch {
      /* the audit log must never break a validated knowledge operation */
    }
  }

  // ------------------------------------------------------------- listing

  private scan(): ScannedKnowledgeFile[] {
    return scanKnowledgeFiles(this.root, KNOWLEDGE_TYPES);
  }

  private validDoc(entry: ScannedKnowledgeFile): { doc: KnowledgeDoc; errors: string[] } {
    if (!entry.doc) return { doc: null as unknown as KnowledgeDoc, errors: entry.parseError ? [`malformed JSON: ${entry.parseError}`] : ["file has no JSON object"] };
    const errors = knowledgeSchemaErrors(entry.type, entry.doc);
    return { doc: entry.doc as unknown as KnowledgeDoc, errors };
  }

  /**
   * List knowledge records. Malformed files are reported as errors, and the
   * remaining valid records are still returned (one bad record never hides
   * the rest).
   */
  listKnowledge(filter: { type?: KnowledgeType; status?: string } = {}): { items: KnowledgeItemView[]; errors: KnowledgeFileError[] } {
    const items: KnowledgeItemView[] = [];
    const errors: KnowledgeFileError[] = [];
    for (const entry of this.scan()) {
      if (filter.type && entry.type !== filter.type) continue;
      const { doc, errors: schemaErrors } = this.validDoc(entry);
      const hard = [...(entry.parseError ? [entry.parseError] : []), ...schemaErrors];
      if (hard.length > 0) {
        errors.push({ file: entry.relPath, error: hard.join("; ") });
        continue;
      }
      const status = (doc as { status: string }).status;
      if (filter.status && status !== filter.status) continue;
      items.push({
        type: entry.type,
        id: (doc as { id: string }).id,
        title: (doc as { title: string }).title,
        status,
        scope: scopeText((doc as { scope: KnowledgeScope }).scope),
        jsonRel: entry.relPath,
        mdRel: `.factory/generated/knowledge/${KNOWLEDGE_SUBDIR[entry.type]}/${(doc as { id: string }).id}.md`,
      });
    }
    items.sort((a, b) => a.id.localeCompare(b.id));
    return { items, errors };
  }

  /** One-line summary per record for phase prompts (effective + candidate drafts). */
  summaryForPrompt(): string {
    const { items, errors } = this.listKnowledge();
    const lines: string[] = [];
    for (const it of items) {
      lines.push(`- ${it.id} [${it.status}] (${it.scope}) ${it.title} — ${it.jsonRel}`);
    }
    for (const e of errors) {
      lines.push(`- (malformed ${e.file}: ${e.error})`);
    }
    return lines.join("\n");
  }

  /** Locate a record by id across all types. Throws CHANGE_NOT_FOUND. */
  private locate(id: string): { entry: ScannedKnowledgeFile; doc: KnowledgeDoc } {
    const scan = this.scan();
    const hits = scan.filter((e) => e.docId === id || e.fileBaseId === id);
    if (hits.length === 0) {
      throw new WorkflowError("CHANGE_NOT_FOUND", `No Project Knowledge record with id "${id}". List records with: /factory knowledge list`);
    }
    if (hits.length > 1) {
      throw new WorkflowError("INVALID_ARTIFACT", `Ambiguous id "${id}": ${hits.length} files match (${hits.map((h) => h.relPath).join(", ")}). Run /factory knowledge validate to inspect duplicates.`);
    }
    const entry = hits[0]!;
    const { doc, errors } = this.validDoc(entry);
    if (errors.length > 0) {
      throw new WorkflowError("INVALID_ARTIFACT", `Knowledge record ${id} is not valid and the operation was refused:\n  - ${errors.join("\n  - ")}`);
    }
    return { entry, doc };
  }

  getKnowledge(id: string): KnowledgeShowResult {
    const { entry, doc } = this.locate(id);
    const mdPath = knowledgeMdFile(this.root, entry.type, id);
    const markdown = readFileOrNull(mdPath);
    let markdownState: KnowledgeShowResult["markdownState"];
    if (markdown === null) markdownState = "missing";
    else if (markdown === renderKnowledgeMarkdown(entry.type, doc)) markdownState = "ok";
    else markdownState = "out-of-sync";

    const supersedes = entry.type === "tech-decision" ? (doc as TechDecisionDoc).supersedes : null;
    const supersededBy: string[] = [];
    if (entry.type === "tech-decision") {
      for (const e of this.scan()) {
        if (e.type !== "tech-decision" || !e.doc || e.docId === id) continue;
        if ((e.doc as { supersedes?: unknown }).supersedes === id) supersededBy.push(e.docId ?? e.fileBaseId ?? e.relPath);
      }
    }
    return {
      type: entry.type,
      doc,
      jsonRel: entry.relPath,
      mdRel: path.relative(this.root, mdPath),
      markdown,
      markdownState,
      supersedes,
      supersededBy,
      events: this.db.listKnowledgeEvents(id),
    };
  }

  // ------------------------------------------------------------- drafts

  /**
   * Persist a validated LLM/agent draft (forced status "draft").
   * Nothing is written until schema + semantic validation passes.
   */
  createDraft(type: KnowledgeType, rawDoc: unknown, meta: KnowledgeDraftMeta = {}): KnowledgeCreateResult {
    if (!rawDoc || typeof rawDoc !== "object" || Array.isArray(rawDoc)) {
      throw new WorkflowError("INVALID_ARTIFACT", `The knowledge draft for type "${type}" is not a JSON object. Submit an object conforming to the ${KNOWLEDGE_TYPE_LABEL[type]} schema.`);
    }
    const doc: Record<string, unknown> = { ...(rawDoc as Record<string, unknown>) };
    const rawStatus = typeof doc.status === "string" ? (doc.status as string) : null;

    // Extension ownership: the agent can never self-approve or set a
    // lifecycle state. The record always enters as "draft".
    const forced = rawStatus !== null && rawStatus !== "draft" ? rawStatus : null;
    doc.status = "draft";

    // Extension-controlled identifier allocation / revision targeting.
    const scan = this.scan();
    const requestedId = typeof doc.id === "string" ? (doc.id as string) : "";
    let id: string;
    let revised = false;
    if (requestedId && isKnowledgeId(type, requestedId)) {
      const existing = scan.filter((e) => e.type === type && (e.docId === requestedId || e.fileBaseId === requestedId));
      if (existing.length > 1) {
        throw new WorkflowError("INVALID_ARTIFACT", `Cannot create draft: duplicate id "${requestedId}" (${existing.map((e) => e.relPath).join(", ")}). Run /factory knowledge validate.`);
      }
      if (existing.length === 1) {
        const ex = existing[0]!;
        const exDoc = ex.doc ? (ex.doc as { status?: unknown }) : null;
        if (exDoc && exDoc.status !== "draft") {
          throw new WorkflowError(
            "INVALID_ARTIFACT",
            `Cannot overwrite knowledge record ${requestedId}: it is in status "${String(exDoc.status)}", not "draft". ` +
              "Effective or terminal records are never overwritten by a draft. Allocate a new record instead (omit the id).",
          );
        }
        id = requestedId;
        revised = true;
      } else if (scan.some((e) => e.type !== type && (e.docId === requestedId || e.fileBaseId === requestedId))) {
        throw new WorkflowError("INVALID_ARTIFACT", `Id collision: "${requestedId}" is already used by a record of another type.`);
      } else {
        id = requestedId; // a valid, unused id of the right prefix is accepted as-is
      }
    } else {
      // No id, or an id that is not a valid identifier of this type: the
      // extension allocates the next free id of the correct sequence.
      id = nextKnowledgeId(this.root, type);
    }
    doc.id = id;

    // Structural validation against the pinned schema (agent content is untrusted).
    const schemaErrors = knowledgeSchemaErrors(type, doc);
    if (schemaErrors.length > 0) {
      throw new WorkflowError(
        "INVALID_ARTIFACT",
        `Knowledge draft ${id} FAILED schema validation (nothing was persisted):\n  - ${schemaErrors.join("\n  - ")}\n` +
          `Fix the document against the ${KNOWLEDGE_TYPE_LABEL[type]} schema and call factory_knowledge_draft again.`,
      );
    }

    // Semantic checks beyond the schema (uniqueness, scope, references).
    const semantic = this.semanticChecks(type, doc as unknown as KnowledgeDoc, scan, id);
    if (semantic.errors.length > 0) {
      throw new WorkflowError(
        "INVALID_ARTIFACT",
        `Knowledge draft ${id} FAILED semantic validation (nothing was persisted):\n  - ${semantic.errors.join("\n  - ")}`,
      );
    }

    const validated = doc as unknown as KnowledgeDoc;
    const markdown = renderKnowledgeMarkdown(type, validated);

    // Persist canonical JSON first (atomic), then the generated Markdown.
    this.persist(`Knowledge record ${id}: writing the canonical JSON failed (nothing was persisted)`, () =>
      saveKnowledgeJson(this.root, type, id, validated),
    );
    let markdownRel: string;
    try {
      const mdFile = knowledgeMdFile(this.root, type, id);
      writeArtifactAtomic(mdFile, markdown);
      const back = readFileOrNull(mdFile);
      if (back !== markdown) throw new Error("markdown write did not round-trip");
      markdownRel = path.relative(this.root, mdFile);
    } catch (e) {
      throw new WorkflowError(
        "PERSISTENCE_ERROR",
        `Knowledge record ${id}: the canonical JSON was persisted, but generated Markdown could not be written ` +
          `(${e instanceof Error ? e.message : e}). The record is INCOMPLETE — fix the file system problem and run ` +
          `/factory knowledge regenerate ${id}. This is NOT a successful update.`,
      );
    }

    this.logEvent(
      id,
      revised ? "DRAFT_REVISED" : "DRAFT_CREATED",
      meta.changeId ?? null,
      `type=${type} source=${meta.source ?? "manual"}${meta.requirementRef ? ` req=${meta.requirementRef}` : ""}` +
        (forced ? ` (agent-supplied status "${forced}" forced to draft)` : ""),
    );
    return {
      type,
      id,
      revised,
      statusForcedFrom: forced,
      doc: validated,
      jsonRel: path.relative(this.root, knowledgeJsonFile(this.root, type, id)),
      mdRel: markdownRel,
      markdown,
    };
  }

  // ------------------------------------------------------------- transitions

  /**
   * Human-only approval: draft/proposed -> approved (constraint/convention)
   * or accepted (tech-decision). Validates the current on-disk document first;
   * an ADR that supersedes another accepted ADR transitions the old record to
   * "superseded" in the same operation (the old record is preserved, never deleted).
   */
  approve(id: string, comment?: string): KnowledgeTransitionResult {
    const { entry, doc } = this.locate(id);
    const type = entry.type;
    const from = (doc as { status: string }).status;
    const to = approvalTarget(type);
    assertTransition(type, id, from, to);

    const changes: Array<{ id: string; from: string; to: string }> = [];

    // Supersession cascade: the replaced decision must move accepted -> superseded.
    let oldChange: { entry: ScannedKnowledgeFile; doc: TechDecisionDoc } | null = null;
    if (type === "tech-decision") {
      const targetId = (doc as TechDecisionDoc).supersedes;
      if (targetId) {
        const target = this.locate(targetId);
        if (target.entry.type !== "tech-decision") {
          throw new WorkflowError("INVALID_ARTIFACT", `supersedes references ${targetId}, which is not a tech decision.`);
        }
        const oldStatus = (target.doc as { status: string }).status;
        if (oldStatus !== "accepted") {
          throw new WorkflowError(
            "ILLEGAL_TRANSITION",
            `Cannot approve ${id}: the decision it supersedes (${targetId}) is "${oldStatus}", not "accepted". Only an accepted decision can be superseded.`,
          );
        }
        assertTransition("tech-decision", targetId, oldStatus, "superseded");
        oldChange = { entry: target.entry, doc: { ...(target.doc as TechDecisionDoc), status: "superseded" } };
        changes.push({ id: targetId, from: oldStatus, to: "superseded" });
      }
    }

    const newDoc: KnowledgeDoc = { ...(doc as object), status: to } as KnowledgeDoc;
    const markdown = renderKnowledgeMarkdown(type, newDoc);

    // All validation is done — now write (canonical JSON first, then Markdown,
    // for each affected record). A failure here leaves only PARTIALLY updated
    // files and is reported loudly; transitions themselves were pre-validated.
    this.persist(`Approval of ${id} could not be persisted`, () => {
      if (oldChange) {
        saveKnowledgeJson(this.root, "tech-decision", oldChange.doc.id, oldChange.doc);
        writeArtifactAtomic(knowledgeMdFile(this.root, "tech-decision", oldChange.doc.id), renderKnowledgeMarkdown("tech-decision", oldChange.doc));
      }
      saveKnowledgeJson(this.root, type, id, newDoc);
      writeArtifactAtomic(knowledgeMdFile(this.root, type, id), markdown);
    });

    this.logEvent(id, type === "tech-decision" ? "KNOWLEDGE_ACCEPTED" : "KNOWLEDGE_APPROVED", null, `${from} -> ${to}${comment ? ` — ${comment}` : ""}`);
    if (oldChange) {
      this.logEvent(oldChange.doc.id, "KNOWLEDGE_SUPERSEDED", null, `superseded by ${id}`);
    }
    return {
      type,
      changes: [...changes, { id, from, to }],
      jsonRel: entry.relPath,
      mdRel: path.relative(this.root, knowledgeMdFile(this.root, type, id)),
      markdown: oldChange ? markdown + "\n\n---\n\nSuperseded record also updated:\n\n" + renderKnowledgeMarkdown("tech-decision", oldChange.doc) : markdown,
    };
  }

  /**
   * Human-only deprecation. Constraint/convention -> deprecated (record and
   * references preserved). Tech decision -> withdrawn (no replacement);
   * replacement instead happens by accepting a new ADR that supersedes it.
   */
  deprecate(id: string): KnowledgeTransitionResult {
    const { entry, doc } = this.locate(id);
    const type = entry.type;
    const from = (doc as { status: string }).status;
    const to = type === "tech-decision" ? "withdrawn" : "deprecated";
    assertTransition(type, id, from, to);
    const newDoc = { ...(doc as object), status: to } as KnowledgeDoc;
    const markdown = renderKnowledgeMarkdown(type, newDoc);
    this.persist(`Deprecation of ${id} could not be persisted`, () => {
      saveKnowledgeJson(this.root, type, id, newDoc);
      writeArtifactAtomic(knowledgeMdFile(this.root, type, id), markdown);
    });
    this.logEvent(id, type === "tech-decision" ? "KNOWLEDGE_WITHDRAWN" : "KNOWLEDGE_DEPRECATED", null, `${from} -> ${to}`);
    return { type, changes: [{ id, from, to }], jsonRel: entry.relPath, mdRel: path.relative(this.root, knowledgeMdFile(this.root, type, id)), markdown };
  }

  /** Human-only: mark a draft/proposed tech decision rejected (no replacement). */
  rejectDecision(id: string, reason: string): KnowledgeTransitionResult {
    const { entry, doc } = this.locate(id);
    if (entry.type !== "tech-decision") {
      throw new WorkflowError("ILLEGAL_TRANSITION", `"rejected" is a tech-decision state. For constraints/conventions use /factory knowledge deprecate ${id}.`);
    }
    const from = (doc as { status: string }).status;
    const to = "rejected";
    assertTransition(entry.type, id, from, to);
    const newDoc = { ...(doc as object), status: to } as KnowledgeDoc;
    const markdown = renderKnowledgeMarkdown(entry.type, newDoc);
    this.persist(`Rejection of ${id} could not be persisted`, () => {
      saveKnowledgeJson(this.root, entry.type, id, newDoc);
      writeArtifactAtomic(knowledgeMdFile(this.root, entry.type, id), markdown);
    });
    this.logEvent(id, "KNOWLEDGE_REJECTED", null, `${from} -> ${to}${reason ? ` — ${reason}` : ""}`);
    return { type: entry.type, changes: [{ id, from, to }], jsonRel: entry.relPath, mdRel: path.relative(this.root, knowledgeMdFile(this.root, entry.type, id)), markdown };
  }

  /** Re-render the generated Markdown from the canonical JSON (out-of-sync repair). */
  regenerateMarkdown(id: string): { id: string; mdRel: string; markdown: string } {
    const { entry, doc } = this.locate(id);
    const markdown = renderKnowledgeMarkdown(entry.type, doc);
    const mdFile = knowledgeMdFile(this.root, entry.type, id);
    this.persist(`Regenerating Markdown for ${id} failed`, () => writeArtifactAtomic(mdFile, markdown));
    this.logEvent(id, "MARKDOWN_REGENERATED", null, `renderer v${RENDERER_VERSION}`);
    return { id, mdRel: path.relative(this.root, mdFile), markdown };
  }

  // ------------------------------------------------------------- validation

  /**
   * Full validation of one record or the whole knowledge base:
   * JSON syntax, schema, id consistency, referential integrity, Markdown
   * sync, duplicates, and detectable lifecycle/reference inconsistencies.
   * Structural problems are errors; softer issues are warnings. Natural-
   * language conflicts are NOT claimed to be fully detected.
   */
  validateKnowledge(id?: string): KnowledgeValidationReport {
    const scan = this.scan();
    const items: KnowledgeValidationItem[] = [];
    const globalErrors: string[] = [];
    const globalWarnings: string[] = [];

    const targets = id ? scan.filter((e) => e.docId === id || e.fileBaseId === id) : scan;
    if (id && targets.length === 0) {
      throw new WorkflowError("CHANGE_NOT_FOUND", `No Project Knowledge record with id "${id}".`);
    }

    // Duplicate detection across the whole base (duplicates are a global problem).
    const byDocId = new Map<string, ScannedKnowledgeFile[]>();
    for (const e of scan) {
      if (e.docId) {
        const arr = byDocId.get(e.docId) ?? [];
        arr.push(e);
        byDocId.set(e.docId, arr);
      }
    }
    for (const [dupId, files] of byDocId) {
      if (files.length > 1) globalErrors.push(`duplicate id "${dupId}" in ${files.map((f) => f.relPath).join(", ")}`);
    }

    for (const entry of targets) {
      const item: KnowledgeValidationItem = {
        file: entry.relPath,
        type: entry.type,
        id: entry.docId ?? entry.fileBaseId,
        status: null,
        errors: [],
        warnings: [],
        markdownState: "missing",
      };
      if (entry.parseError) {
        item.errors.push(`malformed JSON: ${entry.parseError}`);
        items.push(item);
        continue;
      }
      const schemaErrors = knowledgeSchemaErrors(entry.type, entry.doc!);
      item.errors.push(...schemaErrors);
      if (schemaErrors.length > 0) {
        items.push(item);
        continue;
      }
      const doc = entry.doc! as { id?: unknown; status?: unknown; scope?: unknown } & Record<string, unknown>;
      item.status = typeof doc.status === "string" ? doc.status : null;
      const docId = typeof doc.id === "string" ? doc.id : null;

      if (docId && entry.fileBaseId !== docId) {
        item.errors.push(`file name "${entry.fileBaseId ?? entry.relPath}" does not match document id "${docId}"`);
      }
      if (docId && (byDocId.get(docId) ?? []).length > 1) {
        item.errors.push(`duplicate id "${docId}" (also defined elsewhere in the knowledge base)`);
      }

      // Semantic checks (reuse create-time logic in read-only mode).
      const semantic = this.semanticChecks(entry.type, entry.doc as unknown as KnowledgeDoc, scan, docId ?? entry.fileBaseId ?? "?", { readOnly: true });
      item.errors.push(...semantic.errors);
      item.warnings.push(...semantic.warnings);

      // Markdown projection consistency: Markdown = Render(JSON, version).
      const mdFile = knowledgeMdFile(this.root, entry.type, docId ?? entry.fileBaseId ?? "UNKNOWN");
      const md = readFileOrNull(mdFile);
      if (md === null) {
        item.markdownState = "missing";
        item.warnings.push(`generated Markdown is missing — run /factory knowledge regenerate ${docId}`);
      } else if (md === renderKnowledgeMarkdown(entry.type, entry.doc as unknown as KnowledgeDoc)) {
        item.markdownState = "ok";
      } else {
        item.markdownState = "out-of-sync";
        item.errors.push(
          `generated Markdown is out of sync with the canonical JSON (manually edited or stale). ` +
            `Restore it with /factory knowledge regenerate ${docId}.`,
        );
      }
      items.push(item);
    }

    // Global consistency: accepted ADR whose superseded-by record is still accepted.
    if (!id) {
      const acceptedAdr = scan.filter((e) => e.type === "tech-decision" && e.doc && (e.doc as { status?: unknown }).status === "accepted");
      for (const a of acceptedAdr) {
        const sup = (a.doc as { supersedes?: unknown }).supersedes;
        if (typeof sup === "string" && sup) {
          const target = scan.find((e) => e.type === "tech-decision" && e.docId === sup);
          if (target && (target.doc as { status?: unknown } | null)?.status === "accepted") {
            globalErrors.push(`${a.docId ?? a.relPath} is accepted but still lists "${sup}" (also accepted) as superseded — resolve the supersession`);
          }
        }
      }
      if (acceptedAdr.filter((e) => (e.doc as { scope?: unknown }).scope && (e.doc as { scope: { level?: string } }).scope.level === "project").length > 1) {
        globalWarnings.push(
          "multiple accepted tech decisions with project-level scope — verify they do not conflict (natural-language conflicts are not detected automatically)",
        );
      }
    }

    return { items, globalErrors, globalWarnings };
  }

  // ------------------------------------------------------------- semantic checks

  /**
   * Semantic validation beyond the JSON Schema: scope consistency, validator
   * coherence, and ADR supersedes reference integrity.
   * In readOnly mode, reference problems are warnings for records that were
   * never extension-validated (historical files); otherwise they are errors.
   */
  private semanticChecks(
    type: KnowledgeType,
    doc: KnowledgeDoc,
    scan: ScannedKnowledgeFile[],
    selfId: string,
    opts: { readOnly?: boolean } = {},
  ): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const scope = (doc as { scope: KnowledgeScope }).scope;

    if (scope.level === "project" && scope.paths.length > 0) {
      errors.push(`scope inconsistent: level "project" must not specify narrower paths (${scope.paths.join(", ")})`);
    }
    if (scope.level !== "project" && scope.paths.length === 0) {
      errors.push(`scope inconsistent: level "${scope.level}" requires at least one path`);
    }
    for (const p of scope.paths) {
      if (p.startsWith("/") || p.startsWith("..") || p.split(/[\\/]/).some((seg) => seg === "..")) {
        errors.push(`scope path "${p}" is not a repository-relative path`);
      }
    }

    if (type === "constraint") {
      const v = (doc as ConstraintDoc).verification;
      if (v.method === "automated" && v.validator === null) {
        errors.push('verification.method is "automated" but verification.validator is null — name the validator or use agent_review/human_review');
      }
    }

    if (type === "tech-decision") {
      const target = (doc as TechDecisionDoc).supersedes;
      if (target !== null) {
        if (target === selfId) {
          errors.push("supersedes must not reference the record itself");
        } else {
          const found = scan.find((e) => e.docId === target || e.fileBaseId === target);
          if (!found) {
            (opts.readOnly ? warnings : errors).push(`supersedes references "${target}", which does not exist in the knowledge base`);
          } else if (found.type !== "tech-decision") {
            (opts.readOnly ? warnings : errors).push(`supersedes references "${target}", which is a ${found.type}, not a tech decision`);
          } else {
            const tStatus = found.doc ? (found.doc as { status?: unknown }).status : null;
            if (tStatus !== "accepted" && tStatus !== "superseded") {
              (opts.readOnly ? warnings : errors).push(
                `supersedes references "${target}", which is in status "${String(tStatus)}" — only an accepted (or already superseded) decision can be superseded`,
              );
            }
          }
        }
      }
    }

    return { errors, warnings };
  }

  // ------------------------------------------------------------- misc

  /** True when at least one knowledge record exists for the prompt context. */
  hasAnyKnowledge(): boolean {
    return this.scan().length > 0;
  }

  listKnowledgeIds(): string[] {
    return this.scan()
      .map((e) => e.docId ?? e.fileBaseId)
      .filter((x): x is string => typeof x === "string");
  }
}

export function scopeText(scope: { level: string; paths: string[] }): string {
  return scope.level === "project" ? "project" : `${scope.level}: ${scope.paths.join(", ")}`;
}
