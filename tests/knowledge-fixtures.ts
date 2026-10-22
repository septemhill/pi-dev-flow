import type { ConventionDoc, ConstraintDoc, TechDecisionDoc } from "../src/knowledge/types.ts";

/**
 * Minimal schema-valid Project Knowledge documents for tests. Builders return
 * fresh copies so tests can mutate them freely.
 */

export function baseConstraint(over: Partial<ConstraintDoc> = {}): ConstraintDoc {
  return {
    schema_version: "1.0.0",
    id: "CON-001",
    title: "No credentials in logs",
    description: "Credential material must never reach application log output.",
    scope: { level: "project", paths: [] },
    rule: "Credential material must never be written to application logs.",
    severity: "error",
    verification: { method: "human_review", validator: null, instructions: "Grep log code for credential access; review in PR." },
    status: "draft",
    ...over,
  };
}

export function baseConvention(over: Partial<ConventionDoc> = {}): ConventionDoc {
  return {
    schema_version: "1.0.0",
    id: "CVN-001",
    title: "Structured logging only",
    description: "All log statements must use the project's structured logger.",
    scope: { level: "project", paths: [] },
    practice: "Use the project's structured logging library for all log output.",
    rationale: "Consistent machine-parseable logs simplify operations.",
    enforcement: "agent_review",
    verification_instructions: "Check new code for direct console/log calls outside the logger wrapper.",
    examples: [
      { kind: "positive", description: "Uses the structured logger.", code: "log.info('req done', { ms })" },
      { kind: "negative", description: "Raw console output.", code: "console.log('done', ms)" },
    ],
    status: "draft",
    ...over,
  };
}

export function baseDecision(over: Partial<TechDecisionDoc> = {}): TechDecisionDoc {
  return {
    schema_version: "1.0.0",
    id: "ADR-001",
    title: "PostgreSQL as primary database",
    scope: { level: "project", paths: [] },
    status: "draft",
    context: "The service needs a relational store.",
    decision: "Use PostgreSQL as the primary relational database.",
    rationale: "Operational maturity and SQL expressiveness.",
    alternatives: [{ option: "SQLite", reason_not_selected: "No concurrent write support for the service tier." }],
    consequences: ["Operational expertise required."],
    supersedes: null,
    ...over,
  };
}
