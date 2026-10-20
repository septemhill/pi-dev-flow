/**
 * pi-ai-software-factory — a pi Extension.
 *
 * Loads with:
 *   pi --extension /path/to/pi-ai-factory/index.ts
 * or by placing/symlinking this directory into the project `.pi/extensions/`
 * or user `~/.pi/agent/extensions/` directory.
 *
 * Registers:
 *   - one command:  /factory (init | status | run | approve | reject | resume | tasks | changes)
 *   - restricted tools the phase LLM may call (never full state control):
 *       factory_phase_complete, factory_requirement_append, factory_set_task_plan,
 *       factory_task_update, factory_check_record, factory_report_failure
 *
 * The LLM proposes content; this extension enforces the workflow state machine,
 * artifact contracts, hashes, and human approval gates. See README.md.
 */
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FactoryEngine } from "./src/engine.ts";
import { handleFactory } from "./src/commands/factory.ts";
import { describeError } from "./src/workflow/errors.ts";

const engines = new Map<string, FactoryEngine>();
function engineFor(cwd: string): FactoryEngine {
  let e = engines.get(cwd);
  if (!e) {
    e = new FactoryEngine(cwd);
    engines.set(cwd, e);
  }
  return e;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}
function fail(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined, isError: true };
}

function refreshWidget(engine: FactoryEngine, ui: { setWidget(key: string, c: string[] | undefined, o?: { placement?: "aboveEditor" | "belowEditor" }): void }): void {
  try {
    const s = engine.snapshot();
    if (!s.workflow) {
      ui.setWidget("factory", undefined);
      return;
    }
    const w = s.workflow;
    ui.setWidget(
      "factory",
      [
        `factory: ${w.change_id} — ${w.current_phase} [${w.status}]` +
          (s.pendingApproval ? "  ·  approval pending: /factory approve" : ""),
      ],
      { placement: "belowEditor" },
    );
  } catch {
    /* cosmetic only */
  }
}

export default function factoryExtension(pi: ExtensionAPI) {
  const deps = {
    engineFor,
    sendPhasePrompt: (prompt: string) => {
      // pi-supported mechanism for LLM execution: hand the phase work order to
      // the agent as a user message. The agent runs with its normal tools plus
      // the factory_* tools below; the extension validates everything after.
      pi.sendUserMessage(prompt);
    },
  };

  pi.registerCommand("factory", {
    description:
      "AI Software Factory: /factory init|status|run|approve|reject|resume|tasks|changes",
    handler: async (args, ctx) => {
      await handleFactory(args, ctx, deps);
      try {
        refreshWidget(engineFor(ctx.cwd), ctx.ui);
      } catch {
        /* state may not exist yet */
      }
    },
  });

  // ------------------------------------------------------------------ tools
  // Every tool re-reads persisted state and enforces phase/status rules in
  // code. The LLM can trigger these narrow operations; it cannot set status,
  // skip phases, or approve its own output (approvals are command-only).

  pi.registerTool({
    name: "factory_phase_complete",
    label: "Factory: complete phase",
    description:
      "Signal that the current factory phase's artifact is finished. The extension validates the artifact " +
      "(required sections, phase-specific invariants), records its revision and sha256, creates a human approval " +
      "request, and pauses the workflow at AWAITING_APPROVAL. Returns an actionable error listing every missing " +
      "piece if validation fails — fix and retry.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      try {
        const engine = engineFor(ctx.cwd);
        const { workflow, approval, artifact } = engine.completeCurrentPhase();
        refreshWidget(engine, ctx.ui);
        return ok(
          `Phase "${workflow.current_phase}" completed and validated.\n` +
            `Artifact: ${artifact.path} (revision ${artifact.revision}, sha256:${artifact.hash.slice(0, 16)}…)\n` +
            `Approval ${approval.id} is PENDING — the workflow is paused. A human must run /factory approve [comment] ` +
            `or /factory reject <reason>. Do not continue to later-phase work.`,
        );
      } catch (e) {
        return fail(describeError(e));
      }
    },
  });

  pi.registerTool({
    name: "factory_requirement_append",
    label: "Factory: append requirement",
    description:
      "Append ONE user-provided requirement (original statement, verbatim) to the append-only requirement history. " +
      "Only available while the requirement phase is RUNNING. History entries can never be edited or removed through this tool.",
    parameters: Type.Object({
      statement: Type.String({ description: "The user's requirement, original wording" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const engine = engineFor(ctx.cwd);
        const { entry } = engine.appendRequirement(params.statement);
        return ok(`Requirement R${entry} recorded in the append-only history.`);
      } catch (e) {
        return fail(describeError(e));
      }
    },
  });

  pi.registerTool({
    name: "factory_set_task_plan",
    label: "Factory: set task plan",
    description:
      "Record the ordered implementation task plan (3-8 small tasks). Each task needs title, scope, references " +
      "(spec acceptance criteria / design decisions), and verification. Only available while the task_planning " +
      "phase is RUNNING. Replaces the plan only when replace=true.",
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          title: Type.String({ description: "Short imperative task name" }),
          scope: Type.String({ description: "Exactly what this task changes; what it must not touch" }),
          references: Type.String({ description: "Spec/design criteria implemented, e.g. 'AC-2, D1'" }),
          verification: Type.String({ description: "How the result is verified (command/test/observation)" }),
        }),
        { minItems: 1, maxItems: 15 },
      ),
      replace: Type.Optional(Type.Boolean({ description: "Overwrite an existing plan" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const engine = engineFor(ctx.cwd);
        const tasks = engine.setTaskPlan(params.tasks, params.replace ?? false);
        return ok(`Task plan recorded: ${tasks.length} task(s).\n` + tasks.map((t) => `${t.seq}. ${t.title}`).join("\n"));
      } catch (e) {
        return fail(describeError(e));
      }
    },
  });

  pi.registerTool({
    name: "factory_task_update",
    label: "Factory: update task",
    description:
      "Update one implementation task's status (PENDING | IN_PROGRESS | DONE). Marking DONE requires `evidence`: " +
      "the verification command(s) run and their key output. Only available while the implementation phase is RUNNING.",
    parameters: Type.Object({
      seq: Type.Number({ description: "Task sequence number from the plan" }),
      status: Type.Union([Type.Literal("PENDING"), Type.Literal("IN_PROGRESS"), Type.Literal("DONE")]),
      evidence: Type.Optional(Type.String({ description: "Required for DONE: command + key output proving the task" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const engine = engineFor(ctx.cwd);
        const t = engine.updateTask(params.seq, params.status, params.evidence ?? "");
        return ok(`Task ${t.seq} is now ${t.status}.`);
      } catch (e) {
        return fail(describeError(e));
      }
    },
  });

  pi.registerTool({
    name: "factory_check_record",
    label: "Factory: record check",
    description:
      "Record one verification check result: name, required (default true), status (PASSED | FAILED | SKIPPED | MANUAL), " +
      "and real output evidence. Only available while the verification phase is RUNNING. The phase cannot complete " +
      "while a required check is FAILED or SKIPPED.",
    parameters: Type.Object({
      name: Type.String({ description: "Stable check name, e.g. 'unit-tests' or 'AC-1 output format'" }),
      required: Type.Optional(Type.Boolean({ description: "Default true" })),
      status: Type.Union([Type.Literal("PASSED"), Type.Literal("FAILED"), Type.Literal("SKIPPED"), Type.Literal("MANUAL")]),
      output: Type.String({ description: "Command + relevant output; reason when SKIPPED; what a human must do when MANUAL" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const engine = engineFor(ctx.cwd);
        const c = engine.recordCheck(params.name, params.required ?? true, params.status, params.output);
        return ok(`Check "${c.name}" recorded: ${c.status}.`);
      } catch (e) {
        return fail(describeError(e));
      }
    },
  });

  pi.registerTool({
    name: "factory_report_failure",
    label: "Factory: report failure",
    description:
      "Explicitly mark the current phase execution as FAILED with a reason (used when a phase cannot be completed). " +
      "Existing data is preserved; the workflow needs /factory resume before it can run again.",
    parameters: Type.Object({
      reason: Type.String({ description: "Precise, actionable description of the failure" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const engine = engineFor(ctx.cwd);
        engine.fail(params.reason);
        refreshWidget(engine, ctx.ui);
        return ok(
          `Workflow marked FAILED (${params.reason}). The human operator runs /factory resume to recover, then /factory run.`,
        );
      } catch (e) {
        return fail(describeError(e));
      }
    },
  });

  // ------------------------------------------------------------------ lifecycle

  pi.on("session_start", (_event, ctx) => {
    try {
      refreshWidget(engineFor(ctx.cwd), ctx.ui);
    } catch {
      /* no .factory yet — nothing to show */
    }
  });

  pi.on("session_shutdown", () => {
    for (const e of engines.values()) e.close();
    engines.clear();
  });
}
