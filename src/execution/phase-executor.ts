import type {
  ApprovalRecord,
  ArtifactRecord,
  CheckRecord,
  TaskRecord,
  WorkflowRecord,
} from "../workflow/state.ts";
import { PHASES, PHASE_ARTIFACT_FILE, REQUIREMENT_HISTORY_FILE, type Phase } from "../workflow/phases.ts";
import { phaseTemplate } from "../prompts.ts";
import { getContract } from "../artifacts/artifact-registry.ts";
import { loadTemplate } from "../artifacts/template-loader.ts";
import { changeFile, readFileOrNull, sha256 } from "../artifacts/artifact-store.ts";
import { buildKnowledgeDiscoverySection } from "../knowledge/prompt.ts";

/**
 * Builds the user-message prompt that drives one phase execution.
 * The context comes from PERSISTED state (artifacts, tasks, checks,
 * rejection feedback) — never from conversational memory.
 */
export interface PromptContext {
  workflow: WorkflowRecord;
  /** Latest recorded artifact per phase (only earlier phases exist yet). */
  artifacts: ArtifactRecord[];
  rejection: ApprovalRecord | null;
  tasks: TaskRecord[];
  checks: CheckRecord[];
  /** True when re-prompting an already-RUNNING phase (possible interruption). */
  restarted: boolean;
  repoRoot: string;
  promptsDir?: string;
  /**
   * Summary lines of existing Project Knowledge for the requirement phase
   * (candidate discovery). Instructions only — discovery never moves the
   * workflow, and only the extension can persist/approve knowledge.
   */
  projectKnowledge?: string;
}

const PHASE_CONTRACT_EXTRA: Record<Phase, string> = {
  requirement:
    "- Every user requirement must be recorded with the `factory_requirement_append` tool (append-only history).\n" +
    "- Each REQ record's `Source` must cite the history entry id(s) it was consolidated from (e.g. R1, or 'Consolidated (R1, R2)').",
  spec:
    "- Every acceptance criterion must be externally verifiable and its `References` must cite existing REQ ids.\n" +
    "- `Referenced Requirements` must list every approved REQ id this spec addresses; every AC/FR must trace to a requirement.",
  design:
    "- The design must explicitly map every acceptance criterion (AC-###) of the approved spec to a component, interface, or design decision.\n" +
    "- Every `DES` decision record needs rationale and consequences.",
  task_planning:
    "- The plan must be recorded with the `factory_set_task_plan` tool (3-8 small tasks, each with scope, spec/design references, and verification).\n" +
    "- `task-plan.md` must mirror the recorded plan EXACTLY: same task count, same titles, ids TASK-001… in order.\n" +
    "- `Upstream References` must pin the exact approved revisions listed above.\n" +
    "- Each task's `References` must cite at least one existing REQ/FR/AC/DES id; `Dependencies` must be 'none' or earlier TASK ids (no cycles).",
  implementation:
    "- Execute tasks strictly in seq order using the persisted statuses below; `factory_task_update` with evidence is required to mark a task DONE.\n" +
    "- ALL tasks must be DONE (with evidence) before the phase can complete.\n" +
    "- `Approved Task Plan` must pin the recorded revision and the FULL sha256 of the approved task-plan artifact (copy it from /factory status).\n" +
    "- `Task Results` must contain one record per planned task with the same id and title, status COMPLETED, and the REAL recorded evidence (never fabricated).",
  verification:
    "- Every check must be recorded with `factory_check_record` (name, required, status, real output evidence).\n" +
    "- The phase cannot complete while any required check is FAILED or SKIPPED.\n" +
    "- `Pinned Revisions` must pin the recorded revisions and FULL sha256 of the approved spec and implementation artifacts (copy them from /factory status).\n" +
    "- `Checks` must mirror every recorded check: record title = check name, status mapped PASSED→PASS, FAILED→FAIL, SKIPPED→SKIPPED, MANUAL→NEEDS_HUMAN, and the same required flag ('yes'/'no').\n" +
    "- Each check's `Reference` must cite the AC/REQ id it verifies, or 'tooling' for build/test-infrastructure checks. `Coverage` must show how every AC is covered. The `Verdict` must match the recorded results (PASS only if no required check FAILED or was SKIPPED).",
};

export function buildPhasePrompt(ctx: PromptContext): string {
  const w = ctx.workflow;
  const phase = w.current_phase;
  const idx = PHASES.indexOf(phase) + 1;
  const artifactRel = `.factory/changes/${w.change_id}/${PHASE_ARTIFACT_FILE[phase]}`;

  const sections: string[] = [];
  sections.push(`# [factory] Work order: phase "${phase}" (${idx}/${PHASES.length}) — change ${w.change_id}`);
  sections.push(
    [
      "This message is one phase of an extension-managed workflow. The extension — not you — owns",
      "workflow state, transitions, and approvals. Rules:",
      `- Write the phase artifact to \`${artifactRel}\` (working directory: ${ctx.repoRoot}).`,
      "- Do not edit the `.factory/` state database or other phases' artifacts.",
      "- When — and only when — the completion contract below is satisfied, call the `factory_phase_complete` tool.",
      "- You cannot approve your own work: a human runs `/factory approve` afterwards.",
      "- If you cannot complete this phase, call `factory_report_failure` with a precise reason. Do not guess or hide failures.",
    ].join("\n"),
  );

  // Context from persisted state
  const ctxLines: string[] = [`## Persisted context`, `- Change: ${w.description}`, `- Change id: ${w.change_id}`];
  const approved = ctx.artifacts.filter((a) => PHASES.indexOf(a.phase) < idx);
  if (approved.length > 0) {
    ctxLines.push("- Approved artifacts so far:");
    for (const a of approved) {
      ctxLines.push(`  - ${a.phase}: \`${a.path}\` (revision ${a.revision}, sha256:${a.hash.slice(0, 12)}…) — read it before working.`);
    }
  } else {
    ctxLines.push("- No earlier approved artifacts (this is the first phase).");
  }
  if (phase === "implementation" && ctx.tasks.length > 0) {
    ctxLines.push("- Persisted task plan (authoritative for progress):");
    for (const t of ctx.tasks) {
      const ev = t.evidence ? ` — evidence: ${t.evidence.slice(0, 160)}` : "";
      ctxLines.push(`  ${t.seq}. [${t.status}] ${t.title}${ev}`);
    }
  }
  if (phase === "verification" && ctx.checks.length > 0) {
    ctxLines.push("- Checks already recorded:");
    for (const c of ctx.checks) ctxLines.push(`  - ${c.name} (${c.required ? "required" : "optional"}): ${c.status}`);
  }
  sections.push(ctxLines.join("\n"));

  if (ctx.restarted) {
    sections.push(
      "## Interrupted-run note\n" +
        "A previous execution of this phase may have been interrupted. Inspect the current artifact file, " +
        "task/check states, and repository changes first, and continue from there WITHOUT redoing work that is " +
        "already verified. Do not blindly re-run destructive or mutating commands.",
    );
  }

  if (ctx.rejection) {
    sections.push(
      "## Rejection feedback — this run is a REVISION\n" +
        `The previous version of this phase was REJECTED by ${ctx.rejection.reviewer ?? "a reviewer"} at ${ctx.rejection.resolved_at}:\n` +
        `> ${ctx.rejection.review_comment}\n\n` +
        "Revise the SAME phase artifact to address this feedback. Do not advance to the next phase; " +
        "when done, call `factory_phase_complete` for a new review.",
    );
  }

  sections.push(phaseTemplate(phase, ctx.promptsDir).trim());

  // Requirement phase only: Project Knowledge candidate discovery (the
  // original user prompt is analyzed here; nothing is persisted without the
  // extension-managed draft tool and the human approval gate).
  if (phase === "requirement" && ctx.projectKnowledge !== undefined) {
    sections.push(buildKnowledgeDiscoverySection(ctx.projectKnowledge, w.change_id));
  }

  // The pinned artifact contract: template + validation rules + expected revision
  // + upstream pins. All values come from persisted state, never the conversation.
  const contract = getContract(phase);
  const template = loadTemplate(contract);
  const currentFile = changeFile(ctx.repoRoot, w.change_id, phase);
  const currentText = readFileOrNull(currentFile);
  const latestCurrent = ctx.artifacts.filter((a) => a.phase === phase).at(-1) ?? null;
  const expectedRevision =
    currentText !== null && latestCurrent && sha256(currentText) === latestCurrent.hash
      ? latestCurrent.revision
      : latestCurrent
        ? latestCurrent.revision + 1
        : 1;

  const contractLines: string[] = [];
  contractLines.push("## Artifact contract (MANDATORY — enforced by the extension, not by you)");
  contractLines.push(
    [
      `The artifact file \`${artifactRel}\` MUST follow the template below exactly (contract ${contract.templateId}@${contract.templateVersion}, ` +
        `JSON Schema ${contract.schemaId}, parser ${contract.parserVersion}).`,
      "When you call `factory_phase_complete`, the extension deterministically parses the file and validates it against the JSON Schema, " +
        "phase-specific semantic rules, and cross-artifact traceability against the approved upstream artifacts. " +
        "Any ERROR rejects the candidate: nothing is recorded, no approval is requested, and the full error list is returned to you — " +
        "fix the file and call the tool again. Validation cannot be bypassed, reconfigured, or extended from this conversation.",
      `Set Metadata "Revision: ${expectedRevision}" and "Status: complete" in this candidate.`,
    ].join("\n"),
  );
  if (phase !== "requirement" && approved.length > 0) {
    contractLines.push("Approved upstream artifacts — pin these EXACT revisions (and full sha256 where the template asks for a hash):");
    for (const a of approved) {
      contractLines.push(`  - ${a.phase}: revision ${a.revision}, sha256:${a.hash}`);
    }
  }
  if (phase === "requirement") {
    const hist = readFileOrNull(changeFile(ctx.repoRoot, w.change_id, "requirement", REQUIREMENT_HISTORY_FILE));
    contractLines.push(
      hist
        ? `Requirements history so far (cite these entry ids in each REQ record's "Source"):\n${hist.trim()}`
        : "No requirements recorded yet — use `factory_requirement_append` for each user requirement, then cite the entry ids.",
    );
  }
  contractLines.push(
    "Template (copy its structure exactly; replace every placeholder comment and <angle-bracket> value with real content; keep section names and order):",
  );
  contractLines.push("```markdown\n" + template.trim() + "\n```");
  sections.push(contractLines.join("\n\n"));

  sections.push(
    "## Completion contract (enforced by the extension, not by you)\n" +
      `The artifact file \`${artifactRel}\` must exist, be fully valid against the artifact contract above, and satisfy the phase-specific rules below.\n` +
      PHASE_CONTRACT_EXTRA[phase] +
      "\nOnly after all of this is true, call `factory_phase_complete`. You may re-run `/factory validate` (ask the operator) at any time to see the current validation result.",
  );

  return sections.join("\n\n");
}
