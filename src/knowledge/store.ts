import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { WorkflowError } from "../workflow/errors.ts";
import { assertInside, writeArtifactAtomic, readFileOrNull } from "../artifacts/artifact-store.ts";
import {
  KNOWLEDGE_ID_PREFIX,
  KNOWLEDGE_SUBDIR,
  knowledgeIdPattern,
  type KnowledgeType,
} from "./types.ts";

/**
 * Project Knowledge file storage.
 *
 *   .factory/knowledge/<kind>/<ID>.json                canonical JSON (source of truth)
 *   .factory/generated/knowledge/<kind>/<ID>.md        generated Markdown (projection)
 *
 * - Canonical JSON and generated Markdown are stored separately.
 * - Writes are atomic (temp + rename, via writeArtifactAtomic).
 * - IDs come only from a fixed per-type map; no input can address a path
 *   outside the knowledge tree (assertInside).
 * - A never-expected file (wrong prefix, malformed id) is reported, not deleted.
 */

export const KNOWLEDGE_DIR = "knowledge";
export const GENERATED_KNOWLEDGE_DIR = path.join("generated", "knowledge");

export function knowledgeDir(root: string, type: KnowledgeType): string {
  return knowledgePath(root, path.join(KNOWLEDGE_DIR, KNOWLEDGE_SUBDIR[type]));
}

export function generatedKnowledgeDir(root: string, type: KnowledgeType): string {
  return knowledgePath(root, path.join(GENERATED_KNOWLEDGE_DIR, KNOWLEDGE_SUBDIR[type]));
}

export function knowledgeJsonFile(root: string, type: KnowledgeType, id: string): string {
  return knowledgePath(root, path.join(KNOWLEDGE_DIR, KNOWLEDGE_SUBDIR[type], `${id}.json`));
}

export function knowledgeMdFile(root: string, type: KnowledgeType, id: string): string {
  return knowledgePath(root, path.join(GENERATED_KNOWLEDGE_DIR, KNOWLEDGE_SUBDIR[type], `${id}.md`));
}

function knowledgePath(root: string, rel: string): string {
  const abs = path.join(root, ".factory", rel);
  assertInside(root, abs);
  return abs;
}

export function isKnowledgeId(type: KnowledgeType, id: string): boolean {
  return knowledgeIdPattern(type).test(id);
}

/** Find the type of a bare id by its prefix (or null when ambiguous/unknown). */
export function typeFromId(id: string): KnowledgeType | null {
  for (const type of Object.keys(KNOWLEDGE_SUBDIR) as KnowledgeType[]) {
    if (isKnowledgeId(type, id)) return type;
  }
  return null;
}

export interface ScannedKnowledgeFile {
  type: KnowledgeType;
  /** File-name id (e.g. "CON-001"), null for files whose name does not match. */
  fileBaseId: string | null;
  /** Document id when the JSON parsed and carried one; null otherwise. */
  docId: string | null;
  absPath: string;
  relPath: string;
  raw: string | null;
  /** JSON syntax error message, or null when the file parsed. */
  parseError: string | null;
  doc: Record<string, unknown> | null;
}

/**
 * Scan one or all knowledge types. Never throws on per-file problems:
 * malformed files are reported in the scan result so a single bad record
 * cannot hide the rest of the project knowledge.
 */
export function scanKnowledgeFiles(root: string, types: readonly KnowledgeType[]): ScannedKnowledgeFile[] {
  const out: ScannedKnowledgeFile[] = [];
  for (const type of types) {
    const dir = knowledgeDir(root, type);
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (e) {
      throw new WorkflowError("PERSISTENCE_ERROR", `Cannot read knowledge directory ${dir}: ${e instanceof Error ? e.message : e}`);
    }
    for (const name of entries.sort()) {
      if (!name.endsWith(".json")) continue; // ignore stray non-JSON files (never delete them)
      const base = name.slice(0, -5);
      const abs = path.join(dir, name);
      const rel = path.join(".factory", KNOWLEDGE_DIR, KNOWLEDGE_SUBDIR[type], name);
      const raw = readFileOrNull(abs);
      const entry: ScannedKnowledgeFile = {
        type,
        fileBaseId: isKnowledgeId(type, base) ? base : null,
        docId: null,
        absPath: abs,
        relPath: rel,
        raw,
        parseError: null,
        doc: null,
      };
      if (raw !== null) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as { id?: unknown }).id === "string") {
            entry.docId = (parsed as { id: string }).id;
          }
          entry.doc = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
          if (entry.doc === null) entry.parseError = "top-level JSON is not an object";
        } catch (e) {
          entry.parseError = e instanceof Error ? e.message : String(e);
        }
      } else if (raw === null) {
        entry.parseError = "file is missing or unreadable";
      }
      out.push(entry);
    }
  }
  return out;
}

/**
 * Allocate the next numeric id for a type (PREFIX-001, PREFIX-002, …).
 * The extension — never the LLM — owns identifier allocation.
 */
export function nextKnowledgeId(root: string, type: KnowledgeType): string {
  const prefix = KNOWLEDGE_ID_PREFIX[type];
  let max = 0;
  const dir = knowledgeDir(root, type);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const m = new RegExp(`^${prefix}-(\\d+)\\.json$`).exec(name);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

/** Persist canonical JSON (atomic) and verify it round-trips. */
export function saveKnowledgeJson(root: string, type: KnowledgeType, id: string, doc: unknown): void {
  const file = knowledgeJsonFile(root, type, id);
  const text = JSON.stringify(doc, null, 2) + "\n";
  writeArtifactAtomic(file, text);
  // A failed/corrupt write must never masquerade as success.
  const back = readFileOrNull(file);
  if (back !== text) {
    throw new WorkflowError(
      "PERSISTENCE_ERROR",
      `Knowledge record ${id} could not be verified after writing ${file}; the update was NOT applied.`,
    );
  }
}
