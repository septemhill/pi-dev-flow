import type {
  ArtifactContract,
  ParsedDocument,
  ParsedRecord,
  ParsedSection,
  SectionSpec,
  ValidationIssue,
} from "./artifact-types.ts";

/**
 * Deterministic Markdown → structured-document parser for factory artifacts.
 *
 * Contract (documented to the model in the phase prompt):
 *  - The first non-blank line must be `# <contract title>`.
 *  - Top-level sections are `## ` headings whose text EXACTLY matches a
 *    contract section name. `### ` and deeper headings are section CONTENT,
 *    except inside "records" sections, where `### ID: title` starts a record.
 *  - Sections must appear in the contract's legal order; duplicates, unknown
 *    headings and missing required sections are errors, never guesses.
 *  - "text" sections: any Markdown content (nested headings allowed).
 *  - "list" sections: one `- item` bullet per line.
 *  - "keyvalue" sections: one `- Key: value` bullet per line; keys from the
 *    contract only.
 *  - "records" sections: `### <PREFIX>-<n>: <title>` blocks, each with
 *    contract-defined `- Field: value` bullets (recognized only in the
 *    record's leading bullet run) followed by an optional free-form body.
 *  - HTML comments are template placeholders, not content. A section whose
 *    content is only comments is an untouched placeholder, and an empty
 *    required section is an error unless its content is exactly one of the
 *    documented not-applicable markers (and the section allows it).
 *  - Lines inside fenced code blocks are never parsed as structure.
 *
 * The parser never throws on malformed input: it reports issues with line
 * numbers and returns the best-effort structured document.
 */

/** Documented markers that explicitly satisfy a section (single line, optional reason). */
export const NA_MARKER_RE =
  /^(none identified|none|not applicable|not needed|out of scope|n\/a)([.:\-–—]\s*\S.*)?$/i;

interface ContentLine {
  line: number; // 1-based
  text: string; // non-comment content of the line, not trimmed
}

interface SegLine {
  line: number;
  content: string;
  hadComment: boolean;
}

function issue(
  c: ArtifactContract,
  code: string,
  message: string,
  opts: { section?: string; line?: number; suggestedFix?: string; relatedId?: string; fieldPath?: string } = {},
): ValidationIssue {
  return {
    code,
    severity: "ERROR",
    message,
    artifactType: c.artifactType,
    rule: "structural",
    section: opts.section,
    line: opts.line,
    relatedId: opts.relatedId,
    suggestedFix: opts.suggestedFix,
  };
}

/** Split each line into comment / content segments; returns per-line content + whether any comment was present. */
function stripComments(lines: string[]): SegLine[] {
  const out: SegLine[] = [];
  let inComment = false;
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trimStart();
    if (fence) {
      // Inside a fenced code block: everything (comments included) is content.
      if (trimmed.startsWith(fence)) fence = null;
      out.push({ line: i + 1, content: raw, hadComment: false });
      continue;
    }
    if (/^(```|~~~)/.test(trimmed)) {
      fence = trimmed.startsWith("```") ? "```" : "~~~";
      out.push({ line: i + 1, content: raw, hadComment: false });
      continue;
    }
    let content = "";
    let hadComment = false;
    let rest = raw;
    while (rest.length > 0) {
      if (inComment) {
        const end = rest.indexOf("-->");
        if (end === -1) {
          hadComment = true;
          rest = "";
          break;
        }
        hadComment = true;
        rest = rest.slice(end + 3);
        inComment = false;
      } else {
        const start = rest.indexOf("<!--");
        if (start === -1) {
          content += rest;
          rest = "";
          break;
        }
        content += rest.slice(0, start);
        rest = rest.slice(start + 4);
        inComment = true;
        hadComment = true;
      }
    }
    out.push({ line: i + 1, content, hadComment });
  }
  return out;
}

interface RawSection {
  spec: SectionSpec | null; // null when the heading is unknown
  name: string;
  line: number;
  body: SegLine[]; // lines between this heading and the next `## ` heading
}

export function parseArtifact(contract: ArtifactContract, text: string): ParsedDocument {
  const issues: ValidationIssue[] = [];
  const lines = text.split(/\r?\n/);
  const segs = stripComments(lines);

  // ---- title -------------------------------------------------------------
  let titleLine: number | null = null;
  let title: string | null = null;
  for (const s of segs) {
    const t = s.content.trim();
    if (t === "") continue;
    const m = /^#\s+(.*)$/.exec(t);
    if (m) {
      titleLine = s.line;
      title = m[1].trim();
      if (title !== contract.title) {
        issues.push(
          issue(contract, "STRUCT_BAD_TITLE", `Document title is "${title}" but the contract requires exactly "# ${contract.title}".`, {
            line: s.line,
            suggestedFix: `Rename the first heading to "# ${contract.title}".`,
          }),
        );
      }
    } else {
      issues.push(
        issue(contract, "STRUCT_BAD_TITLE", `The first non-blank line must be the document title "# ${contract.title}", found: "${t.slice(0, 60)}".`, {
          line: s.line,
        }),
      );
    }
    break;
  }

  // ---- top-level sections -------------------------------------------------
  const byName = new Map<string, SectionSpec>();
  for (const spec of contract.sectionOrder) byName.set(spec.name, spec);

  const raw: RawSection[] = [];
  for (let i = 0; i < segs.length; i++) {
    const t = segs[i].content.trim();
    if (!/^##\s+/.test(t) || /^###[\s#]/.test(t)) continue;
    const name = t.replace(/^##\s+/, "").trim();
    const body: SegLine[] = [];
    for (let j = i + 1; j < segs.length; j++) {
      const tj = segs[j].content.trim();
      if (/^##\s+/.test(tj) && !/^###[\s#]/.test(tj)) break;
      body.push(segs[j]);
    }
    raw.push({ spec: byName.get(name) ?? null, name, line: segs[i].line, body });
  }

  // Unknown / duplicate headings
  const seen = new Map<string, number>();
  for (const r of raw) {
    if (!r.spec) {
      issues.push(
        issue(contract, "STRUCT_UNKNOWN_SECTION", `Heading "## ${r.name}" is not part of the ${contract.templateVersion} contract for "${contract.artifactType}" artifacts.`, {
          line: r.line,
          suggestedFix: "Remove the heading or fold its content into an existing contract section. You cannot extend the contract.",
        }),
      );
      continue;
    }
    if (seen.has(r.spec.name)) {
      issues.push(
        issue(contract, "STRUCT_DUPLICATE_SECTION", `Section "## ${r.spec.name}" appears again at line ${r.line}; it was already defined at line ${seen.get(r.spec.name)}.`, {
          line: r.line,
          section: r.spec.name,
          suggestedFix: "Merge the two sections into one.",
        }),
      );
      continue;
    }
    seen.set(r.spec.name, r.line);
  }

  // Ordering: known sections must follow the contract order
  const known = raw.filter((r) => r.spec);
  for (let i = 1; i < known.length; i++) {
    const a = contract.sectionOrder.findIndex((s) => s.name === known[i - 1]!.spec!.name);
    const b = contract.sectionOrder.findIndex((s) => s.name === known[i]!.spec!.name);
    if (b < a) {
      issues.push(
        issue(contract, "STRUCT_SECTION_ORDER", `Section "## ${known[i]!.spec!.name}" (line ${known[i]!.line}) appears before "## ${known[i - 1]!.spec!.name}" (line ${known[i - 1]!.line}); the contract requires the order: ${contract.sectionOrder.map((s) => s.name).join(" → ")}.`, {
          line: known[i]!.line,
          section: known[i]!.spec!.name,
        }),
      );
      break;
    }
  }

  // Missing required sections
  for (const spec of contract.sectionOrder) {
    if (spec.required && !seen.has(spec.name)) {
      issues.push(
        issue(contract, "STRUCT_MISSING_SECTION", `Required section "## ${spec.name}" is missing.`, {
          section: spec.name,
          suggestedFix: `Add "## ${spec.name}" in the contract position (after "${orderBefore(contract, spec.name)}").`,
        }),
      );
    }
  }

  // ---- per-section bodies --------------------------------------------------
  const sections: Record<string, ParsedSection> = {};
  const doc: Record<string, unknown> = {};

  for (const r of known) {
    const spec = r.spec!;
    const contentLines: ContentLine[] = r.body
      .map((s) => ({ line: s.line, text: s.content }))
      .filter((c) => c.text.trim() !== "");
    const anyComment = r.body.some((s) => s.hadComment);
    const placeholder = contentLines.length === 0 && anyComment;
    const rawText = contentLines.map((c) => c.text.trim()).join("\n");

    const ps: ParsedSection = {
      spec,
      line: r.line,
      placeholder,
      na: false,
    };
    sections[spec.name] = ps;

    if (contentLines.length === 0) {
      if (spec.required) {
        if (placeholder) {
          issues.push(
            issue(contract, "STRUCT_PLACEHOLDER_SECTION", `Section "## ${spec.name}" still contains only the template placeholder comment.`, {
              line: r.line,
              section: spec.name,
              suggestedFix: spec.allowsNA
                ? `Replace the comment with real content, or with the single line "None identified" (or "Not applicable — <reason>").`
                : "Replace the comment with real content.",
            }),
          );
        } else {
          issues.push(
            issue(contract, "STRUCT_EMPTY_SECTION", `Required section "## ${spec.name}" is empty.`, {
              line: r.line,
              section: spec.name,
              suggestedFix: spec.allowsNA
                ? `Write content, or the single line "None identified" (or "Not applicable — <reason>").`
                : "Write the section content.",
            }),
          );
        }
      }
      continue;
    }

    // Documented not-applicable marker (single line)
    const naLines = contentLines.map((c) => c.text.trim());
    if (naLines.length === 1 && NA_MARKER_RE.test(naLines[0]!)) {
      if (spec.allowsNA) {
        ps.na = true;
        doc[spec.prop] = null;
        continue;
      }
      issues.push(
        issue(contract, "STRUCT_NA_NOT_ALLOWED", `Section "## ${spec.name}" uses the not-applicable marker "${naLines[0]}" but the contract requires real content here.`, {
          line: r.line,
          section: spec.name,
          suggestedFix: "Write real content for this section.",
        }),
      );
      continue;
    }

    switch (spec.kind) {
      case "text": {
        ps.text = rawText;
        doc[spec.prop] = rawText;
        break;
      }
      case "list": {
        const items: string[] = [];
        for (const c of contentLines) {
          const m = /^-\s+(.*)$/.exec(c.text.trim());
          if (!m || m[1]!.trim() === "") {
            issues.push(
              issue(contract, `STRUCT_NON_LIST_CONTENT`, `Section "## ${spec.name}" must contain one "- item" bullet per line; line ${c.line} is not a bullet.`, {
                line: c.line,
                section: spec.name,
              }),
            );
            continue;
          }
          items.push(m[1]!.trim());
        }
        if (items.length > 0) {
          ps.items = items;
          doc[spec.prop] = items;
        }
        break;
      }
      case "keyvalue": {
        ps.kv = {};
        const obj: Record<string, unknown> = {};
        const keyLines: Record<string, number> = {};
        for (const c of contentLines) {
          const m = /^-\s+([^:]+):\s*(.*)$/.exec(c.text.trim());
          if (!m) {
            issues.push(
              issue(contract, "STRUCT_NON_KV_CONTENT", `Section "## ${spec.name}" must contain one "- Key: value" bullet per line; line ${c.line} is not a key-value bullet.`, {
                line: c.line,
                section: spec.name,
              }),
            );
            continue;
          }
          const key = m[1]!.trim();
          const value = m[2]!.trim();
          const ks = spec.kvKeys?.find((k) => k.key === key);
          if (!ks) {
            issues.push(
              issue(contract, "STRUCT_UNKNOWN_KV_KEY", `Unknown key "${key}" in section "## ${spec.name}" (line ${c.line}). Allowed keys: ${spec.kvKeys?.map((k) => k.key).join(", ")}.`, {
                line: c.line,
                section: spec.name,
              }),
            );
            continue;
          }
          if (keyLines[key] !== undefined) {
            issues.push(
              issue(contract, "STRUCT_DUPLICATE_KV_KEY", `Key "${key}" is repeated in section "## ${spec.name}" (lines ${keyLines[key]} and ${c.line}).`, {
                line: c.line,
                section: spec.name,
              }),
            );
            continue;
          }
          keyLines[key] = c.line;
          if (value === "") {
            issues.push(
              issue(contract, "STRUCT_EMPTY_KV_VALUE", `Key "${key}" in section "## ${spec.name}" has an empty value (line ${c.line}).`, {
                line: c.line,
                section: spec.name,
              }),
            );
            continue;
          }
          ps.kv![key] = value;
          obj[ks.prop] = spec.name === "Metadata" ? normalizeMetaValue(contract, ks.prop, value, c.line, issues) : value;
        }
        for (const ks of spec.kvKeys ?? []) {
          if (ks.required && ps.kv![ks.key] === undefined) {
            issues.push(
              issue(contract, "STRUCT_MISSING_KV_KEY", `Required key "${ks.key}" is missing from section "## ${spec.name}".`, {
                section: spec.name,
                suggestedFix: `Add the bullet "- ${ks.key}: <value>".`,
              }),
            );
          }
        }
        if (Object.keys(obj).length > 0) doc[spec.prop] = obj;
        break;
      }
      case "records": {
        parseRecords(contract, spec, contentLines, ps, issues);
        if (ps.records) {
          if (ps.records.length > 0) {
            doc[spec.prop] = ps.records.map((rec) => {
              const o: Record<string, unknown> = { id: rec.id, title: rec.title };
              for (const f of spec.recordFields ?? []) {
                if (rec.fields[f.name] !== undefined) o[f.prop] = rec.fields[f.name];
              }
              o.description = rec.description;
              return o;
            });
          } else if (spec.required) {
            issues.push(
              issue(contract, "STRUCT_NO_RECORDS", `Required section "## ${spec.name}" contains no records.`, {
                section: spec.name,
                suggestedFix: `Add at least one "### ${spec.recordIdPrefix}-001: <title>" record.`,
              }),
            );
          }
        }
        break;
      }
    }
  }

  // Metadata normalization: Revision must become an integer
  const md = doc.metadata as Record<string, unknown> | undefined;
  if (md && md.revision !== undefined && typeof md.revision === "string" && !/^[0-9]+$/.test(md.revision)) {
    issues.push(
      issue(contract, "STRUCT_INVALID_REVISION", `Metadata "Revision" must be a positive integer, got "${md.revision}".`, {
        section: "Metadata",
        fieldPath: "metadata.revision",
      }),
    );
    // leave as string so the schema type check also reports it
  }

  return { title, titleLine, sections, doc, issues };
}

function orderBefore(contract: ArtifactContract, name: string): string {
  const idx = contract.sectionOrder.findIndex((s) => s.name === name);
  return idx > 0 ? contract.sectionOrder[idx - 1]!.name : "the document title";
}

function normalizeMetaValue(
  contract: ArtifactContract,
  prop: string,
  value: string,
  line: number,
  issues: ValidationIssue[],
): unknown {
  if (prop === "revision" && /^[0-9]+$/.test(value)) return Number(value);
  return value;
}

function parseRecords(
  contract: ArtifactContract,
  spec: SectionSpec,
  contentLines: ContentLine[],
  ps: ParsedSection,
  issues: ValidationIssue[],
): void {
  const prefix = spec.recordIdPrefix!;
  const headerRe = new RegExp(`^${prefix}-([0-9]{3,})\\s*:\\s*(.+)$`);
  const records: ParsedRecord[] = [];
  const ids = new Map<string, number>();
  ps.records = records;

  let rec: ParsedRecord | null = null;
  let fieldsDone = false;
  let preambleSeen = false;
  const fieldNames = new Set((spec.recordFields ?? []).map((f) => f.name));

  const closeRec = () => {
    if (!rec) return;
    for (const f of spec.recordFields ?? []) {
      if (f.required && rec.fields[f.name] === undefined) {
        issues.push(
          issue(contract, "STRUCT_MISSING_RECORD_FIELD", `Record ${rec.id} in "## ${spec.name}" is missing the required field "${f.name}".`, {
            line: rec.line,
            section: spec.name,
            relatedId: rec.id,
            suggestedFix: `Add the bullet "- ${f.name}: <value>" to ${rec.id}.`,
          }),
        );
      }
    }
    if (rec.description === "" && !spec.allowEmptyDescription) {
      issues.push(
        issue(contract, "STRUCT_EMPTY_RECORD_DESCRIPTION", `Record ${rec.id} in "## ${spec.name}" has no description body.`, {
          line: rec.line,
          section: spec.name,
          relatedId: rec.id,
        }),
      );
    }
    rec = null;
    fieldsDone = false;
  };

  for (const c of contentLines) {
    const t = c.text.trim();
    const hm = /^###\s+(.+)$/.exec(t);
    if (hm) {
      closeRec();
      const idm = headerRe.exec(hm[1]!);
      if (!idm) {
        issues.push(
          issue(contract, "STRUCT_MALFORMED_RECORD", `Line ${c.line} in "## ${spec.name}" must be a record heading "### ${prefix}-###: <title>", found: "${hm[1]}".`, {
            line: c.line,
            section: spec.name,
            suggestedFix: `Use the form "### ${prefix}-001: <short title>".`,
          }),
        );
        continue;
      }
      const id = `${prefix}-${idm[1]}`;
      if (ids.has(id)) {
        issues.push(
          issue(contract, "STRUCT_DUPLICATE_RECORD_ID", `Record id ${id} is used twice in "## ${spec.name}" (lines ${ids.get(id)} and ${c.line}).`, {
            line: c.line,
            section: spec.name,
            relatedId: id,
          }),
        );
        continue;
      }
      ids.set(id, c.line);
      rec = { id, title: idm[2]!.trim(), fields: {}, fieldLines: {}, description: "", line: c.line };
      records.push(rec);
      fieldsDone = false;
      continue;
    }
    if (!rec) {
      if (!preambleSeen) {
        issues.push(
          issue(contract, "STRUCT_RECORD_PREAMBLE", `Section "## ${spec.name}" has content before its first record (line ${c.line}); records must start the section.`, {
            line: c.line,
            section: spec.name,
          }),
        );
        preambleSeen = true;
      }
      continue;
    }
    const bm: RegExpExecArray | null = !fieldsDone ? /^-\s+([^:]+):\s*(.*)$/.exec(t) : null;
    if (bm && fieldNames.has(bm[1]!.trim())) {
      const field = bm[1]!.trim();
      const value = bm[2]!.trim();
      if (rec.fields[field] !== undefined) {
        issues.push(
          issue(contract, "STRUCT_DUPLICATE_RECORD_FIELD", `Field "${field}" is repeated in record ${rec.id} (line ${c.line}).`, {
            line: c.line,
            section: spec.name,
            relatedId: rec.id,
          }),
        );
        continue;
      }
      if (value === "") {
        issues.push(
          issue(contract, "STRUCT_EMPTY_RECORD_FIELD_VALUE", `Field "${field}" of record ${rec.id} has an empty value (line ${c.line}).`, {
          line: c.line,
          section: spec.name,
          relatedId: rec.id,
        }),
        );
        continue;
      }
      rec.fields[field] = value;
      rec.fieldLines[field] = c.line;
      continue;
    }
    if (bm && !fieldNames.has(bm[1]!.trim())) {
      issues.push(
        issue(contract, "STRUCT_UNKNOWN_RECORD_FIELD", `Unknown field "${bm[1]!.trim()}" in record ${rec.id} (line ${c.line}). Allowed fields: ${(spec.recordFields ?? []).map((f) => f.name).join(", ")}.`, {
          line: c.line,
          section: spec.name,
          relatedId: rec.id,
          suggestedFix: "Remove the unknown field or fold its content into the description body.",
        }),
      );
      // unknown fields are reported and NOT stored (no silent discarding)
      continue;
    }
    // Body content (after the leading bullet run, bullets included)
    if (!fieldsDone) fieldsDone = true;
    if (rec.description !== "") rec.description += "\n";
    rec.description += c.text.trimEnd();
  }
  closeRec();
}
