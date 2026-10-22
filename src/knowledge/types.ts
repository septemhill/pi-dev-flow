/**
 * Project Knowledge types.
 *
 * JSON documents under .factory/knowledge/<kind>/ are the CANONICAL source of
 * truth; the Markdown files under .factory/generated/knowledge/<kind>/ are a
 * deterministic projection (Markdown = Render(Validated JSON, renderer version)).
 *
 * Lifecycle status inside a document is structurally validated by the schema,
 * but effective transitions are enforced ONLY in lifecycle.ts / manager.ts.
 * An Agent-supplied status is never trusted: the extension overwrites it.
 */

export const KNOWLEDGE_TYPES = ["constraint", "convention", "tech-decision"] as const;
export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

/** The stable identifier prefix per knowledge type. */
export const KNOWLEDGE_ID_PREFIX: Record<KnowledgeType, string> = {
  constraint: "CON",
  convention: "CVN",
  "tech-decision": "ADR",
};

export function knowledgeIdPattern(type: KnowledgeType): RegExp {
  return new RegExp(`^${KNOWLEDGE_ID_PREFIX[type]}-[A-Za-z0-9-]+$`);
}

export const KNOWLEDGE_STATUS: Record<KnowledgeType, readonly string[]> = {
  constraint: ["draft", "proposed", "approved", "deprecated"],
  convention: ["draft", "proposed", "approved", "deprecated"],
  "tech-decision": ["draft", "proposed", "accepted", "rejected", "superseded", "withdrawn"],
};

/** The status that makes a record effective (enforced by /factory knowledge approve). */
export function effectiveStatus(type: KnowledgeType): "approved" | "accepted" {
  return type === "tech-decision" ? "accepted" : "approved";
}

export interface KnowledgeScope {
  level: "project" | "directory" | "module";
  paths: string[];
}

export interface ConstraintDoc {
  schema_version: string;
  id: string;
  title: string;
  description: string;
  scope: KnowledgeScope;
  rule: string;
  severity: "error" | "warning";
  verification: {
    method: "automated" | "agent_review" | "human_review";
    validator: string | null;
    instructions: string;
  };
  status: "draft" | "proposed" | "approved" | "deprecated";
}

export interface ConventionExample {
  kind: "positive" | "negative";
  description: string;
  code: string;
}

export interface ConventionDoc {
  schema_version: string;
  id: string;
  title: string;
  description: string;
  scope: KnowledgeScope;
  practice: string;
  rationale: string;
  enforcement: "automated" | "agent_review" | "human_review";
  verification_instructions: string;
  examples: ConventionExample[];
  status: "draft" | "proposed" | "approved" | "deprecated";
}

export interface TechDecisionAlternative {
  option: string;
  reason_not_selected: string;
}

export interface TechDecisionDoc {
  schema_version: string;
  id: string;
  title: string;
  scope: KnowledgeScope;
  status: "draft" | "proposed" | "accepted" | "rejected" | "superseded" | "withdrawn";
  context: string;
  decision: string;
  rationale: string;
  alternatives: TechDecisionAlternative[];
  consequences: string[];
  supersedes: string | null;
}

export type KnowledgeDoc = ConstraintDoc | ConventionDoc | TechDecisionDoc;

export function isKnowledgeType(x: string): x is KnowledgeType {
  return (KNOWLEDGE_TYPES as readonly string[]).includes(x);
}

/** Human-readable label per type. */
export const KNOWLEDGE_TYPE_LABEL: Record<KnowledgeType, string> = {
  constraint: "Constraint",
  convention: "Convention",
  "tech-decision": "Tech Decision",
};

/** Subdirectory per type inside .factory/knowledge/ and .factory/generated/knowledge/. */
export const KNOWLEDGE_SUBDIR: Record<KnowledgeType, string> = {
  constraint: "constraints",
  convention: "conventions",
  "tech-decision": "tech-decisions",
};
