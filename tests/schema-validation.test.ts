import { test } from "vitest";
import assert from "node:assert/strict";
import { DOCS, REQ_DOC, runValidation, codes } from "./validation-fixture.ts";
import type { Phase } from "../src/workflow/phases.ts";

test("schema: every fixture document passes the full pipeline for its phase", () => {
  for (const phase of Object.keys(DOCS) as Phase[]) {
    const result = runValidation(phase, DOCS[phase]);
    assert.equal(result.valid, true, `${phase}: ${JSON.stringify(result.issues, null, 2)}`);
  }
});

test("schema: metadata is schema-bound (type, id pattern, version pattern, status enum)", () => {
  const badChangeId = runValidation("requirement", REQ_DOC.replace("- Change ID: chg-fixture", "- Change ID: CHG_FIXTURE"));
  assert.ok(codes(badChangeId).some((c) => c === "SCHEMA_PATTERN"), codes(badChangeId).join(","));

  const badVersion = runValidation("requirement", REQ_DOC.replace("- Contract Version: 1.0.0", "- Contract Version: 1.0"));
  assert.ok(codes(badVersion).some((c) => c === "SCHEMA_PATTERN"), codes(badVersion).join(","));

  const badStatus = runValidation("requirement", REQ_DOC.replace("- Status: complete", "- Status: done"));
  assert.ok(codes(badStatus).some((c) => c === "SCHEMA_ENUM"), codes(badStatus).join(","));
});

test("schema: record fields are schema-bound (priority enum, id format)", () => {
  const badPriority = runValidation("requirement", REQ_DOC.replace("- Priority: MUST", "- Priority: WHY"));
  assert.ok(codes(badPriority).some((c) => c === "SCHEMA_ENUM"), codes(badPriority).join(","));
});

test("schema: missing sections surface as SCHEMA_REQUIRED as well as structural issues", () => {
  const doc = `# Requirement

## Metadata
- Artifact Type: requirement
- Contract Version: 1.0.0
- Change ID: chg-fixture
- Revision: 1
- Status: complete

` + REQ_DOC.split("## Goals")[1]!.replace(/^\n+/, "");
  const result = runValidation("requirement", doc);
  const c = codes(result);
  assert.ok(c.includes("STRUCT_MISSING_SECTION"), c.join(","));
  assert.ok(c.some((x) => x === "SCHEMA_REQUIRED"), c.join(","));
});

test("schema: the schema id and draft are pinned and reported in the result", () => {
  const result = runValidation("requirement", REQ_DOC);
  assert.equal(result.valid, true);
  assert.equal(result.schemaId, "https://pi-ai-factory.local/schemas/requirement.schema.json#1.0.0");
  assert.match(result.templateId, /requirement/);
});
