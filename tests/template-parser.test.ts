import { test } from "vitest";
import assert from "node:assert/strict";
import { getContract } from "../src/artifacts/artifact-registry.ts";
import { parseArtifact } from "../src/artifacts/markdown-parser.ts";
import { REQ_DOC, codes, runValidation } from "./validation-fixture.ts";

const contract = getContract("requirement");

test("parser: a conformant requirement doc parses with no issues", () => {
  const parsed = parseArtifact(contract, REQ_DOC);
  assert.deepEqual(parsed.issues, [], parsed.issues.map((i) => i.message).join("; "));
  assert.equal(parsed.title, "Requirement");
  const md = parsed.doc.metadata as Record<string, unknown>;
  assert.equal(md["changeId"], "chg-fixture");
  assert.equal(md.revision, 1);
  assert.equal(md.status, "complete");
  const recs = parsed.sections["Requirements"]!.records!;
  assert.equal(recs.length, 1);
  assert.equal(recs[0]!.id, "REQ-001");
  assert.equal(recs[0]!.fields["Priority"], "MUST");
  assert.equal(recs[0]!.fields["Source"], "R1");
  assert.match(recs[0]!.description, /do the thing/);
});

test("parser: NA markers produce null for allowsNA sections, content otherwise", () => {
  const parsed = parseArtifact(contract, REQ_DOC);
  const nonGoals = parsed.sections["Non-Goals"]!;
  assert.equal(nonGoals.na, true);
  assert.equal(parsed.doc.nonGoals, null);
  const context = parsed.sections["Context"]!;
  assert.equal(context.na, false);
  assert.equal(typeof parsed.doc.context, "string");
});

test("parser: a section containing only the placeholder comment is flagged", () => {
  const doc = REQ_DOC.replace(
    "## Context\nThe change introduces the requested behavior into the repository.",
    "## Context\n<!-- describe the change -->",
  );
  const parsed = parseArtifact(contract, doc);
  assert.ok(parsed.issues.some((i) => i.code === "STRUCT_PLACEHOLDER_SECTION"), "expected placeholder issue");
});

test("parser: fenced code blocks are never parsed as structure", () => {
  const doc = [
    "## Context",
    "Real context.",
    "```markdown",
    "## Requirements",
    "### REQ-999: inside a code fence",
    "- Priority: MUST",
    "```",
    "### REQ-001: Do the thing",
  ]
    .join("\n");
  const parsed = parseArtifact(
    contract,
    REQ_DOC.replace("## Context\nThe change introduces the requested behavior into the repository.", doc),
  );
  const recs = parsed.sections["Requirements"]!.records!;
  assert.deepEqual(
    recs.map((r) => r.id),
    ["REQ-001"],
    "records inside fenced code must not be parsed",
  );
  assert.ok(!parsed.issues.some((i) => i.code === "STRUCT_UNKNOWN_SECTION"));
});

test("parser: duplicate record ids and unknown fields are rejected", () => {
  const section = [
    "## Requirements",
    "",
    "### REQ-001: First",
    "",
    "- Priority: MUST",
    "- Source: R1",
    "- Rationale: a",
    "- Acceptance Intent: a",
    "- Bogus: nope",
    "",
    "first body",
    "",
    "### REQ-001: Duplicate",
    "",
    "- Priority: MUST",
    "- Source: R1",
    "- Rationale: b",
    "- Acceptance Intent: b",
    "",
    "second body",
  ].join("\n");
  const doc = REQ_DOC.replace(/## Requirements[\s\S]*?## Constraints/, `${section}\n\n## Constraints`);
  const c = parseArtifact(contract, doc).issues.map((i) => i.code);
  assert.ok(c.includes("STRUCT_DUPLICATE_RECORD_ID"), c.join(","));
  assert.ok(c.includes("STRUCT_UNKNOWN_RECORD_FIELD"), c.join(","));
});

test("parser: unknown and missing sections are rejected", () => {
  const unknown = REQ_DOC + "\n## Brand New Section\nstuff\n";
  assert.ok(
    parseArtifact(contract, unknown).issues.some((i) => i.code === "STRUCT_UNKNOWN_SECTION"),
    "unknown section",
  );

  const missing = REQ_DOC.split("## Constraints")[0] + "## Constraints\nNone identified\n";
  const c = parseArtifact(contract, missing).issues.map((i) => i.code);
  assert.ok(c.includes("STRUCT_MISSING_SECTION"), c.join(","));
});

test("parser: kv sections enforce allowed keys, duplicates and empties", () => {
  const doc =
    "# Requirement\n\n## Metadata\n" +
    "- Artifact Type: requirement\n- Contract Version: 1.0.0\n- Change ID: chg-fixture\n- Revision: 1\n- Status: complete\n- Revision: 2\n- Nope: x\n\n" +
    "## Context\nc\n## Goals\n- g\n## Non-Goals\nNone identified\n" +
    "## Requirements\n\n### REQ-001: t\n\n- Priority: MUST\n- Source: R1\n- Rationale: r\n- Acceptance Intent: a\n\nbody\n" +
    "## Constraints\nNone identified\n## Assumptions\nNone identified\n## Open Questions\nNone identified\n";
  const c = parseArtifact(contract, doc).issues.map((i) => i.code);
  assert.ok(c.includes("STRUCT_DUPLICATE_KV_KEY"), c.join(","));
  assert.ok(c.includes("STRUCT_UNKNOWN_KV_KEY"), c.join(","));
});

test("parser: list sections refuse non-bullet content", () => {
  const doc = REQ_DOC.replace("## Goals\n- Deliver the requested behavior.", "## Goals\nnot a bullet");
  const c = parseArtifact(contract, doc).issues.map((i) => i.code);
  assert.ok(c.includes("STRUCT_NON_LIST_CONTENT"), c.join(","));
});

test("parser: NA marker is rejected where real content is required", () => {
  const doc = REQ_DOC.replace("## Context\nThe change introduces the requested behavior into the repository.", "## Context\nNone identified");
  const c = parseArtifact(contract, doc).issues.map((i) => i.code);
  assert.ok(c.includes("STRUCT_NA_NOT_ALLOWED"), c.join(","));
});

test("parser: full pipeline accepts the fixture and a broken doc fails structurally", () => {
  const ok = runValidation("requirement", REQ_DOC);
  assert.equal(ok.valid, true, JSON.stringify(ok.issues, null, 2));
  const bad = runValidation("requirement", "totally wrong\n## Nope\nx");
  assert.equal(bad.valid, false);
  assert.ok(codes(bad).includes("STRUCT_BAD_TITLE"));
});
