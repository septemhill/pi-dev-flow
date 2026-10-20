import type {
  ApprovalRecord,
  ArtifactRecord,
  CheckRecord,
  TaskRecord,
  WorkflowRecord,
} from "../workflow/state.ts";
import { PHASES, PHASE_ARTIFACT_FILE, REQUIRED_SECTIONS, type Phase } from "../workflow/phases.ts";
import { phaseTemplate } from "../prompts.ts";

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
}

const PHASE_CONTRACT_EXTRA: Record<Phase, string> = {
  requirement:
    "- Every user requirement must be recorded with the `factory_requirement_append` tool (append-only history).\n" +
    "- The consolidated artifact must cover all history entries and list open questions/assumptions.",
  spec: "- Each acceptance criterion must be externally verifiable and cite the requirement(s) justifying it.",
  design: "- The design must map every acceptance criterion to a component or decision.",
  task_planning:
    "- The plan must be recorded with the `factory_set_task_plan` tool (3-8 small tasks, each with scope, spec/design references, and verification).\n" +
    "- `task-plan.md` must mirror the recorded plan.",
  implementation:
    "- Execute tasks strictly in seq order using the persisted statuses below; `factory_task_update` with evidence is required to mark a task DONE.\n" +
    "- ALL tasks must be DONE (with evidence) before the phase can complete.",
  verification:
    "- Every check must be recorded with `factory_check_record` (name, required, status, real output evidence).\n" +
    "- The phase cannot complete while any required check is FAILED or SKIPPED.",
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

  const sectionsList = REQUIRED_SECTIONS[phase]
    .map((s) => `- "${s}"`)
    .join("\n");
  sections.push(
    "## Completion contract (enforced by the extension, not by you)\n" +
      `The artifact file \`${artifactRel}\` must exist and contain at least these sections:\n${sectionsList}\n` +
      PHASE_CONTRACT_EXTRA[phase] +
      "\nOnly after all of this is true, call `factory_phase_complete`.",
  );

  return sections.join("\n\n");
}
