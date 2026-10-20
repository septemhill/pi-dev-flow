import { FactoryEngine } from "../engine.ts";
import { describeError } from "../workflow/errors.ts";
import { PHASES, PHASE_ARTIFACT_FILE, nextPhase } from "../workflow/phases.ts";
import { buildPhasePrompt } from "../execution/phase-executor.ts";
import type { WorkflowSnapshot } from "../workflow/state.ts";

/**
 * The single `/factory` command dispatcher. pi commands do not have native
 * subcommands, so all sub-actions are parsed from the argument string:
 *
 *   /factory init <description>
 *   /factory status
 *   /factory run
 *   /factory approve [comment]
 *   /factory reject <reason>
 *   /factory resume
 *   /factory tasks
 *   /factory changes
 *
 * `sendPhasePrompt` is the only pi-runtime hook (pi.sendUserMessage);
 * everything else is engine code and stays unit-testable.
 */

export interface MinimalUI {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setWidget(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
}

export interface CommandCtxLike {
  cwd: string;
  mode: string;
  ui: MinimalUI;
  isIdle(): boolean;
  waitForIdle(): Promise<void>;
}

export interface FactoryDeps {
  engineFor: (cwd: string) => FactoryEngine;
  sendPhasePrompt: (prompt: string) => void;
}

export async function handleFactory(
  rawArgs: string,
  ctx: CommandCtxLike,
  deps: FactoryDeps,
): Promise<void> {
  const args = rawArgs.trim();
  const [sub, ...rest] = args.split(/\s+/);
  const restStr = rest.join(" ").trim();
  try {
    switch (sub) {
      case undefined:
      case "":
        show(ctx, usage());
        break;
      case "init":
        doInit(ctx, deps, restStr);
        break;
      case "status":
        doStatus(ctx, deps);
        break;
      case "run":
        await doRun(ctx, deps);
        break;
      case "approve":
        doApprove(ctx, deps, restStr);
        break;
      case "reject":
        doReject(ctx, deps, restStr);
        break;
      case "resume":
        doResume(ctx, deps);
        break;
      case "tasks":
        doTasks(ctx, deps);
        break;
      case "changes":
        doChanges(ctx, deps);
        break;
      default:
        show(ctx, [`Unknown subcommand "${sub}".`, ...usage()]);
    }
  } catch (e) {
    show(ctx, [describeError(e)]);
    ctx.ui.notify(describeError(e), "error");
  }
}

// ------------------------------------------------------------- sub-actions

function doInit(ctx: CommandCtxLike, deps: FactoryDeps, description: string): void {
  const engine = deps.engineFor(ctx.cwd);
  const w = engine.initChange(description);
  show(ctx, [
    `Change created: ${w.change_id}`,
    `Phase: requirement (1/${PHASES.length})  Status: IDLE`,
    `Artifact dir: .factory/changes/${w.change_id}/`,
    "Next: /factory run   (executes the requirement phase)",
  ]);
}

function doStatus(ctx: CommandCtxLike, deps: FactoryDeps): void {
  const engine = deps.engineFor(ctx.cwd);
  const s = engine.snapshot();
  if (!s.workflow) {
    show(ctx, ["No active change. Start one with: /factory init <description>"]);
    return;
  }
  show(ctx, renderStatus(s));
}

async function doRun(ctx: CommandCtxLike, deps: FactoryDeps): Promise<void> {
  const engine = deps.engineFor(ctx.cwd);
  const w = engine.requireActive();
  if (w.status === "COMPLETED") {
    show(ctx, [`Workflow for ${w.change_id} is COMPLETED. Start a new change with /factory init <description>.`]);
    return;
  }
  if (w.status === "FAILED") {
    show(ctx, [
      `Workflow is FAILED: ${w.failure_reason ?? "unknown reason"}`,
      "Recovery is explicit: run /factory resume, review the state, then /factory run.",
    ]);
    return;
  }
  // AWAITING_APPROVAL: beginCurrentPhase either throws PENDING_APPROVAL (a live
  // approval always blocks) or reopens the phase for a new review when the
  // stored approval was invalidated by an artifact change.
  let started: boolean;
  try {
    if (!ctx.isIdle()) await ctx.waitForIdle();
    started = engine.beginCurrentPhase();
  } catch (e) {
    show(ctx, [describeError(e)]);
    ctx.ui.notify(describeError(e), "error");
    return;
  }
  const s = engine.snapshot();
  const prompt = buildPhasePrompt({
    workflow: s.workflow!,
    artifacts: s.artifacts,
    rejection: s.lastRejection,
    tasks: s.tasks,
    checks: s.checks,
    restarted: !started,
    repoRoot: ctx.cwd,
  });
  deps.sendPhasePrompt(prompt);
  engine.notePromptSent(started ? "phase prompt sent to agent" : "re-prompt (possible interruption)");
  show(ctx, [
    started
      ? `Phase "${w.current_phase}" is RUNNING. The agent is executing it now.`
      : `Phase "${w.current_phase}" was already RUNNING — re-sent the phase work order (safe resume).`,
    "Watch for the 'awaiting approval' notification, then: /factory approve [comment] | /factory reject <reason>",
  ]);
}

function doApprove(ctx: CommandCtxLike, deps: FactoryDeps, comment: string): void {
  const engine = deps.engineFor(ctx.cwd);
  const { workflow, approval } = engine.approve(comment);
  const next = nextPhase(approval.phase);
  show(ctx, [
    `Approved phase "${approval.phase}" (${approval.id}).`,
    next
      ? `Workflow advanced to phase "${next}" (status IDLE). Run it explicitly with: /factory run`
      : "All six phases approved — the workflow is COMPLETED.",
    "Note: the next phase does NOT auto-execute; run it with /factory run.",
  ]);
}

function doReject(ctx: CommandCtxLike, deps: FactoryDeps, reason: string): void {
  const engine = deps.engineFor(ctx.cwd);
  const { workflow } = engine.reject(reason);
  show(ctx, [
    `Phase "${workflow.current_phase}" REJECTED. Feedback stored (approval history kept).`,
    "The same phase must be revised: run /factory run to start the revision, then review again.",
  ]);
}

function doResume(ctx: CommandCtxLike, deps: FactoryDeps): void {
  const engine = deps.engineFor(ctx.cwd);
  const { workflow, recovered } = engine.resume();
  show(ctx, [
    recovered
      ? `Recovered: workflow is now IDLE on phase "${workflow.current_phase}" (same phase, no skipping).`
      : `Nothing to recover (status ${workflow.status}). State verified consistent.`,
    "Continue with: /factory run",
  ]);
}

function doTasks(ctx: CommandCtxLike, deps: FactoryDeps): void {
  const engine = deps.engineFor(ctx.cwd);
  const w = engine.requireActive();
  const tasks = engine.listTasks();
  if (tasks.length === 0) {
    show(ctx, [`No task plan yet for ${w.change_id}. Plans appear after the task_planning phase.`]);
    return;
  }
  const done = tasks.filter((t) => t.status === "DONE").length;
  const lines = [`Task plan for ${w.change_id} — ${done}/${tasks.length} done`, ""];
  for (const t of tasks) {
    lines.push(`${t.seq}. [${t.status}] ${t.title}`);
    lines.push(`   scope: ${t.scope}`);
    lines.push(`   refs:  ${t.references}`);
    lines.push(`   verify: ${t.verification}`);
    if (t.evidence) lines.push(`   evidence: ${t.evidence.slice(0, 200)}`);
  }
  show(ctx, lines);
}

function doChanges(ctx: CommandCtxLike, deps: FactoryDeps): void {
  const engine = deps.engineFor(ctx.cwd);
  const all = engine.listWorkflows();
  if (all.length === 0) {
    show(ctx, ["No changes recorded yet."]);
    return;
  }
  const active = engine.getActiveWorkflow();
  show(
    ctx,
    all.map((w) =>
      `${w.change_id === active?.change_id ? "*" : " "} ${w.change_id}  [${w.status}]  phase=${w.current_phase}\n    ${w.description}`,
    ),
  );
}

// ------------------------------------------------------------- rendering

function usage(): string[] {
  return [
    "Factory commands:",
    "  /factory init <description>   create a new change (starts at requirement)",
    "  /factory status               show phase, status, artifact, approval, tasks",
    "  /factory run                  execute/resume the current phase (never bypasses approvals)",
    "  /factory approve [comment]    approve the pending phase artifact (human gate)",
    "  /factory reject <reason>      reject it; the same phase must be revised",
    "  /factory resume               verify integrity + recover FAILED/interrupted workflows",
    "  /factory tasks                show the task plan and progress",
    "  /factory changes              list all changes",
  ];
}

function renderStatus(s: WorkflowSnapshot): string[] {
  const w = s.workflow!;
  const idx = PHASES.indexOf(w.current_phase) + 1;
  const latest = s.artifacts.filter((a) => a.phase === w.current_phase).at(-1);
  const lines: string[] = [
    `Change:    ${w.change_id}`,
    `Phase:     ${w.current_phase} (${idx}/${PHASES.length})`,
    `Status:    ${w.status}`,
    `Revision:  ${w.revision}`,
  ];
  if (latest) {
    lines.push(`Artifact:  ${PHASE_ARTIFACT_FILE[w.current_phase]} rev ${latest.revision} sha256:${latest.hash.slice(0, 16)}…`);
  }
  if (s.pendingApproval) {
    lines.push(
      `Approval:  PENDING ${s.pendingApproval.id} (rev ${s.pendingApproval.artifact_revision}) — ` +
        "run /factory approve [comment] or /factory reject <reason>",
    );
  }
  if (w.status === "FAILED") lines.push(`Failure:   ${w.failure_reason}`);
  if (s.lastRejection && s.lastRejection.phase === w.current_phase) {
    lines.push(`Last rejection (${s.lastRejection.phase}): ${s.lastRejection.review_comment}`);
  }
  if (s.tasks.length > 0) {
    const done = s.tasks.filter((t) => t.status === "DONE").length;
    lines.push(`Tasks:     ${done}/${s.tasks.length} done — ` + s.tasks.map((t) => `${t.seq}:${t.status}`).join(" "));
  }
  if (s.checks.length > 0) {
    lines.push(`Checks:    ` + s.checks.map((c) => `${c.name}=${c.status}`).join(", "));
  }
  if (s.recentEvents.length > 0) {
    const last = s.recentEvents[s.recentEvents.length - 1];
    lines.push(`Last event: ${last.created_at} ${last.kind}${last.detail ? ` — ${last.detail}` : ""}`);
  }
  return lines;
}

function show(ctx: CommandCtxLike, lines: string[]): void {
  const text = lines.join("\n");
  if (ctx.mode === "tui") {
    try {
      ctx.ui.setWidget("factory", ["── factory ──", ...lines], { placement: "belowEditor" });
    } catch {
      /* widget is cosmetic */
    }
  }
  ctx.ui.notify(text);
}
