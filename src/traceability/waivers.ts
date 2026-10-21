import type { Phase } from "../workflow/phases.ts";
import type { WaiverRecord } from "../workflow/state.ts";
import type { PhaseContext } from "../artifacts/validation-context.ts";
import { WAIVER_KEY } from "./coverage.ts";
import type { ActiveWaiver } from "./types.ts";

/**
 * Waiver resolution — shared by the validation pipeline (PhaseContext-based)
 * and the /factory traceability report (database-based). One code path so the
 * gates and the report can never disagree about whether a waiver applies.
 */

function parsePinned(pinnedJson: string): Partial<Record<Phase, number>> {
  try {
    return JSON.parse(pinnedJson || "{}") as Partial<Record<Phase, number>>;
  } catch {
    return {};
  }
}

function stalenessFor(w: WaiverRecord, currentRev: (phase: Phase) => number | null): Phase[] {
  const pinned = parsePinned(w.pinned_revisions);
  const stale: Phase[] = [];
  for (const [phase, rev] of Object.entries(pinned) as Array<[Phase, number]>) {
    const cur = currentRev(phase);
    if (cur !== null && cur !== rev) stale.push(phase);
  }
  return stale;
}

export function toActiveWaiver(w: WaiverRecord, staleBecause: Phase[]): ActiveWaiver {
  return {
    waiver: {
      id: w.id,
      changeId: w.change_id,
      itemId: w.item_id,
      stage: w.stage,
      rationale: w.rationale,
      created_at: w.created_at,
      status: w.status,
      pinnedRevisions: parsePinned(w.pinned_revisions),
    },
    staleBecause,
  };
}

/** From a PhaseContext (validation pipeline): current revisions come from the pinned upstream list. */
export function buildWaiverMapFromContext(ctx: PhaseContext): Map<string, ActiveWaiver> {
  const current = new Map<Phase, number>();
  for (const u of ctx.upstream) current.set(u.phase, u.revision);
  return buildWaiverMap((w) => {
    if (w.status !== "ACTIVE") return null;
    return toActiveWaiver(w, stalenessFor(w, (phase) => current.get(phase) ?? null));
  }, ctx.waivers);
}

/** From the database (report / commands). */
export function buildWaiverMapForReport(
  changeId: string,
  db: { listWaivers(changeId: string): WaiverRecord[] },
  currentRev: (phase: Phase) => number | null,
): Map<string, ActiveWaiver> {
  return buildWaiverMap((w) => {
    if (w.status !== "ACTIVE") return null;
    return toActiveWaiver(w, stalenessFor(w, currentRev));
  }, db.listWaivers(changeId));
}

function buildWaiverMap(
  resolve: (w: WaiverRecord) => ActiveWaiver | null,
  waivers: WaiverRecord[],
): Map<string, ActiveWaiver> {
  const map = new Map<string, ActiveWaiver>();
  for (const w of waivers) {
    const a = resolve(w);
    if (a) map.set(WAIVER_KEY(w.item_id, w.stage), a);
  }
  return map;
}
