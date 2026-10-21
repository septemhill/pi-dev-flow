import type {
  ActiveWaiver,
  CoverageAssessment,
  CoverageReport,
  CoverageStage,
  CoverageStatus,
  StageSummary,
  TraceGraph,
  TraceLink,
} from "./types.ts";

/**
 * Deterministic COVERAGE ENGINE.
 *
 * Operates only on the normalized traceability graph (validated, pinned
 * revisions) plus recorded waivers. It never reads free text, model claims,
 * or conversational memory. For every stage it reports:
 *
 *  - the denominator (all eligible upstream items; waived items REMAIN in the
 *    denominator and are reported as waived, never silently excluded)
 *  - per-item status with the exact links/evidence that justify it
 *  - blocking vs non-blocking findings as ValidationIssue codes (see codesFor)
 *
 * Stage rules (canonical):
 *  requirement_to_spec        REQ is covered  ⇔ ≥1 SATISFIES link from FR or AC.
 *                             Mandatory: priority MUST. SHOULD/COULD: warning only.
 *  spec_to_design             FR/AC is covered ⇔ ≥1 REALIZES link from a DES record.
 *  spec_to_tasks              FR/AC is covered ⇔ ≥1 IMPLEMENTS link from a TASK.
 *  tasks_to_implementation    TASK is covered  ⇔ its Task Result is COMPLETED with evidence.
 *  acceptance_to_verification AC is VERIFIED   ⇔ ≥1 VERIFIES link from a check with PASS status;
 *                             FAILED ⇔ a check it is linked to FAILED (and none passed);
 *                             SKIPPED/absent ⇔ UNCOVERED; NEEDS_HUMAN-only ⇔ UNCOVERED but
 *                             non-blocking (humanPending) — explicitly unresolved, never promoted.
 */

export interface CoverageInput {
  graph: TraceGraph;
  /** item id + stage → active, non-stale waivers. */
  waivers: Map<string, ActiveWaiver>;
  /** Which stages to assess (default: all that have a denominator). */
  stages?: CoverageStage[];
}

export const WAIVER_KEY = (itemId: string, stage: CoverageStage): string => `${itemId}:${stage}`;

function emptySummary(stage: CoverageStage): StageSummary {
  return { stage, total: 0, covered: 0, partial: 0, uncovered: 0, failed: 0, waived: 0, percent: null, uncoveredIds: [], partialIds: [], failedIds: [], waivedIds: [] };
}

export function assessCoverage(input: CoverageInput): CoverageReport {
  const { graph, waivers, stages = ALL_STAGES_FOR(graph) } = input;
  const assessments: CoverageAssessment[] = [];
  const byStage = new Map<CoverageStage, CoverageAssessment[]>();

  for (const stage of stages) {
    const list: CoverageAssessment[] = [];
    switch (stage) {
      case "requirement_to_spec":
        for (const it of graph.items.filter((i) => i.itemType === "requirement")) {
          const links = coveringLinks(graph, it.id, "requirement", ["SATISFIES"]);
          list.push({
            stage,
            item: { itemType: "requirement", id: it.id },
            mandatory: it.priority === "MUST",
            status: links.length > 0 ? "COVERED" : "UNCOVERED",
            links,
            reasons: links.length > 0
              ? [`covered by ${links.map((l) => l.source.id).join(", ")}`]
              : ["no functional requirement or acceptance criterion references this requirement"],
          });
        }
        break;
      case "spec_to_design":
        for (const it of graph.items.filter((i) => i.itemType === "functional_requirement" || i.itemType === "acceptance_criterion")) {
          const links = coveringLinks(graph, it.id, it.itemType, ["REALIZES"]);
          list.push({
            stage,
            item: { itemType: it.itemType, id: it.id },
            mandatory: true,
            status: links.length > 0 ? "COVERED" : "UNCOVERED",
            links,
            reasons: links.length > 0
              ? [`realized by ${links.map((l) => l.source.id).join(", ")}`]
              : ["no design decision references this specification item"],
          });
        }
        break;
      case "spec_to_tasks":
        for (const it of graph.items.filter((i) => i.itemType === "functional_requirement" || i.itemType === "acceptance_criterion")) {
          const links = coveringLinks(graph, it.id, it.itemType, ["IMPLEMENTS"]);
          list.push({
            stage,
            item: { itemType: it.itemType, id: it.id },
            mandatory: true,
            status: links.length > 0 ? "COVERED" : "UNCOVERED",
            links,
            reasons: links.length > 0
              ? [`implemented by ${links.map((l) => l.source.id).join(", ")}`]
              : ["no implementation task references this specification item"],
          });
        }
        break;
      case "tasks_to_implementation": {
        const results = new Map(graph.items.filter((i) => i.itemType === "implementation_result").map((i) => [i.id, i]));
        for (const it of graph.items.filter((i) => i.itemType === "task")) {
          const res = results.get(it.id);
          const ok = res && res.status === "COMPLETED" && (res.evidence ?? "").trim() !== "";
          list.push({
            stage,
            item: { itemType: "task", id: it.id },
            mandatory: true,
            status: ok ? "COVERED" : "UNCOVERED",
            links: res ? [{ relation: "IMPLEMENTS", source: { itemType: "implementation_result", id: res.id }, target: { itemType: "task", id: it.id } }] : [],
            reasons: !res
              ? ["no task result record"]
              : ok
                ? [`completed with evidence`]
                : [`task result is ${res.status ?? "unknown"}${(res.evidence ?? "").trim() ? "" : " without evidence"}`],
          });
        }
        break;
      }
      case "acceptance_to_verification":
        for (const it of graph.items.filter((i) => i.itemType === "acceptance_criterion")) {
          const links = coveringLinks(graph, it.id, "acceptance_criterion", ["VERIFIES"]);
          const checks = links
            .map((l) => graph.items.find((i) => i.itemType === "verification_check" && i.id === l.source.id))
            .filter((c): c is NonNullable<typeof c> => Boolean(c));
          const statuses = checks.map((c) => c.status);
          let status: CoverageStatus;
          let humanPending = false;
          const reasons: string[] = [];
          if (statuses.includes("PASS")) {
            status = "VERIFIED";
            reasons.push(`verified by passing check(s) ${checks.filter((c) => c.status === "PASS").map((c) => c.id).join(", ")}`);
          } else if (statuses.includes("FAIL")) {
            status = "FAILED";
            reasons.push(`check(s) ${checks.filter((c) => c.status === "FAIL").map((c) => c.id).join(", ")} FAILED — the requirement failed verification`);
          } else if (statuses.includes("NEEDS_HUMAN")) {
            status = "UNCOVERED";
            humanPending = true;
            reasons.push(`only evidence is an unresolved human check (${checks.map((c) => c.id).join(", ")}); explicitly unresolved, not promoted`);
          } else if (links.length === 0) {
            status = "UNCOVERED";
            reasons.push("no verification check references this acceptance criterion");
          } else {
            status = "UNCOVERED";
            reasons.push(`linked check(s) ${checks.map((c) => `${c.id}=${c.status}`).join(", ")} do not count as passing (SKIPPED/absent) — a skipped mandatory check never counts as success`);
          }
          const a: CoverageAssessment = {
            stage,
            item: { itemType: "acceptance_criterion", id: it.id },
            mandatory: true,
            status,
            links,
            reasons,
          };
          if (humanPending) a.humanPending = true;
          list.push(a);
        }
        break;
    }
    byStage.set(stage, list);
    assessments.push(...list);
  }

  // Waivers: applied after deterministic assessment; never rewrite history.
  for (const a of assessments) {
    const key = WAIVER_KEY(a.item.id, a.stage);
    const hit = waivers.get(key);
    if (!hit || hit.staleBecause.length > 0) continue;
    a.status = "WAIVED";
    a.waiverId = hit.waiver.id;
    a.reasons = [...a.reasons, `WAIVED (${hit.waiver.id}): ${hit.waiver.rationale}`];
  }

  const stagesOut = {} as Record<CoverageStage, StageSummary>;
  for (const stage of stages) {
    const list = byStage.get(stage) ?? [];
    const s = emptySummary(stage);
    for (const a of list) {
      s.total++;
      switch (a.status) {
        case "COVERED":
        case "VERIFIED": s.covered++; break;
        case "PARTIAL": s.partial++; s.partialIds.push(a.item.id); break;
        case "FAILED": s.failed++; s.failedIds.push(a.item.id); break;
        case "WAIVED": s.waived++; s.waivedIds.push(a.item.id); break;
        case "UNCOVERED": s.uncovered++; s.uncoveredIds.push(a.item.id); break;
      }
    }
    s.percent = s.total === 0 ? null : Math.round((100 * (s.covered + s.waived)) / s.total);
    stagesOut[stage] = s;
  }

  return { changeId: graph.changeId, assessments, stages: stagesOut };
}

function ALL_STAGES_FOR(graph: TraceGraph): CoverageStage[] {
  const types = new Set(graph.items.map((i) => i.itemType));
  const out: CoverageStage[] = [];
  if (types.has("requirement")) out.push("requirement_to_spec");
  if (types.has("functional_requirement") || types.has("acceptance_criterion")) {
    if (types.has("design_decision")) out.push("spec_to_design");
    if (types.has("task")) out.push("spec_to_tasks");
  }
  if (types.has("task") && types.has("implementation_result")) out.push("tasks_to_implementation");
  if (types.has("acceptance_criterion") && types.has("verification_check")) out.push("acceptance_to_verification");
  return out;
}

/** Links whose TARGET is `itemId` (and whose source carries the given relation). */
function coveringLinks(graph: TraceGraph, itemId: string, _targetType: TraceLink["target"]["itemType"], relations: string[]): TraceLink[] {
  return graph.links.filter((l) => l.target.id === itemId && relations.includes(l.relation));
}

/** Stage → blocking diagnostic code for uncovered mandatory items. */
export const STAGE_MISSING_CODE: Record<CoverageStage, string> = {
  requirement_to_spec: "TRACE_MISSING_SPEC_COVERAGE",
  spec_to_design: "TRACE_MISSING_DESIGN_COVERAGE",
  spec_to_tasks: "TRACE_MISSING_TASK_COVERAGE",
  tasks_to_implementation: "TRACE_MISSING_IMPLEMENTATION_EVIDENCE",
  acceptance_to_verification: "TRACE_MISSING_VERIFICATION",
};

export const STAGE_LABEL: Record<CoverageStage, string> = {
  requirement_to_spec: "requirement → spec",
  spec_to_design: "spec → design",
  spec_to_tasks: "spec/design → task planning",
  tasks_to_implementation: "task planning → implementation",
  acceptance_to_verification: "acceptance criteria → verification",
};

/** Fix hints per stage (what downstream work is missing). */
export const STAGE_FIX: Record<CoverageStage, string> = {
  requirement_to_spec: "Add a functional requirement or acceptance criterion that references this requirement id.",
  spec_to_design: "Add a design decision whose References cite this FR/AC id.",
  spec_to_tasks: "Add an implementation task whose References cite this FR/AC id.",
  tasks_to_implementation: "Complete the task and record real evidence (Status COMPLETED + Evidence).",
  acceptance_to_verification: "Add a verification check whose Reference cites this AC id and that passes with real output evidence.",
};
