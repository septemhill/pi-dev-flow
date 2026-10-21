import type { ArtifactContract, ParsedDocument, ParsedRecord, ValidationIssue } from "./artifact-types.ts";
import type { PhaseContext } from "./validation-context.ts";
import { reportStatusForCheck } from "./validation-context.ts";
import { normalizeId } from "./traceability-validator.ts";
import type { Phase } from "../workflow/phases.ts";

function mentionedIds(text: string, prefix: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(new RegExp(`\\b${prefix}-(\\d+)\\b`, "g"))) {
    out.add(`${prefix}-${m[1]!.padStart(3, "0")}`);
  }
  return out;
}

/**
 * Phase-specific SEMANTIC validation layer: invariants that JSON Schema cannot
 * express — cross-field rules, agreement with persisted extension state (task
 * plan, checks, requirement history, approved upstream revisions). JSON Schema
 * checks field shape; this layer checks meaning. Reference RESOLUTION against
 * upstream documents lives in traceability-validator.ts.
 *
 * All functions are pure: (contract, parsed, ctx, upstreamIds) → issues.
 */

/** Id sets collected from the parsed upstream artifacts (see traceability-validator). */
export interface UpstreamIds {
  requirement: Set<string>;
  functional: Set<string>;
  acceptance: Set<string>;
  design: Set<string>;
}

export function semanticIssues(
  contract: ArtifactContract,
  parsed: ParsedDocument,
  ctx: PhaseContext,
  ids: UpstreamIds,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const md = (parsed.doc.metadata ?? null) as Record<string, unknown> | null;
  if (md) issues.push(...metadataIssues(contract, md, ctx));
  // Upstream phases recorded before template-driven validation. Their ids are
  // not guaranteed, and the traceability layer already reports one actionable
  // TRACE_UPSTREAM_LEGACY error per such phase — so the per-reference
  // resolution checks below are suppressed for those phases (no flood).
  const legacyPhases = new Set(ctx.upstream.filter((u) => u.legacy).map((u) => u.phase));
  switch (contract.phase) {
    case "requirement":
      issues.push(...requirementSemantic(contract, parsed, ctx));
      break;
    case "spec":
      issues.push(...specSemantic(contract, parsed, ids, legacyPhases));
      break;
    case "design":
      issues.push(...designSemantic(contract, parsed, ids));
      break;
    case "task_planning":
      issues.push(...taskPlanSemantic(contract, parsed, ctx, ids, legacyPhases));
      break;
    case "implementation":
      issues.push(...implementationSemantic(contract, parsed, ctx));
      break;
    case "verification":
      issues.push(...verificationSemantic(contract, parsed, ctx, ids, legacyPhases));
      break;
  }
  return issues;
}

function v(
  contract: ArtifactContract,
  code: string,
  message: string,
  severity: ValidationIssue["severity"] = "ERROR",
  opts: { section?: string; fieldPath?: string; relatedArtifact?: string; relatedId?: string; suggestedFix?: string } = {},
): ValidationIssue {
  return {
    code,
    severity,
    message,
    artifactType: contract.artifactType,
    rule: "semantic",
    section: opts.section,
    fieldPath: opts.fieldPath,
    relatedArtifact: opts.relatedArtifact,
    relatedId: opts.relatedId,
    suggestedFix: opts.suggestedFix,
  };
}

// ---------------------------------------------------------------- common

function metadataIssues(contract: ArtifactContract, md: Record<string, unknown>, ctx: PhaseContext): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const at = contract.artifactType;
  if (md.artifactType !== at) {
    out.push(
      v(contract, "SEM_BAD_ARTIFACT_TYPE", `Metadata "Artifact Type" is "${String(md.artifactType)}" but this phase produces "${at}" artifacts.`, "ERROR", {
        fieldPath: "metadata.artifactType",
        section: "Metadata",
        suggestedFix: `Set "- Artifact Type: ${at}".`,
      }),
    );
  }
  if (md.contractVersion !== contract.templateVersion) {
    out.push(
      v(contract, "SEM_CONTRACT_VERSION_MISMATCH", `Metadata "Contract Version" is "${String(md.contractVersion)}" but the active contract is ${contract.templateId}@${contract.templateVersion}. The LLM cannot change the contract version.`, "ERROR", {
        fieldPath: "metadata.contractVersion",
        section: "Metadata",
        suggestedFix: `Set "- Contract Version: ${contract.templateVersion}".`,
      }),
    );
  }
  if (md.changeId !== ctx.changeId) {
    out.push(
      v(contract, "SEM_CHANGE_MISMATCH", `Metadata "Change ID" is "${String(md.changeId)}" but the active change is ${ctx.changeId}.`, "ERROR", {
        fieldPath: "metadata.changeId",
        section: "Metadata",
        suggestedFix: `Set "- Change ID: ${ctx.changeId}".`,
      }),
    );
  }
  if (typeof md.revision === "number" && md.revision !== ctx.expectedRevision) {
    out.push(
      v(contract, "SEM_REVISION_MISMATCH", `Metadata "Revision" is ${md.revision} but the extension will record this candidate as revision ${ctx.expectedRevision}.`, "ERROR", {
        fieldPath: "metadata.revision",
        section: "Metadata",
        suggestedFix: `Set "- Revision: ${ctx.expectedRevision}".`,
      }),
    );
  }
  if (md.status !== "complete") {
    out.push(
      v(contract, "SEM_STATUS_NOT_COMPLETE", `Metadata "Status" is "${String(md.status)}"; a candidate submitted for review must be "complete".`, "ERROR", {
        fieldPath: "metadata.status",
        section: "Metadata",
        suggestedFix: 'Set "- Status: complete" when the document is finished.',
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------- phases

function recordOf(parsed: ParsedDocument, sectionName: string): ParsedRecord[] {
  return parsed.sections[sectionName]?.records ?? [];
}

function requirementSemantic(contract: ArtifactContract, parsed: ParsedDocument, ctx: PhaseContext): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const recs = recordOf(parsed, "Requirements");
  const cited = new Set<number>();
  for (const r of recs) {
    const source = r.fields["Source"] ?? "";
    const refs = [...source.matchAll(/\bR([0-9]+)\b/g)].map((m) => Number(m[1]));
    for (const n of refs) {
      cited.add(n);
      if (!ctx.historyIds.includes(n)) {
        out.push(
          v(contract, "SEM_BAD_REF", `Requirement ${r.id} cites history entry R${n}, which does not exist in requirements-history.md (recorded: ${ctx.historyIds.length ? ctx.historyIds.map((i) => `R${i}`).join(", ") : "none"}).`, "ERROR", {
            section: "Requirements",
            relatedId: r.id,
            suggestedFix: "Cite an existing history entry, or record the statement with factory_requirement_append first.",
          }),
        );
      }
    }
    if (refs.length === 0) {
      out.push(
        v(contract, "SEM_SOURCE_UNCITED", `Requirement ${r.id} cites no requirements-history entry in its Source ("${source}"); original statements must stay traceable.`, "WARNING", {
          section: "Requirements",
          relatedId: r.id,
          suggestedFix: "Set Source to the history entry id (e.g. R1) or 'Consolidated (R1, R2)' when merging entries.",
        }),
      );
    }
  }
  for (const h of ctx.historyIds) {
    if (!cited.has(h)) {
      out.push(
        v(contract, "SEM_UNCOVERED_HISTORY", `Requirements-history entry R${h} is not cited by any consolidated requirement.`, "WARNING", {
          section: "Requirements",
          relatedId: `R${h}`,
          suggestedFix: "Add a requirement (or extend an existing Source) that cites R" + h + ".",
        }),
      );
    }
  }
  return out;
}

function refsFieldIds(value: string, prefix: string): string[] {
  return [...value.matchAll(new RegExp(`\\b${prefix}-(\\d+)\\b`, "g"))].map((m) => m[0]!);
}

function specSemantic(contract: ArtifactContract, parsed: ParsedDocument, ids: UpstreamIds, legacyPhases: ReadonlySet<Phase> = new Set()): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const checkRefs = (rec: ParsedRecord, section: string, field: string) => {
    const value = rec.fields[field] ?? "";
    const mentioned = refsFieldIds(value, "REQ");
    if (mentioned.length === 0) {
      out.push(
        v(contract, "SEM_MISSING_REF", `${rec.id} (${section}) must reference at least one requirement id (REQ-###) in "${field}".`, "ERROR", {
          section,
          relatedId: rec.id,
          suggestedFix: "Cite the requirement(s) this item derives from.",
        }),
      );
      return;
    }
    // A legacy upstream cannot have its ids trusted; the single
    // TRACE_UPSTREAM_LEGACY error already covers it, so skip resolution.
    if (legacyPhases.has("requirement")) return;
    for (const id of mentioned) {
      if (!ids.requirement.has(normalizeId(id))) {
        out.push(
          v(contract, "SEM_BAD_REF", `${rec.id} (${section}) references ${id}, which does not exist in the approved requirement artifact.`, "ERROR", {
            section,
            relatedId: id,
            relatedArtifact: "requirement",
          }),
      );
      }
    }
  };
  for (const r of recordOf(parsed, "Acceptance Criteria")) checkRefs(r, "Acceptance Criteria", "References");
  for (const r of recordOf(parsed, "Functional Requirements")) checkRefs(r, "Functional Requirements", "References");

  const listed = parsed.sections["Referenced Requirements"]?.items ?? [];
  if (!legacyPhases.has("requirement")) {
    for (const item of listed) {
      if (!ids.requirement.has(normalizeId(item))) {
        out.push(
          v(contract, "SEM_BAD_REF", `Referenced Requirements lists ${item}, which does not exist in the approved requirement artifact.`, "ERROR", {
            section: "Referenced Requirements",
            relatedId: item,
            relatedArtifact: "requirement",
          }),
        );
      }
    }
  }
  for (const id of ids.requirement) {
    if (!listed.includes(id)) {
      out.push(
        v(contract, "SEM_UNREFERENCED_REQ", `Approved requirement ${id} is not listed in Referenced Requirements and is not referenced by any acceptance criterion or functional requirement.`, "WARNING", {
          section: "Referenced Requirements",
          relatedId: id,
          relatedArtifact: "requirement",
          suggestedFix: "List it in Referenced Requirements (and map it to an AC), or note in Unresolved Questions why it is out of scope here.",
        }),
      );
    }
  }
  return out;
}

function docText(parsed: ParsedDocument): string {
  return JSON.stringify(parsed.doc);
}

function designSemantic(contract: ArtifactContract, parsed: ParsedDocument, ids: UpstreamIds): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const text = docText(parsed);
  const mentionedAc = mentionedIds(text, "AC");
  for (const ac of ids.acceptance) {
    if (!mentionedAc.has(ac)) {
      out.push(
        v(contract, "SEM_UNCOVERED_AC", `Acceptance criterion ${ac} of the approved spec is not addressed anywhere in the design.`, "ERROR", {
          relatedId: ac,
          relatedArtifact: "spec",
          suggestedFix: `Map ${ac} to a component, interface, or design decision (mention its id explicitly).`,
        }),
      );
    }
  }
  return out;
}

function upstreamRef(ctx: PhaseContext, phase: Phase): number | null {
  return ctx.upstream.find((u) => u.phase === phase)?.revision ?? null;
}

function taskPlanSemantic(contract: ArtifactContract, parsed: ParsedDocument, ctx: PhaseContext, ids: UpstreamIds, legacyPhases: ReadonlySet<Phase> = new Set()): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const recs = recordOf(parsed, "Tasks");

  // Mirror of the tool-recorded plan (the extension's authoritative plan).
  if (ctx.tasks.length > 0 && recs.length !== ctx.tasks.length) {
    out.push(
      v(contract, "SEM_PLAN_MISMATCH", `The artifact lists ${recs.length} task(s) but the recorded plan has ${ctx.tasks.length}; the document must mirror the plan recorded with factory_set_task_plan exactly.`, "ERROR", {
        section: "Tasks",
        suggestedFix: "Re-record the plan with factory_set_task_plan (replace=true) or rewrite the Tasks section to match it.",
      }),
    );
  }
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]!;
    const want = `TASK-${String(i + 1).padStart(3, "0")}`;
    if (rec.id !== want) {
      out.push(
        v(contract, "SEM_PLAN_MISMATCH", `Task record ${i + 1} has id ${rec.id}; task order is fixed by the recorded plan, so it must be ${want}.`, "ERROR", {
          section: "Tasks",
          relatedId: rec.id,
        }),
      );
    }
    const db = ctx.tasks[i];
    if (db && rec.title !== db.title) {
      out.push(
        v(contract, "SEM_PLAN_MISMATCH", `Task ${rec.id} title "${rec.title}" differs from the recorded plan title "${db.title}"; the plan cannot silently change.`, "ERROR", {
          section: "Tasks",
          relatedId: rec.id,
        }),
      );
    }
  }

  // Dependencies: must resolve, must be acyclic.
  const idSet = new Set(recs.map((r) => r.id));
  const graph = new Map<string, string[]>();
  for (const rec of recs) {
    const depsField = rec.fields["Dependencies"] ?? "none";
    const deps = depsField === "none" ? [] : depsField.split(",").map((d) => d.trim()).filter((d) => d !== "");
    graph.set(rec.id, deps);
    for (const d of deps) {
      if (!idSet.has(d)) {
        out.push(
          v(contract, "SEM_BAD_REF", `Task ${rec.id} depends on ${d}, which is not a task in this plan.`, "ERROR", {
            section: "Tasks",
            relatedId: d,
          }),
        );
      } else if (Number(d.replace("TASK-", "")) > Number(rec.id.replace("TASK-", ""))) {
        out.push(
          v(contract, "SEM_FWD_DEPENDENCY", `Task ${rec.id} depends on ${d}, which runs later; dependencies must point to earlier tasks (execution is sequential in id order).`, "WARNING", {
            section: "Tasks",
            relatedId: rec.id,
          }),
        );
      }
    }
  }
  // Cycle detection (DFS, only among known ids).
  const state = new Map<string, number>(); // 0 unvisited 1 visiting 2 done
  const visit = (n: string): boolean => {
    const s = state.get(n) ?? 0;
    if (s === 1) return true;
    if (s === 2) return false;
    state.set(n, 1);
    for (const d of graph.get(n) ?? []) {
      if (idSet.has(d) && visit(d)) return true;
    }
    state.set(n, 2);
    return false;
  };
  for (const n of idSet) {
    if (visit(n)) {
      out.push(
        v(contract, "SEM_CYCLE", "The task dependency graph contains a cycle.", "ERROR", {
          section: "Tasks",
          suggestedFix: "Break the cycle: dependencies must form a strict order.",
        }),
      );
      break;
    }
  }

  // References must resolve upstream.
  for (const rec of recs) {
    const refs = rec.fields["References"] ?? "";
    const mentioned = [...refs.matchAll(/\b(REQ|FR|AC|DES)-(\d+)\b/g)].map((m) => m[0]!);
    if (mentioned.length === 0) {
      out.push(
        v(contract, "SEM_MISSING_REF", `Task ${rec.id} must reference at least one upstream item (REQ-###, FR-###, AC-### or DES-###) in "References".`, "ERROR", {
          section: "Tasks",
          relatedId: rec.id,
        }),
      );
    }
    for (const id of mentioned) {
      const p = id.split("-")[0]!;
      const upstreamPhase: Phase = p === "REQ" ? "requirement" : p === "DES" ? "design" : "spec";
      if (legacyPhases.has(upstreamPhase)) continue;
      const set = p === "REQ" ? ids.requirement : p === "FR" ? ids.functional : p === "AC" ? ids.acceptance : ids.design;
      if (!set.has(normalizeId(id))) {
        out.push(
          v(contract, "SEM_BAD_REF", `Task ${rec.id} references ${id}, which does not exist in the approved upstream artifacts.`, "ERROR", {
            section: "Tasks",
            relatedId: id,
          }),
        );
      }
    }
  }

  // Pinned upstream revisions.
  const kv = parsed.sections["Upstream References"]?.kv ?? {};
  const pin: Array<[string, Phase]> = [
    ["Requirement", "requirement"],
    ["Spec", "spec"],
    ["Design", "design"],
  ];
  for (const [key, phase] of pin) {
    const want = upstreamRef(ctx, phase);
    const got = kv[key];
    if (want === null) continue;
    if (got !== undefined && got !== String(want)) {
      out.push(
        v(contract, "SEM_STALE_REVISION", `Upstream References pins ${phase} at revision ${got}, but the approved revision is ${want}.`, "ERROR", {
          section: "Upstream References",
          relatedArtifact: phase,
          suggestedFix: `Re-base the plan on revision ${want} of the ${phase} artifact (set "- ${key}: ${want}").`,
        }),
      );
    }
  }
  return out;
}

function implementationSemantic(contract: ArtifactContract, parsed: ParsedDocument, ctx: PhaseContext): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const plan = ctx.upstream.find((u) => u.phase === "task_planning");
  const kv = parsed.sections["Approved Task Plan"]?.kv ?? {};
  if (plan) {
    if (kv["Revision"] !== undefined && kv["Revision"] !== String(plan.revision)) {
      out.push(
        v(contract, "SEM_STALE_REVISION", `Approved Task Plan pins revision ${kv["Revision"]}, but the approved task-plan artifact is revision ${plan.revision}.`, "ERROR", {
          section: "Approved Task Plan",
          relatedArtifact: "task_planning",
          suggestedFix: `Implement against task-plan revision ${plan.revision} (set "- Revision: ${plan.revision}").`,
        }),
      );
    }
    if (kv["Hash"] !== undefined && kv["Hash"] !== `sha256:${plan.hash}`) {
      out.push(
        v(contract, "SEM_PLAN_HASH_MISMATCH", `Approved Task Plan hash ${kv["Hash"]} does not match the approved task-plan artifact (sha256:${plan.hash.slice(0, 16)}…). The implementation must use the exact approved plan.`, "ERROR", {
          section: "Approved Task Plan",
          relatedArtifact: "task_planning",
          suggestedFix: `Copy the full hash from /factory status (sha256:${plan.hash}).`,
        }),
      );
    }
  }

  const recs = recordOf(parsed, "Task Results");
  const byId = new Map(recs.map((r) => [r.id, r]));
  for (const t of ctx.tasks) {
    const tid = `TASK-${String(t.seq).padStart(3, "0")}`;
    const rec = byId.get(tid);
    if (!rec) {
      out.push(
        v(contract, "SEM_UNCOVERED_TASK", `Planned task ${tid} ("${t.title}") has no result record in Task Results.`, "ERROR", {
          section: "Task Results",
          relatedId: tid,
        }),
      );
      continue;
    }
    const status = rec.fields["Status"];
    if (status === "COMPLETED") {
      if (t.status !== "DONE") {
        out.push(
          v(contract, "SEM_EVIDENCE_MISMATCH", `Task ${tid} is reported COMPLETED but its persisted status is ${t.status}; a task is completed only when factory_task_update recorded it DONE with evidence.`, "ERROR", {
            section: "Task Results",
            relatedId: tid,
            suggestedFix: "Run the task's verification and mark it DONE with real evidence via factory_task_update, then re-record this result.",
          }),
        );
      } else if (!(t.evidence ?? "").trim()) {
        out.push(
          v(contract, "SEM_EVIDENCE_MISMATCH", `Task ${tid} is DONE but has no persisted evidence.`, "ERROR", {
            section: "Task Results",
            relatedId: tid,
          }),
        );
      }
    } else if (status === "FAILED" || status === "BLOCKED") {
      out.push(
        v(contract, "SEM_TASK_NOT_COMPLETE", `Task ${tid} is reported ${status}; the implementation phase cannot complete with failed or blocked tasks.`, "ERROR", {
          section: "Task Results",
          relatedId: tid,
          suggestedFix: "Fix or unblock the task, or call factory_report_failure with the reason.",
        }),
      );
    } else if (status === "NOT_STARTED") {
      out.push(
        v(contract, "SEM_TASK_NOT_COMPLETE", `Task ${tid} was never started; all planned tasks must be COMPLETED before the phase can complete.`, "ERROR", {
          section: "Task Results",
          relatedId: tid,
        }),
      );
    }
    if (t.status !== "DONE") {
      out.push(
        v(contract, "SEM_TASKS_INCOMPLETE", `Persisted task ${tid} ("${t.title}") is ${t.status}, not DONE (with evidence).`, "ERROR", {
          section: "Task Results",
          relatedId: tid,
        }),
      );
    }
  }
  for (const rec of recs) {
    if (!ctx.tasks.some((t) => `TASK-${String(t.seq).padStart(3, "0")}` === rec.id)) {
      out.push(
        v(contract, "SEM_BAD_REF", `Task Results records ${rec.id}, which is not part of the approved task plan.`, "ERROR", {
          section: "Task Results",
          relatedId: rec.id,
        }),
      );
    }
  }
  return out;
}

function verificationSemantic(contract: ArtifactContract, parsed: ParsedDocument, ctx: PhaseContext, ids: UpstreamIds, legacyPhases: ReadonlySet<Phase> = new Set()): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const specUp = ctx.upstream.find((u) => u.phase === "spec");
  const implUp = ctx.upstream.find((u) => u.phase === "implementation");
  const kv = parsed.sections["Pinned Revisions"]?.kv ?? {};
  if (specUp) {
    if (kv["Specification Revision"] !== undefined && kv["Specification Revision"] !== String(specUp.revision)) {
      out.push(
        v(contract, "SEM_STALE_REVISION", `Pinned Revisions pins the specification at revision ${kv["Specification Revision"]}, but the approved spec is revision ${specUp.revision}.`, "ERROR", {
          section: "Pinned Revisions",
          relatedArtifact: "spec",
        }),
      );
    }
    if (kv["Specification Hash"] !== undefined && kv["Specification Hash"] !== `sha256:${specUp.hash}`) {
      out.push(
        v(contract, "SEM_PIN_HASH_MISMATCH", `Pinned specification hash does not match the approved spec artifact.`, "ERROR", {
          section: "Pinned Revisions",
          relatedArtifact: "spec",
          suggestedFix: `Copy the full hash from /factory status (sha256:${specUp.hash}).`,
        }),
      );
    }
  }
  if (implUp) {
    if (kv["Implementation Revision"] !== undefined && kv["Implementation Revision"] !== String(implUp.revision)) {
      out.push(
        v(contract, "SEM_STALE_REVISION", `Pinned Revisions pins the implementation at revision ${kv["Implementation Revision"]}, but the approved implementation-report is revision ${implUp.revision}.`, "ERROR", {
          section: "Pinned Revisions",
          relatedArtifact: "implementation",
        }),
      );
    }
    if (kv["Implementation Hash"] !== undefined && kv["Implementation Hash"] !== `sha256:${implUp.hash}`) {
      out.push(
        v(contract, "SEM_PIN_HASH_MISMATCH", `Pinned implementation hash does not match the approved implementation-report artifact.`, "ERROR", {
          section: "Pinned Revisions",
          relatedArtifact: "implementation",
          suggestedFix: `Copy the full hash from /factory status (sha256:${implUp.hash}).`,
        }),
      );
    }
  }

  // Checks must mirror the recorded check set, status-for-status.
  const recs = recordOf(parsed, "Checks");
  for (const c of ctx.checks) {
    const rec = recs.find((r) => r.title === c.name);
    if (!rec) {
      out.push(
        v(contract, "SEM_CHECK_MISMATCH", `Recorded check "${c.name}" (${c.status}) has no CHK record in the report; every recorded check must appear.`, "ERROR", {
          section: "Checks",
          relatedId: c.name,
          suggestedFix: `Add a "### CHK-###: ${c.name}" record with status ${reportStatusForCheck(c.status)}.`,
        }),
      );
      continue;
    }
    const want = reportStatusForCheck(c.status);
    if (rec.fields["Status"] !== want) {
      out.push(
        v(contract, "SEM_CHECK_MISMATCH", `Check ${rec.id} ("${c.name}") declares status ${rec.fields["Status"]} but the recorded result is ${c.status}→${want}. A model-declared result cannot override the recorded one.`, "ERROR", {
          section: "Checks",
          relatedId: rec.id,
        }),
      );
    }
    const wantReq = c.required ? "yes" : "no";
    if (rec.fields["Required"] !== wantReq) {
      out.push(
        v(contract, "SEM_CHECK_MISMATCH", `Check ${rec.id} ("${c.name}") is ${wantReq}-required but declares "Required: ${rec.fields["Required"]}"; requiredness is set by factory_check_record.`, "ERROR", {
          section: "Checks",
          relatedId: rec.id,
        }),
      );
    }
  }
  for (const rec of recs) {
    if (!ctx.checks.some((c) => c.name === rec.title)) {
      out.push(
        v(contract, "SEM_CHECK_UNRECORDED", `Check ${rec.id} ("${rec.title}") is not in the recorded check set; record it with factory_check_record (real output evidence) before reporting it.`, "ERROR", {
          section: "Checks",
          relatedId: rec.id,
        }),
      );
    }
    const ref = rec.fields["Reference"] ?? "";
    if (ref !== "tooling") {
      const mentioned = [...ref.matchAll(/\b(REQ|FR|AC)-(\d+)\b/g)].map((m) => m[0]!);
      if (mentioned.length === 0) {
        out.push(
          v(contract, "SEM_MISSING_REF", `Check ${rec.id} must reference an acceptance criterion or requirement id (or "tooling" for build/test-infrastructure checks).`, "ERROR", {
            section: "Checks",
            relatedId: rec.id,
          }),
        );
      }
      for (const id of mentioned) {
        const p = id.split("-")[0]!;
        const upstreamPhase: Phase = p === "REQ" ? "requirement" : "spec";
        if (legacyPhases.has(upstreamPhase)) continue;
        const set = p === "REQ" ? ids.requirement : p === "FR" ? ids.functional : ids.acceptance;
        if (!set.has(normalizeId(id))) {
          out.push(
            v(contract, "SEM_BAD_REF", `Check ${rec.id} references ${id}, which does not exist in the approved upstream artifacts.`, "ERROR", {
              section: "Checks",
              relatedId: id,
            }),
          );
        }
      }
    }
  }

  // Coverage: every acceptance criterion is covered by a check or the coverage text.
  const coverageText = (parsed.sections["Coverage"]?.text ?? "") + " " + recs.map((r) => r.fields["Reference"] ?? "").join(" ");
  const covered = mentionedIds(coverageText, "AC");
  for (const ac of ids.acceptance) {
    if (!covered.has(ac)) {
      out.push(
        v(contract, "SEM_UNCOVERED_AC", `Acceptance criterion ${ac} is not covered by any check and not mentioned in Coverage.`, "ERROR", {
          section: "Coverage",
          relatedId: ac,
          relatedArtifact: "spec",
          suggestedFix: `Add a check referencing ${ac}, or list it in Coverage with an explicit reason.`,
        }),
      );
    }
  }

  // Verdict: recomputed from recorded results, never trusted.
  const blocking = ctx.checks.filter((c) => c.required && (c.status === "FAILED" || c.status === "SKIPPED"));
  const computed: "PASS" | "FAIL" = blocking.length > 0 ? "FAIL" : "PASS";
  const declared = (parsed.sections["Overall Verdict"]?.kv ?? {})["Verdict"];
  if (declared !== undefined && declared !== computed) {
    out.push(
      v(
        contract,
        "SEM_VERDICT_CONFLICT",
        `Declared verdict is ${declared} but the recorded checks compute ${computed}${blocking.length ? ` (blocking: ${blocking.map((c) => `${c.name}=${c.status}`).join(", ")})` : ""}. A declared verdict cannot override recorded results.`,
        "ERROR",
        { section: "Overall Verdict", suggestedFix: `Set "- Verdict: ${computed}" (or fix the underlying checks).` },
      ),
    );
  }
  return out;
}
