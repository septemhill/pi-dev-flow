import { test } from "vitest";
import assert from "node:assert/strict";
import { sha256 } from "../src/artifacts/artifact-store.ts";
import { DESIGN_DOC, REQ_DOC, SPEC_DOC, TASK_PLAN_DOC, VERIF_DOC, codes, runValidation } from "./validation-fixture.ts";

test("traceability: a missing upstream artifact is a hard error (fail-closed)", () => {
  const result = runValidation("spec", SPEC_DOC, { upstreamDocs: { requirement: null } });
  assert.ok(codes(result).includes("TRACE_UPSTREAM_MISSING"), codes(result).join(","));
});

test("traceability: a tampered upstream artifact is a hard error", () => {
  // recorded hash says the approved requirement was REQ_DOC; the file on disk was modified
  const result = runValidation("spec", SPEC_DOC, {
    upstreamDocs: { requirement: REQ_DOC + "\n- late edit that was never reviewed\n" },
    upstreamHashes: { requirement: sha256(REQ_DOC) },
  });
  assert.ok(codes(result).includes("TRACE_UPSTREAM_MODIFIED"), codes(result).join(","));
});

test("traceability: every id mentioned must exist in the pinned upstream documents", () => {
  // spec references a requirement that was never written
  const spec = runValidation("spec", SPEC_DOC.replace("- REQ-001", "- REQ-009"));
  assert.ok(codes(spec).includes("TRACE_UNKNOWN_ITEM"), codes(spec).join(","));

  // design references an acceptance criterion that does not exist
  const design = runValidation("design", DESIGN_DOC.replace(/AC-001/g, "AC-042"));
  assert.ok(codes(design).includes("TRACE_UNKNOWN_ITEM"), codes(design).join(","));

  // task plan references a design decision that does not exist
  const plan = runValidation("task_planning", TASK_PLAN_DOC.replace("- References: AC-001", "- References: DES-099").replace("- References: AC-001", "- References: DES-099"));
  assert.ok(codes(plan).includes("TRACE_UNKNOWN_ITEM"), codes(plan).join(","));
});

test("traceability: zero-padded ids resolve (AC-1 == AC-001)", () => {
  const plan = TASK_PLAN_DOC.replace("- References: AC-001", "- References: AC-1").replace("- References: AC-001", "- References: AC-1");
  const result = runValidation("task_planning", plan);
  assert.ok(!codes(result).includes("TRACE_UNKNOWN_ITEM"), codes(result).join(","));
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test("traceability: ids that appear inside code fences are not scanned as references", () => {
  const design = DESIGN_DOC.replace(
    "A single feature module performs the thing.",
    "A single feature module performs the thing.\n```\nREQ-999 is only in a comment\n```",
  );
  const result = runValidation("design", design);
  assert.equal(result.valid, true, JSON.stringify(result.issues, null, 2));
});

test("traceability: verification pins are checked against the registry, not trusted", () => {
  const result = runValidation("verification", VERIF_DOC, {
    upstreamHashes: { spec: sha256(SPEC_DOC + "changed") },
  });
  // the recorded spec hash no longer matches the pinned hash
  assert.ok(codes(result).includes("SEM_PIN_HASH_MISMATCH"), codes(result).join(","));
});
