import type { Phase } from "../workflow/phases.ts";
import type { ParsedDocument, ParsedRecord, ValidationIssue } from "../artifacts/artifact-types.ts";
import { normalizeId } from "../artifacts/traceability-validator.ts";
import { FIELD_ALLOWED_PREFIXES, PREFIX_ITEM_TYPE, relationForPair } from "./relations.ts";
import type { TraceGraph, TraceItem, TraceLink } from "./types.ts";

/**
 * Deterministic extraction of the traceability graph from PARSED artifacts.
 *
 * Inputs are normalized parsed documents (the same parser the gate uses), so
 * the graph is reproducible for any pinned revision: same file → same graph.
 * The graph is DERIVED, not stored separately — the immutable, content-hashed
 * artifact files remain the single source of truth (documented decision).
 *
 * This module also enforces the RELATIONSHIP CONTRACT on the declared links:
 *  - TRACE_INVALID_RELATION   — an item cites a prefix its field may not cite
 *  - TRACE_UNKNOWN_ITEM       — a link target does not exist in the graph
 *  - TRACE_DUPLICATE_ITEM_ID  — the same id used for two different items
 */

export interface GraphInput {
  phase: Phase;
  artifactType: string;
  revision: number;
  approved: boolean;
  parsed: ParsedDocument;
}

export interface ExtractedGraph {
  graph: TraceGraph;
  issues: ValidationIssue[];
}

const ID_RE = /\b(REQ|FR|AC|DES|TASK|CHK)-(\d+)\b/g;

function mkIssue(artifactType: string, code: string, severity: ValidationIssue["severity"], message: string, opts: { section?: string; relatedId?: string; line?: number; suggestedFix?: string } = {}): ValidationIssue {
  return {
    code,
    severity,
    message,
    artifactType,
    rule: "traceability",
    section: opts.section,
    line: opts.line,
    relatedId: opts.relatedId,
    suggestedFix: opts.suggestedFix,
  };
}

function relationFor(source: TraceItem["itemType"], targetPrefix: string): TraceLink["relation"] {
  // Only called for pairs that passed contract validation.
  return relationForPair(source, targetPrefix) ?? "IMPLEMENTS";
}

export function extractTraceGraph(changeId: string, inputs: GraphInput[]): ExtractedGraph {
  const items: TraceItem[] = [];
  const links: TraceLink[] = [];
  const issues: ValidationIssue[] = [];
  const itemKey = new Map<string, TraceItem>(); // `${artifactType}:${itemId}` → item (duplicate detection)

  const add = (it: TraceItem): TraceItem | null => {
    const key = `${it.artifactType}:${it.id}`;
    const existing = itemKey.get(key);
    if (existing) {
      issues.push(
        mkIssue(it.artifactType, "TRACE_DUPLICATE_ITEM_ID", "ERROR",
          `Item id ${it.id} is used for two different items in ${it.artifactType} (line ${existing.line} and line ${it.line}); an id must not be reused for a different logical item.`,
          { relatedId: it.id, line: it.line }),
      );
      return null;
    }
    itemKey.set(key, it);
    items.push(it);
    return it;
  };

  for (const input of inputs) {
    const { artifactType, revision, approved, parsed } = input;
    const base = { changeId, artifactType, phase: input.phase, artifactRevision: revision, approved };

    const records = (section: string): ParsedRecord[] => parsed.sections[section]?.records ?? [];

    // ---- items ------------------------------------------------------------
    for (const r of records("Requirements")) {
      add({ ...base, itemType: "requirement", id: normalizeId(r.id), title: r.title, priority: r.fields["Priority"], line: r.line });
    }
    for (const r of records("Functional Requirements")) {
      add({ ...base, itemType: "functional_requirement", id: normalizeId(r.id), title: r.title, line: r.line });
    }
    for (const r of records("Acceptance Criteria")) {
      add({ ...base, itemType: "acceptance_criterion", id: normalizeId(r.id), title: r.title, line: r.line });
    }
    for (const r of records("Design Decisions")) {
      add({ ...base, itemType: "design_decision", id: normalizeId(r.id), title: r.title, line: r.line });
    }
    for (const r of records("Tasks")) {
      add({ ...base, itemType: "task", id: normalizeId(r.id), title: r.title, line: r.line });
    }
    for (const r of records("Task Results")) {
      add({ ...base, itemType: "implementation_result", id: normalizeId(r.id), title: r.title, status: r.fields["Status"], evidence: r.fields["Evidence"] ?? "", line: r.line });
    }
    for (const r of records("Checks")) {
      add({ ...base, itemType: "verification_check", id: normalizeId(r.id), title: r.title, status: r.fields["Status"], evidence: r.fields["Evidence"] ?? "", required: r.fields["Required"] === "yes", line: r.line });
    }

    // ---- links (contract-validated; unknown endpoints reported, not guessed)
    const linkRecords = (
      section: string,
      field: string,
      sourceType: TraceItem["itemType"],
      splitMulti = false,
    ) => {
      const allowed = FIELD_ALLOWED_PREFIXES[`${artifactType}:${section}:${field}`] ?? [];
      for (const r of records(section)) {
        const value = r.fields[field];
        if (value === undefined) continue;
        const srcId = normalizeId(r.id);
        const parts = splitMulti ? value.split(",").map((p) => p.trim()).filter(Boolean) : [value];
        for (const part of parts) {
          for (const m of part.matchAll(ID_RE)) {
            const norm = normalizeId(m[0]!);
            const prefix = m[1]!;
            if (!allowed.includes(prefix)) {
              issues.push(
                mkIssue(artifactType, "TRACE_INVALID_RELATION", "ERROR",
                  `${srcId} cites ${norm} in "${section} → ${field}", but a ${sourceType} may only cite: ${allowed.join(", ")}. The relationship contract does not allow this endpoint.`,
                  { section, relatedId: srcId, line: r.fieldLines[field], suggestedFix: `Cite only ${allowed.join("/")} ids in this field (or "None identified" when there are none).` }),
              );
              continue;
            }
            links.push({
              relation: relationFor(sourceType, prefix),
              source: { itemType: sourceType, id: srcId },
              target: { itemType: PREFIX_ITEM_TYPE[prefix]!, id: norm },
              line: r.fieldLines[field],
            });
          }
        }
      }
    };

    if (artifactType === "spec") {
      linkRecords("Functional Requirements", "References", "functional_requirement");
      linkRecords("Acceptance Criteria", "References", "acceptance_criterion");
    } else if (artifactType === "design") {
      linkRecords("Design Decisions", "References", "design_decision");
    } else if (artifactType === "task-plan") {
      linkRecords("Tasks", "References", "task");
      linkRecords("Tasks", "Dependencies", "task", true);
    } else if (artifactType === "verification-report") {
      linkRecords("Checks", "Reference", "verification_check");
    }
  }

  return { graph: { changeId, items, links }, issues };
}
