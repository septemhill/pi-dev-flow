import type { KnowledgeType } from "./types.ts";
import { KNOWLEDGE_TYPE_LABEL } from "./types.ts";

/**
 * Prompt fragments for Project Knowledge. These are INSTRUCTIONS ONLY — they
 * never control workflow state. All validation, identifier allocation,
 * persistence and lifecycle transitions happen in extension code.
 */

/**
 * Work order sent to the agent by `/factory knowledge add`. The agent drafts
 * JSON, submits it through the restricted `factory_knowledge_draft` tool
 * (which validates and stores it as a DRAFT), then presents the result to the
 * user. The record only becomes effective when the USER runs
 * `/factory knowledge approve <id>`.
 */
export function buildKnowledgeWorkOrder(opts: {
  requestedType: KnowledgeType | "auto";
  description: string | null;
  existingKnowledge: string; // summary lines, or "(none yet)"
  changeContext: string | null; // active change info for traceability
  repoRoot: string;
}): string {
  const typeLine =
    opts.requestedType === "auto"
      ? `Classify the content into whichever of the three Project Knowledge types it genuinely supports — "constraint", "convention" or "tech-decision". "auto" means AUTOMATIC CLASSIFICATION, NOT automatic approval. Create ONLY the type(s) the content actually supports — do not manufacture all three.`
      : `Create a record of type "${opts.requestedType}" (${KNOWLEDGE_TYPE_LABEL[opts.requestedType]}).`;

  const descriptionLine = opts.description
    ? `Requested content:\n> ${opts.description}`
    : `No content was given with the command. FIRST ask the user what knowledge they want to record; only proceed once they answer (do not invent content).`;

  return [
    "# [factory] Project Knowledge draft work order",
    "",
    "The operator requested a new Project Knowledge record. You DRAFT the document; the extension VALIDATES and STORES it as a **draft**.",
    "",
    `## Type\n${typeLine}`,
    "",
    descriptionLine,
    "",
    "## Existing Project Knowledge (re-read before drafting)",
    opts.existingKnowledge,
    "",
    "## Rules (enforced by the extension, not by you)",
    "- Call the `factory_knowledge_draft` tool ONCE per independent candidate, with `type` and a `document` object conforming to that type's JSON Schema (the schema files live in the extension's src/schemas/project-knowledge/ — read the relevant one and follow it exactly).",
    "- Do NOT set a status yourself: whatever status you write is discarded and forced to \"draft\" by the extension.",
    "- Do NOT assign an id unless you are revising a draft the extension already showed you with that id; the extension allocates ids.",
    "- Check the existing knowledge list above FIRST: if an existing record already states the same rule or decision (even with different wording), do NOT create a duplicate — tell the user the existing id covers it.",
    "- If the content conflicts with an APPROVED constraint or accepted decision, say so explicitly to the user and do not hide it.",
    "- A technology merely mentioned in a prompt is NOT an accepted decision: record it as a draft, and note in its context that it awaits explicit user authorization.",
    "- If several independent candidates exist, submit several tool calls; each is validated and approved independently.",
    opts.changeContext
      ? `- This request came from change work: ${opts.changeContext}. Pass its change id in \`change_id\` (and the requirement history entry, e.g. "R3", in \`requirement_ref\`) so the record stays traceable to its origin.`
      : "",
    "- After the tool returns, show the operator the rendered draft (the tool output contains it) and the record id. Make explicit that it is a DRAFT and that it only becomes effective after they run: `/factory knowledge approve <id>`.",
    `- All paths are relative to: ${opts.repoRoot}`,
    "- You do NOT control workflow state; this request does not pause or change any factory workflow phase.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * Section injected into the requirement-phase work order: it tells the agent
 * how to discover candidate Project Knowledge in the user's original prompt
 * while keeping change-specific requirements separate.
 */
export function buildKnowledgeDiscoverySection(existingKnowledge: string, changeId: string): string {
  return [
    "## Project Knowledge discovery (this phase only)",
    "",
    "While capturing requirements, watch the user's ORIGINAL statements for project-level knowledge that goes beyond this change:",
    "- a restriction or prohibited behavior that future changes must also respect → possible **Constraint**;",
    "- a reusable development practice or project standard → possible **Convention**;",
    "- an explicit or implied technology/architecture choice → possible **Tech Decision**.",
    "",
    "Distinguish change-specific requirements (which go into the REQ records, as usual) from reusable project knowledge. Do NOT force an ambiguous statement into one category — when unsure, record it as an Open Question and flag it as a knowledge candidate.",
    "",
    `Existing Project Knowledge (check BEFORE proposing anything; reuse an existing id rather than creating a duplicate):`,
    existingKnowledge,
    "",
    "- If the user's prompt contains such knowledge, PRESENT it to the user as a candidate and ask whether to add it to Project Knowledge. Never add it silently: it must not change the project baseline without explicit confirmation.",
    "- If the user explicitly asks for a project-wide rule/decision, call the `factory_knowledge_draft` tool (it stores a DRAFT; only the user can approve it via /factory knowledge approve).",
    "- An inferred candidate is NEVER approved by the agent: a confident classification is not authorization.",
    "- For traceability, note each candidate in the requirement artifact's \"Open Questions\" section as: `[knowledge-candidate] <type>: <summary> — drafted as <ID>, pending approval (source R<n>)`.",
    `- Pass \`change_id\` = "${changeId}" (and the requirement entry id in \`requirement_ref\`) to \`factory_knowledge_draft\` so the draft stays traceable to this change.`,
    "- Do not bypass the workflow: discovering knowledge does not move any phase or approval gate.",
  ].join("\n");
}
