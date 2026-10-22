import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { WorkflowError } from "../workflow/errors.ts";

/**
 * `/factory init` input handling — the small step between the raw command
 * string and the existing initialization workflow.
 *
 * Supported syntax:
 *   /factory init <description>
 *   /factory init --file <path>
 *   /factory init --file <path> --file <path> …
 *   /factory init @<path>
 *   /factory init @<path> @<path> …
 *
 * Rules (all enforced here, before any workflow state is created):
 * - `--file <path>` and the `@<path>` shorthand are equivalent file
 *   references, both repeatable; order of appearance is the document order.
 *   (`--file @foo.md` names the literal file "@foo.md" — only bare `@<path>`
 *   tokens are shorthand.)
 * - Inline text and file inputs (--file / @path) cannot be mixed (provenance
 *   would be ambiguous for the inline part); exactly one form per invocation.
 * - Each file is read and validated (exists, regular file, readable, valid
 *   UTF-8, non-whitespace) before anything is returned. A single bad file
 *   aborts the whole input; there is no partial success.
 * - File paths are resolved against the command's working directory
 *   (relative paths) or used as-is (absolute paths; `@/abs/path` too). No
 *   directory traversal, no wildcard expansion — the string is handed
 *   straight to the filesystem API.
 * - File contents are never interpreted, modified, or truncated; they are
 *   combined verbatim with explicit provenance boundaries.
 */

export interface InitInput {
  /** Inline description (tokens joined with single spaces); "" when file inputs were used. */
  inline: string;
  /** File paths (from --file and @<path>) in order of appearance. */
  files: string[];
}

const USAGE =
  "Usage: /factory init <description>  |  /factory init --file <path> [--file <path> …]  |  /factory init @<path> [@<path> …]  " +
  "(inline text and file inputs cannot be mixed)";

function inputError(message: string): WorkflowError {
  return new WorkflowError("INVALID_INIT_INPUT", `${message}\n${USAGE}`);
}

/**
 * Parse the raw `/factory init` argument string. Tokens are separated by
 * whitespace (the pi command line has no quote layer), so file paths must not
 * contain spaces. Throws INVALID_INIT_INPUT on any invalid combination.
 */
export function parseInitArgs(raw: string): InitInput {
  const tokens = raw.trim().split(/\s+/).filter((t) => t.length > 0);
  const files: string[] = [];
  const inlineTokens: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--file") {
      const p = tokens[i + 1];
      if (p === undefined || p === "--file" || p.startsWith("--")) {
        throw inputError(`--file requires a path argument (got none or "${p ?? ""}").`);
      }
      i++;
      files.push(p);
    } else if (t.startsWith("--")) {
      throw inputError(`Unknown option "${t}".`);
    } else if (t.startsWith("@")) {
      // `@<path>` shorthand for `--file <path>`; "@" alone has no path.
      if (t === "@") {
        throw inputError(`File reference "@" needs a path after it (e.g. @requirements/auth.md).`);
      }
      files.push(t.slice(1));
    } else {
      inlineTokens.push(t);
    }
  }
  if (files.length > 0 && inlineTokens.length > 0) {
    throw inputError(
      "Inline text and file inputs (--file / @<path>) cannot be combined (the inline part would have no provenance). " +
        "Put the extra context into one of the files, or use plain inline text.",
    );
  }
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f)) {
      throw inputError(`Duplicate file path: "${f}". List each file at most once.`);
    }
    seen.add(f);
  }
  return { inline: inlineTokens.join(" "), files };
}

interface FilePart {
  /** Provenance label: project-relative when inside cwd, absolute otherwise. */
  label: string;
  text: string;
}

/** Display form of a path: cwd-relative when possible, absolute as fallback. */
function displayPath(abs: string, cwd: string): string {
  const rel = path.relative(cwd, abs);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : abs;
}

/**
 * Read every requested file and combine them into one deterministic
 * initialization input. All files are read and validated before the combined
 * text is produced; any failure throws INVALID_INIT_INPUT naming the file,
 * and the caller must not touch workflow state.
 */
export function readAndCombineFiles(files: string[], cwd: string): string {
  const parts: FilePart[] = [];
  for (const given of files) {
    const abs = path.resolve(cwd, given);
    let st;
    try {
      st = statSync(abs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw inputError(`File not found: ${given} (${msg})`);
    }
    if (st.isDirectory()) {
      throw inputError(`"${given}" is a directory — pass a file path.`);
    }
    if (!st.isFile()) {
      throw inputError(`"${given}" is not a regular file; only ordinary files are supported.`);
    }
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw inputError(`Cannot read "${given}": ${msg}`);
    }
    let decoded: string;
    try {
      // fatal: decode errors instead of silently replacing invalid bytes
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      throw inputError(`"${given}" is not valid UTF-8 text; /factory init accepts UTF-8 text files only.`);
    }
    if (decoded.trim().length === 0) {
      throw inputError(`"${given}" is empty or contains only whitespace — nothing to initialize from.`);
    }
    parts.push({ label: displayPath(abs, cwd), text: decoded });
  }
  // Explicit boundaries + provenance labels; contents are otherwise verbatim.
  const blocks = parts.map((p, i) => `# Input File ${i + 1}: ${p.label}\n\n${p.text}`);
  return blocks.join("\n\n---\n\n") + "\n";
}
