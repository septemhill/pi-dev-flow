import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { knowledgeSchemaErrors, knowledgeSchemasDir } from "../src/knowledge/schema.ts";
import { baseConstraint, baseConvention, baseDecision } from "./knowledge-fixtures.ts";

const S = {
  constraint: knowledgeSchemaErrors.bind(null, "constraint" as const),
  convention: knowledgeSchemaErrors.bind(null, "convention" as const),
  "tech-decision": knowledgeSchemaErrors.bind(null, "tech-decision" as const),
};

describe("knowledge schemas: valid documents pass", () => {
  it("accepts a minimal constraint", () => expect(S.constraint(baseConstraint())).toEqual([]));
  it("accepts a minimal convention", () => expect(S.convention(baseConvention())).toEqual([]));
  it("accepts a minimal tech decision", () => expect(S["tech-decision"](baseDecision())).toEqual([]));
  it("accepts a constraint with automated verification", () =>
    expect(S.constraint(baseConstraint({ verification: { method: "automated", validator: "tests/security.test.ts", instructions: "run" } }))).toEqual([]));
  it("accepts all documented status values", () => {
    for (const st of ["draft", "proposed", "approved", "deprecated"]) {
      expect(S.constraint(baseConstraint({ status: st as never }))).toEqual([]);
      expect(S.convention(baseConvention({ status: st as never }))).toEqual([]);
    }
    for (const st of ["draft", "proposed", "accepted", "rejected", "superseded", "withdrawn"]) {
      expect(S["tech-decision"](baseDecision({ status: st as never }))).toEqual([]);
    }
  });
  it("accepts scope variants (module with paths)", () =>
    expect(S.constraint(baseConstraint({ scope: { level: "module", paths: ["src/**"] } }))).toEqual([]));
});

describe("knowledge schemas: structural violations fail", () => {
  it("reports missing required properties", () => {
    const errs = S.constraint({ schema_version: "1.0.0", id: "CON-001" } as never);
    expect(errs.length).toBeGreaterThan(0);
    for (const key of ["title", "description", "scope", "rule", "severity", "verification", "status"]) {
      expect(errs.some((e) => e.includes(key))).toBe(true);
    }
  });
  it("reports wrong property types", () => {
    expect(S.constraint(baseConstraint({ title: 42 as never }))).not.toEqual([]);
    expect(S["tech-decision"](baseDecision({ supersedes: 5 as never }))).not.toEqual([]);
    expect(S.convention(baseConvention({ examples: "nope" as never }))).not.toEqual([]);
  });
  it("reports empty required strings", () => {
    expect(S.constraint(baseConstraint({ title: "" }))).not.toEqual([]);
    expect(S["tech-decision"](baseDecision({ decision: "" }))).not.toEqual([]);
  });
  it("rejects unknown properties (fail closed on unrecognized content)", () => {
    expect(S.constraint({ ...baseConstraint(), bogus: 1 } as never)).not.toEqual([]);
    expect(S["tech-decision"]({ ...baseDecision(), alt: [] } as never)).not.toEqual([]);
  });
  it("reports malformed nested structures", () => {
    expect(S.constraint(baseConstraint({ verification: "human_review" as never }))).not.toEqual([]);
    expect(S["tech-decision"](baseDecision({ alternatives: [{ reason_not_selected: "x" }] as never }))).not.toEqual([]);
    expect(S.convention(baseConvention({ examples: [{ kind: "weird", description: "d" }] as never }))).not.toEqual([]);
  });
  it("rejects invalid identifier formats", () => {
    expect(S.constraint(baseConstraint({ id: "CON_001" }))).not.toEqual([]);
    expect(S.constraint(baseConstraint({ id: "con-001" }))).not.toEqual([]);
    expect(S["tech-decision"](baseDecision({ id: "ADR_001" }))).not.toEqual([]);
    expect(S["tech-decision"](baseDecision({ supersedes: "CON-001" }))).not.toEqual([]);
  });
  it("rejects invalid enum values", () => {
    expect(S.constraint(baseConstraint({ severity: "fatal" as never }))).not.toEqual([]);
    expect(S.constraint(baseConstraint({ scope: { level: "org", paths: [] } as never }))).not.toEqual([]);
    expect(S.convention(baseConvention({ enforcement: "always" as never }))).not.toEqual([]);
    expect(S["tech-decision"](baseDecision({ status: "approved" as never }))).not.toEqual([]);
    expect(S.constraint(baseConstraint({ status: "accepted" as never }))).not.toEqual([]);
  });
  it("rejects non-object documents", () => {
    expect(S.constraint(null)).not.toEqual([]);
    expect(S.constraint("draft")).not.toEqual([]);
    expect(S["tech-decision"]([1, 2])).not.toEqual([]);
  });
});

describe("schema completeness (Draft 2020-12, described properties)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: Record<string, any> = {
    constraint: JSON.parse(readFileSync(path.join(knowledgeSchemasDir(), "constraint.schema.json"), "utf8")),
    convention: JSON.parse(readFileSync(path.join(knowledgeSchemasDir(), "convention.schema.json"), "utf8")),
    "tech-decision": JSON.parse(readFileSync(path.join(knowledgeSchemasDir(), "tech-decision.schema.json"), "utf8")),
  };

  it("pins Draft 2020-12 and has a title", () => {
    for (const schema of Object.values(raw)) {
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(typeof schema.title).toBe("string");
      expect(schema.title.length).toBeGreaterThan(0);
    }
  });

  function walkProps(node: Record<string, unknown>, path: string, out: Array<{ path: string; props: Record<string, unknown> }>): void {
    if (typeof node.properties === "object" && node.properties && Object.keys(node.properties as object).length > 0) {
      out.push({ path, props: node.properties as Record<string, unknown> });
    }
    for (const v of Object.values(node)) {
      if (typeof v === "object" && v !== null && !Array.isArray(v)) walkProps(v as Record<string, unknown>, `${path}/[]`, out);
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) for (const item of v) if (typeof item === "object" && item !== null) walkProps(item as Record<string, unknown>, `${path}/[]`, out);
    }
  }

  it("every declared property carries a meaningful description", () => {
    for (const [type, schema] of Object.entries(raw)) {
      const groups: Array<{ path: string; props: Record<string, unknown> }> = [];
      walkProps(schema, type, groups);
      expect(groups.length).toBeGreaterThan(1); // top level + nested objects
      for (const { path: p, props } of groups) {
        for (const [name, def] of Object.entries(props)) {
          const d = (def as { description?: unknown }).description;
          expect(
            typeof d === "string" && d.trim().length >= 20,
            `${type}${p} property "${name}" needs a meaningful description`,
          ).toBe(true);
        }
      }
    }
  });

  it("describes the full lifecycle vocabulary per type", () => {
    const cs = raw.constraint.properties.status as { enum: string[] };
    expect(new Set(cs.enum)).toEqual(new Set(["draft", "proposed", "approved", "deprecated"]));
    const cv = raw.convention.properties.status as { enum: string[] };
    expect(new Set(cv.enum)).toEqual(new Set(["draft", "proposed", "approved", "deprecated"]));
    const ad = raw["tech-decision"].properties.status as { enum: string[] };
    expect(new Set(ad.enum)).toEqual(new Set(["draft", "proposed", "accepted", "rejected", "superseded", "withdrawn"]));
  });
});
