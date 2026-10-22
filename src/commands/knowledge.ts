import { buildKnowledgeWorkOrder } from "../knowledge/prompt.ts";
import { isKnowledgeType, KNOWLEDGE_TYPES, type KnowledgeType } from "../knowledge/types.ts";
import { describeError } from "../workflow/errors.ts";
import type { CommandCtxLike, FactoryDeps } from "./factory.ts";
import type { FactoryEngine } from "../engine.ts";
import type { KnowledgeManager } from "../knowledge/manager.ts";

/**
 * `/factory knowledge …` — the unified Project Knowledge command namespace.
 *
 *   /factory knowledge add --type <constraint|convention|tech-decision|auto> [description...]
 *   /factory knowledge list [--type <type>] [--status <status>]
 *   /factory knowledge show <id>
 *   /factory knowledge validate [id]
 *   /factory knowledge approve <id> [comment...]
 *   /factory knowledge reject <id> [reason...]
 *   /factory knowledge deprecate <id>
 *   /factory knowledge regenerate <id>
 *
 * All persistence, validation and lifecycle transitions happen in the
 * KnowledgeManager (extension code). This file only parses arguments, calls
 * the manager, and renders the result.
 */

export async function handleKnowledge(rest: string, ctx: CommandCtxLike, deps: FactoryDeps): Promise<void> {
  const parts = rest.split(/\s+/).filter(Boolean);
  const sub = parts[0];
  const engine = deps.engineFor(ctx.cwd);
  const km = engine.knowledge;
  try {
    switch (sub) {
      case undefined:
      case "help":
        show(ctx, usage());
        return;
      case "add":
        doAdd(ctx, engine, km, parts.slice(1), deps);
        return;
      case "list":
        doList(ctx, km, parts.slice(1));
        return;
      case "show":
        doShow(ctx, km, parts.slice(1));
        return;
      case "validate":
        doValidate(ctx, km, parts.slice(1));
        return;
      case "approve":
        doApprove(ctx, km, parts.slice(1));
        return;
      case "reject":
        doReject(ctx, km, parts.slice(1));
        return;
      case "deprecate":
        doDeprecate(ctx, km, parts.slice(1));
        return;
      case "regenerate":
        doRegenerate(ctx, km, parts.slice(1));
        return;
      default:
        show(ctx, [`Unknown knowledge subcommand "${sub}".`, ...usage()]);
    }
  } catch (e) {
    show(ctx, [describeError(e)]);
    ctx.ui.notify(describeError(e), "error");
  }
}

// ------------------------------------------------------------- sub-actions

function parseFlags(parts: string[]): { flags: Map<string, string>; rest: string[] } {
  const flags = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.startsWith("--")) {
      const eq = p.indexOf("=");
      if (eq > 0) flags.set(p.slice(2, eq), p.slice(eq + 1));
      else if (i + 1 < parts.length && !parts[i + 1]!.startsWith("--")) flags.set(p.slice(2), parts[++i]!);
      else flags.set(p.slice(2), "");
    } else {
      rest.push(p);
    }
  }
  return { flags, rest };
}

function doAdd(ctx: CommandCtxLike, engine: FactoryEngine, km: KnowledgeManager, parts: string[], deps: FactoryDeps): void {
  const { flags, rest } = parseFlags(parts);
  const typeArg = flags.get("type") ?? "";
  let type: KnowledgeType | "auto";
  if (typeArg === "auto") type = "auto";
  else if (isKnowledgeType(typeArg)) type = typeArg;
  else if (typeArg === "" || typeArg === "help") {
    show(ctx, [`Missing or unknown --type. Valid types: ${[...KNOWLEDGE_TYPES, "auto"].join(" | ")}.`, ...usage()]);
    return;
  } else {
    show(ctx, [`Unknown knowledge type "${typeArg}". Valid types: ${[...KNOWLEDGE_TYPES, "auto"].join(" | ")}.`]);
    return;
  }
  const description = rest.join(" ").trim() || null;

  const active = engine.getActiveWorkflow();
  const changeContext = active
    ? `${active.change_id} (phase ${active.current_phase}, "${active.description}")`
    : null;
  const existing = km.hasAnyKnowledge() ? km.summaryForPrompt() : "(none yet)";
  const prompt = buildKnowledgeWorkOrder({ requestedType: type, description, existingKnowledge: existing, changeContext, repoRoot: ctx.cwd });
  deps.sendPhasePrompt(prompt);
  show(ctx, [
    `Knowledge draft work order sent to the agent (type: ${type}).`,
    description ? `Requested: ${description}` : "The agent will first ask you what to record.",
    "The agent will store a DRAFT via the factory_knowledge_draft tool (validated by the extension) and show you the rendered result.",
    "Nothing is effective yet: run /factory knowledge approve <id> to make a draft take effect, or ignore it.",
  ]);
}

function doList(ctx: CommandCtxLike, km: KnowledgeManager, parts: string[]): void {
  const { flags, rest } = parseFlags(parts);
  if (rest.length > 0) {
    show(ctx, [`Unexpected argument(s): ${rest.join(" ")}`, ...usage()]);
    return;
  }
  const typeArg = flags.get("type");
  if (typeArg !== undefined && typeArg !== "" && !isKnowledgeType(typeArg)) {
    show(ctx, [`Unknown --type "${typeArg}". Valid: ${KNOWLEDGE_TYPES.join(" | ")}.`]);
    return;
  }
  const status = flags.get("status") || undefined;
  const { items, errors } = km.listKnowledge({ type: typeArg as KnowledgeType | undefined, status });
  const lines: string[] = [];
  if (items.length === 0 && errors.length === 0) {
    lines.push("No Project Knowledge records match the filter.");
  }
  if (items.length > 0) {
    lines.push(`Project Knowledge — ${items.length} record(s):`);
    for (const it of items) {
      lines.push(`  ${it.id}  [${it.status}]  ${it.type.padEnd(14)}  scope=${it.scope}`);
      lines.push(`      ${it.title}`);
      lines.push(`      json: ${it.jsonRel}   md: ${it.mdRel}`);
    }
  }
  for (const e of errors) {
    lines.push(`  MALFORMED: ${e.file}`);
    lines.push(`      ${e.error}`);
  }
  lines.push("");
  lines.push("Inspect: /factory knowledge show <id>    Check: /factory knowledge validate");
  show(ctx, lines);
}

function doShow(ctx: CommandCtxLike, km: KnowledgeManager, parts: string[]): void {
  const id = parts[0];
  if (!id) {
    show(ctx, ["Usage: /factory knowledge show <id> (e.g. CON-001, CVN-001, ADR-001)"]);
    return;
  }
  const r = km.getKnowledge(id);
  const scope = (r.doc as { scope: { level: string; paths: string[] } }).scope;
  const lines: string[] = [
    `${r.type} ${r.doc.id} — ${(r.doc as { title: string }).title}`,
    `Status:   ${r.doc.status}`,
    `Scope:    ${scope.level}${scope.paths.length > 0 ? ` (${scope.paths.join(", ")})` : ""}`,
    `JSON:     ${r.jsonRel}   (canonical)`,
    `Markdown: ${r.mdRel}   [${
      r.markdownState === "ok" ? "in sync" : r.markdownState === "missing" ? `MISSING — run: /factory knowledge regenerate ${r.doc.id}` : `OUT OF SYNC — run: /factory knowledge regenerate ${r.doc.id}`
    }]`,
  ];
  if (r.supersedes) lines.push(`Supersedes:    ${r.supersedes}`);
  if (r.supersededBy.length > 0) lines.push(`Superseded by: ${r.supersededBy.join(", ")}`);
  if (r.events.length > 0) {
    lines.push("History:");
    for (const e of [...r.events].reverse()) {
      lines.push(`  ${e.createdAt}  ${e.kind}${e.changeId ? ` (change ${e.changeId})` : ""}${e.detail ? ` — ${e.detail}` : ""}`);
    }
  }
  lines.push("", "Canonical JSON:", "```json", JSON.stringify(r.doc, null, 2), "```");
  show(ctx, lines);
}

function doValidate(ctx: CommandCtxLike, km: KnowledgeManager, parts: string[]): void {
  const id = parts[0];
  if (parts.length > 1) {
    show(ctx, ["Usage: /factory knowledge validate [id]"]);
    return;
  }
  const report = km.validateKnowledge(id);
  const lines: string[] = [];
  const totalErrors = report.items.reduce((n, i) => n + i.errors.length, 0) + report.globalErrors.length;
  const totalWarnings = report.items.reduce((n, i) => n + i.warnings.length, 0) + report.globalWarnings.length;
  lines.push(id ? `Validating ${id}` : "Validating all Project Knowledge");
  for (const item of report.items) {
    const status = item.status ? ` [${item.status}]` : "";
    if (item.errors.length === 0 && item.warnings.length === 0) {
      lines.push(`  OK    ${item.id ?? item.file}${status}  (markdown ${item.markdownState})`);
    } else {
      lines.push(`  CHECK ${item.id ?? item.file}${status}`);
      for (const e of item.errors) lines.push(`    ERROR: ${e}`);
      for (const w of item.warnings) lines.push(`    warning: ${w}`);
    }
  }
  for (const e of report.globalErrors) lines.push(`  ERROR (global): ${e}`);
  for (const w of report.globalWarnings) lines.push(`  warning (global): ${w}`);
  lines.push("");
  lines.push(
    totalErrors === 0
      ? `Result: PASSED${totalWarnings > 0 ? ` with ${totalWarnings} warning(s)` : ""}. Structural errors = 0. Note: this does not claim that arbitrary natural-language conflicts are fully detected.`
      : `Result: FAILED — ${totalErrors} structural error(s), ${totalWarnings} warning(s). Invalid records were NOT modified.`,
  );
  show(ctx, lines);
}

function doApprove(ctx: CommandCtxLike, km: KnowledgeManager, parts: string[]): void {
  const id = parts[0];
  if (!id) {
    show(ctx, ["Usage: /factory knowledge approve <id> [comment]"]);
    return;
  }
  const comment = parts.slice(1).join(" ").trim() || undefined;
  const r = km.approve(id, comment);
  const lines: string[] = ["Approved knowledge record(s) (effective now):"];
  for (const c of r.changes) lines.push(`  ${c.id}: ${c.from} -> ${c.to}`);
  lines.push(`Canonical JSON:     ${r.jsonRel}`);
  lines.push(`Generated Markdown: ${r.mdRel}`);
  lines.push("Verify at any time with: /factory knowledge validate " + id);
  show(ctx, lines);
}

function doReject(ctx: CommandCtxLike, km: KnowledgeManager, parts: string[]): void {
  const id = parts[0];
  if (!id) {
    show(ctx, ["Usage: /factory knowledge reject <id> [reason]   (tech decisions only; the record is preserved as rejected)"]);
    return;
  }
  const reason = parts.slice(1).join(" ").trim();
  const r = km.rejectDecision(id, reason);
  show(ctx, [`Tech decision ${id} is now ${r.changes[0]!.to} (record preserved for history).`, `Canonical JSON: ${r.jsonRel}   Generated Markdown: ${r.mdRel}`]);
}

function doDeprecate(ctx: CommandCtxLike, km: KnowledgeManager, parts: string[]): void {
  const id = parts[0];
  if (!id) {
    show(ctx, ["Usage: /factory knowledge deprecate <id>"]);
    return;
  }
  const r = km.deprecate(id);
  const kind =
    r.type === "tech-decision"
      ? "Tech decision withdrawn (no replacement; the record is preserved). To replace it, accept a new decision that supersedes it."
      : "Deprecated (record and references preserved).";
  show(ctx, [`${kind}`, `  ${r.changes[0]!.id}: ${r.changes[0]!.from} -> ${r.changes[0]!.to}`, `Canonical JSON: ${r.jsonRel}   Generated Markdown: ${r.mdRel}`]);
}

function doRegenerate(ctx: CommandCtxLike, km: KnowledgeManager, parts: string[]): void {
  const id = parts[0];
  if (!id) {
    show(ctx, ["Usage: /factory knowledge regenerate <id>   (re-render the generated Markdown from the canonical JSON)"]);
    return;
  }
  const r = km.regenerateMarkdown(id);
  show(ctx, [`Regenerated ${r.mdRel} from the canonical JSON of ${r.id}.`]);
}

// ------------------------------------------------------------- helpers

function usage(): string[] {
  return [
    "Project Knowledge commands:",
    "  /factory knowledge add --type <constraint|convention|tech-decision|auto> [description]   draft new knowledge (agent drafts, you approve)",
    "  /factory knowledge list [--type <type>] [--status <status>]   list records (malformed files are reported, not hidden)",
    "  /factory knowledge show <id>   show canonical JSON, Markdown state, references and history",
    "  /factory knowledge validate [id]   schema + semantic + Markdown sync validation",
    "  /factory knowledge approve <id> [comment]   make a draft/proposed record effective (human gate)",
    "  /factory knowledge reject <id> [reason]   mark a tech decision rejected (preserved)",
    "  /factory knowledge deprecate <id>   deprecate a constraint/convention, or withdraw a tech decision",
    "  /factory knowledge regenerate <id>   re-render the generated Markdown from the canonical JSON",
  ];
}

function show(ctx: CommandCtxLike, lines: string[]): void {
  const text = lines.join("\n");
  if (ctx.mode === "tui") {
    try {
      ctx.ui.setWidget("factory", ["── factory · knowledge ──", ...lines], { placement: "belowEditor" });
    } catch {
      /* widget is cosmetic */
    }
  }
  ctx.ui.notify(text);
}
