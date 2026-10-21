import { getContract } from "../artifacts/artifact-registry.ts";
import { parseArtifact } from "../artifacts/markdown-parser.ts";
import { readFileOrNull, changeFile } from "../artifacts/artifact-store.ts";
import { PHASES } from "../workflow/phases.ts";
import type { Phase } from "../workflow/phases.ts";
import { assessCoverage, STAGE_LABEL } from "./coverage.ts";
import { extractTraceGraph, type GraphInput } from "./items.ts";
import { buildWaiverMapForReport } from "./waivers.ts";
import type { Database } from "../persistence/database.ts";
import type { CoverageReport } from "./types.ts";

/**
 * /factory traceability — the human/LLM-readable view of the SAME data the
 * gates enforce. Built deterministically from the recorded (approved,
 * pinned) artifacts of a change; it never invents links or status.
 */

export interface ChangeTrace {
  changeId: string;
  artifacts: Array<{ phase: Phase; revision: number; contract: string | null; legacy: boolean }>;
  graphIssues: ReturnType<typeof extractTraceGraph>["issues"];
  report: CoverageReport | null;
  waivers: ReturnType<typeof buildWaiverMapForReport>;
  /** Phases whose recorded artifact is legacy (marked, not trusted). */
  legacyPhases: Phase[];
}

export function buildChangeTrace(root: string, changeId: string, db: Database): ChangeTrace {
  const artifacts: ChangeTrace["artifacts"] = [];
  const inputs: GraphInput[] = [];
  const legacyPhases: Phase[] = [];
  for (const p of PHASES) {
    const row = db.latestArtifact(changeId, p);
    if (!row) continue;
    const legacy = row.contract === null;
    artifacts.push({ phase: p, revision: row.revision, contract: row.contract, legacy });
    if (legacy) {
      legacyPhases.push(p);
      continue; // legacy ids are not trusted for graph construction
    }
    const text = readFileOrNull(changeFile(root, changeId, p));
    if (text === null) continue;
    try {
      const parsed = parseArtifact(getContract(p), text);
      inputs.push({ phase: p, artifactType: getContract(p).artifactType, revision: row.revision, approved: true, parsed });
    } catch {
      // Unparseable recorded artifact — reported by /factory validate; not part of the graph.
    }
  }
  const { graph, issues } = extractTraceGraph(changeId, inputs);
  const waivers = buildWaiverMapForReport(changeId, db, (phase) => db.latestArtifact(changeId, phase)?.revision ?? null);
  const report = assessCoverage({ graph, waivers });
  return { changeId, artifacts, graphIssues: issues, report, waivers, legacyPhases };
}

/** Deterministic text rendering (stable output for stable state). */
export function renderTraceabilityReport(trace: ChangeTrace): string {
  const lines: string[] = [];
  lines.push(`Traceability report — change ${trace.changeId}`);
  lines.push("");
  lines.push("Artifacts (recorded revisions):");
  for (const a of trace.artifacts) {
    lines.push(`  ${a.phase.padEnd(15)} rev ${a.revision}  ${a.legacy ? "LEGACY (pre-contract — not trusted)" : a.contract ?? "?"}`);
  }
  if (trace.legacyPhases.length > 0) {
    lines.push("");
    lines.push(`⚠ Legacy upstream: ${trace.legacyPhases.join(", ")} — re-run these phases to regenerate contract-conformant artifacts before their ids can be trusted.`);
  }
  if (trace.graphIssues.length > 0) {
    lines.push("");
    lines.push("Graph findings:");
    for (const i of trace.graphIssues) lines.push(`  ${i.severity === "ERROR" ? "✖" : "⚠"} ${i.code}${i.relatedId ? ` (${i.relatedId})` : ""}: ${i.message}`);
  }

  const report = trace.report;
  if (report && report.assessments.length > 0) {
    for (const stage of Object.keys(report.stages) as Array<keyof typeof report.stages>) {
      const s = report.stages[stage];
      if (s.total === 0) continue;
      lines.push("");
      lines.push(`Stage ${STAGE_LABEL[stage]}: ${s.percent ?? 0}% (${s.covered}/${s.total} covered${s.waived ? `, ${s.waived} waived` : ""})`);
      for (const a of report.assessments.filter((x) => x.stage === stage)) {
        const icon = a.status === "VERIFIED" || a.status === "COVERED" ? "✓" : a.status === "FAILED" ? "✖" : a.status === "WAIVED" ? "⊘" : a.humanPending ? "?" : "✗";
        const extra: string[] = [];
        if (a.waiverId) extra.push(`waiver ${a.waiverId}`);
        if (a.status === "UNCOVERED" && !a.humanPending) extra.push("UNCOVERED");
        if (a.humanPending) extra.push("awaiting human check");
        lines.push(`  ${icon} ${a.item.id}  ${a.status}${extra.length ? `  [${extra.join(", ")}]` : ""}`);
      }
    }
  } else {
    lines.push("");
    lines.push("No coverage stages assessable yet (no conformant upstream artifacts recorded).");
  }

  const active = [...trace.waivers.values()];
  if (active.length > 0) {
    lines.push("");
    lines.push("Waivers (auditable exceptions — never verification success):");
    for (const w of active) {
      const stale = w.staleBecause.length > 0;
      lines.push(`  ${stale ? "✖" : "⊘"} ${w.waiver.id}  ${w.waiver.itemId} @ ${w.waiver.stage}  "${w.waiver.rationale}"`);
      if (stale) lines.push(`      STALE: pinned revisions no longer match after ${w.staleBecause.join(", ")} advanced — the waiver does NOT apply.`);
    }
  }
  return lines.join("\n");
}
