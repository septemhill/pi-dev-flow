import type { Phase } from "../workflow/phases.ts";
import type { ArtifactContract, SectionSpec } from "./artifact-types.ts";

/**
 * The artifact contract registry.
 *
 * This is TRUSTED, version-controlled extension code: it is the single source
 * of truth for which template, schema, parser and sections each phase's
 * artifact must follow. The LLM can read the templates (they are embedded in
 * its phase prompt) but has no tool to register, edit or select contracts.
 *
 * Bumping a contract version: change templateVersion + the template file +
 * the schema ($id carries the version) + the parser if needed, and keep the
 * previous files in git history so old revisions remain verifiable.
 */

export const CONTRACT_VERSION = "1.0.0"; // base version; individual contracts may be higher (spec/design 1.1.0)
export const PARSER_VERSION = "1.0.0";
export const SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema";
const SCHEMA_ID_BASE = "https://pi-ai-factory.local/schemas/";

/** Shared metadata contract for every artifact type. */
const METADATA: SectionSpec = {
  name: "Metadata",
  prop: "metadata",
  kind: "keyvalue",
  required: true,
  allowsNA: false,
  kvKeys: [
    { key: "Artifact Type", prop: "artifactType", required: true },
    { key: "Contract Version", prop: "contractVersion", required: true },
    { key: "Change ID", prop: "changeId", required: true },
    { key: "Revision", prop: "revision", required: true },
    { key: "Status", prop: "status", required: true },
    { key: "Updated", prop: "updatedAt", required: false },
  ],
};

function section(
  name: string,
  prop: string,
  kind: SectionSpec["kind"],
  opts: Partial<Omit<SectionSpec, "name" | "prop" | "kind">> = {},
): SectionSpec {
  return {
    name,
    prop,
    kind,
    required: opts.required ?? true,
    allowsNA: opts.allowsNA ?? false,
    recordIdPrefix: opts.recordIdPrefix,
    recordFields: opts.recordFields,
    kvKeys: opts.kvKeys,
    allowEmptyDescription: opts.allowEmptyDescription,
  };
}

const REQ_FIELDS = [
  { name: "Priority", prop: "priority", required: true },
  { name: "Source", prop: "source", required: true },
  { name: "Rationale", prop: "rationale", required: true },
  { name: "Acceptance Intent", prop: "acceptanceIntent", required: true },
] as const;

const FR_FIELDS = [{ name: "References", prop: "references", required: true }] as const;

const AC_FIELDS = [
  { name: "References", prop: "references", required: true },
  { name: "Verification", prop: "verification", required: true },
] as const;

const DES_FIELDS = [
  { name: "References", prop: "references", required: true },
  { name: "Rationale", prop: "rationale", required: true },
  { name: "Consequences", prop: "consequences", required: true },
  { name: "Alternatives", prop: "alternatives", required: false },
] as const;

const TASK_FIELDS = [
  { name: "Scope", prop: "scope", required: true },
  { name: "Expected Output", prop: "expectedOutput", required: true },
  { name: "Verification", prop: "verification", required: true },
  { name: "Dependencies", prop: "dependencies", required: true },
  { name: "References", prop: "references", required: true },
] as const;

const TASK_RESULT_FIELDS = [
  { name: "Status", prop: "status", required: true },
  { name: "Evidence", prop: "evidence", required: true },
] as const;

const CHECK_FIELDS = [
  { name: "Reference", prop: "reference", required: true },
  { name: "Required", prop: "required", required: true },
  { name: "Method", prop: "method", required: true },
  { name: "Expected", prop: "expected", required: true },
  { name: "Actual", prop: "actual", required: false },
  { name: "Status", prop: "status", required: true },
  { name: "Evidence", prop: "evidence", required: false },
] as const;

/** Bounded semantic coverage review (model-attested, extension-validated). */
const REVIEW_FIELDS = [
  { name: "Upstream", prop: "upstream", required: true },
  { name: "Downstream", prop: "downstream", required: true },
  { name: "Stage", prop: "stage", required: true },
  { name: "Status", prop: "status", required: true },
  { name: "Missing Obligations", prop: "missingObligations", required: true },
  { name: "Rationale", prop: "rationale", required: true },
] as const;

function contract(
  phase: Phase,
  artifactType: string,
  title: string,
  templateFile: string,
  schemaFile: string,
  sectionOrder: readonly SectionSpec[],
  version: string = CONTRACT_VERSION,
): ArtifactContract {
  const required = sectionOrder.filter((s) => s.required).map((s) => s.name);
  return {
    artifactType,
    phase,
    title,
    templateId: `${artifactType}.template`,
    templateVersion: version,
    schemaId: `${SCHEMA_ID_BASE}${artifactType}.schema.json#${version}`,
    schemaVersion: version,
    parserVersion: PARSER_VERSION,
    templateFile,
    schemaFile,
    requiredSections: required,
    sectionOrder,
    validationProfile: `${artifactType}-v1`,
  };
}

/** The six pinned artifact contracts, one per phase. */
export const ARTIFACT_CONTRACTS: Record<Phase, ArtifactContract> = {
  requirement: contract(
    "requirement",
    "requirement",
    "Requirement",
    "requirement.template.md",
    "requirement.schema.json",
    [
      METADATA,
      section("Context", "context", "text"),
      section("Goals", "goals", "list"),
      section("Non-Goals", "nonGoals", "list", { allowsNA: true }),
      section("Requirements", "requirements", "records", {
        recordIdPrefix: "REQ",
        recordFields: REQ_FIELDS,
      }),
      section("Constraints", "constraints", "list", { allowsNA: true }),
      section("Assumptions", "assumptions", "text", { allowsNA: true }),
      section("Open Questions", "openQuestions", "text", { allowsNA: true }),
      section("Stakeholders", "stakeholders", "text", { required: false, allowsNA: true }),
      section("Change History", "changeHistory", "text", { required: false, allowsNA: true }),
    ],
  ),

  spec: contract(
    "spec",
    "spec",
    "Specification",
    "spec.template.md",
    "spec.schema.json",
    [
      METADATA,
      section("Scope", "scope", "text"),
      section("Referenced Requirements", "referencedRequirements", "list"),
      section("Expected Behavior", "expectedBehavior", "text"),
      section("Functional Requirements", "functionalRequirements", "records", {
        recordIdPrefix: "FR",
        recordFields: FR_FIELDS,
        allowsNA: true,
      }),
      section("Inputs", "inputs", "text"),
      section("Outputs", "outputs", "text"),
      section("Error Behavior", "errorBehavior", "text"),
      section("Boundary Conditions", "boundaryConditions", "text", { allowsNA: true }),
      section("Acceptance Criteria", "acceptanceCriteria", "records", {
        recordIdPrefix: "AC",
        recordFields: AC_FIELDS,
      }),
      section("Coverage Review", "coverageReview", "records", {
        recordIdPrefix: "SR",
        recordFields: REVIEW_FIELDS,
        allowsNA: true,
        allowEmptyDescription: true,
      }),
      section("External Verification Contract", "verificationContract", "text"),
      section("Non-Functional Requirements", "nonFunctionalRequirements", "text", {
        required: false,
        allowsNA: true,
      }),
      section("Unresolved Questions", "unresolvedQuestions", "text", { allowsNA: true }),
    ],
    "1.1.0", // spec 1.1.0: Coverage Review section (bounded semantic attestation)
  ),

  design: contract(
    "design",
    "design",
    "Design",
    "design.template.md",
    "design.schema.json",
    [
      METADATA,
      section("Context", "context", "text"),
      section("Referenced Artifacts", "referencedArtifacts", "text"),
      section("Repository Findings", "repositoryFindings", "text"),
      section("Architecture", "architecture", "text"),
      section("Component Responsibilities", "componentResponsibilities", "text"),
      section("Data Model & Persistence", "dataModel", "text", { allowsNA: true }),
      section("Interfaces & Interactions", "interfaces", "text", { allowsNA: true }),
      section("Runtime & Infrastructure", "runtime", "text", { allowsNA: true }),
      section("Library Choices", "libraryChoices", "text", { allowsNA: true }),
      section("Security & Trust Boundaries", "security", "text", { allowsNA: true }),
      section("Error Handling & Recovery", "errorHandling", "text", { allowsNA: true }),
      section("Testing Strategy", "testingStrategy", "text"),
      section("Design Decisions", "designDecisions", "records", {
        recordIdPrefix: "DES",
        recordFields: DES_FIELDS,
      }),
      section("Coverage Review", "coverageReview", "records", {
        recordIdPrefix: "SR",
        recordFields: REVIEW_FIELDS,
        allowsNA: true,
        allowEmptyDescription: true,
      }),
      section("Risks", "risks", "text", { allowsNA: true }),
      section("Open Questions", "openQuestions", "text", { allowsNA: true }),
    ],
    "1.1.0", // design 1.1.0: DES References field + Coverage Review section
  ),

  task_planning: contract(
    "task_planning",
    "task-plan",
    "Task Plan",
    "task-plan.template.md",
    "task-plan.schema.json",
    [
      METADATA,
      section("Upstream References", "upstreamReferences", "keyvalue", {
        kvKeys: [
          { key: "Requirement", prop: "requirement", required: true },
          { key: "Spec", prop: "spec", required: true },
          { key: "Design", prop: "design", required: true },
        ],
      }),
      section("Strategy", "strategy", "text"),
      section("Tasks", "tasks", "records", {
        recordIdPrefix: "TASK",
        recordFields: TASK_FIELDS,
        allowEmptyDescription: true,
      }),
      section("Dependencies", "dependencies", "text", { allowsNA: true }),
      section("Expected Outputs", "expectedOutputs", "text"),
      section("Verification Criteria", "verificationCriteria", "text"),
      section("Risks & Blockers", "risksBlockers", "text", { allowsNA: true }),
      section("Deferred Work", "deferredWork", "text", { required: false, allowsNA: true }),
    ],
  ),

  implementation: contract(
    "implementation",
    "implementation-report",
    "Implementation Report",
    "implementation-report.template.md",
    "implementation-report.schema.json",
    [
      METADATA,
      section("Approved Task Plan", "approvedTaskPlan", "keyvalue", {
        kvKeys: [
          { key: "Revision", prop: "revision", required: true },
          { key: "Hash", prop: "hash", required: true },
        ],
      }),
      section("Task Results", "taskResults", "records", {
        recordIdPrefix: "TASK",
        recordFields: TASK_RESULT_FIELDS,
        allowEmptyDescription: true,
      }),
      section("Modified Files", "modifiedFiles", "list"),
      section("Commands Executed", "commandsExecuted", "list"),
      section("Test & Build Results", "testResults", "text"),
      section("Deviations", "deviations", "text", { allowsNA: true }),
      section("Known Limitations", "knownLimitations", "text", { allowsNA: true }),
      section("Unresolved Issues", "unresolvedIssues", "text", { allowsNA: true }),
      section("Evidence References", "evidenceReferences", "text", { allowsNA: true }),
    ],
  ),

  verification: contract(
    "verification",
    "verification-report",
    "Verification Report",
    "verification-report.template.md",
    "verification-report.schema.json",
    [
      METADATA,
      section("Pinned Revisions", "pinnedRevisions", "keyvalue", {
        kvKeys: [
          { key: "Specification Revision", prop: "specificationRevision", required: true },
          { key: "Specification Hash", prop: "specificationHash", required: true },
          { key: "Implementation Revision", prop: "implementationRevision", required: true },
          { key: "Implementation Hash", prop: "implementationHash", required: true },
        ],
      }),
      section("Scope", "scope", "text"),
      section("Checks", "checks", "records", {
        recordIdPrefix: "CHK",
        recordFields: CHECK_FIELDS,
        allowEmptyDescription: true,
      }),
      section("Coverage", "coverage", "text"),
      section("Residual Risks", "residualRisks", "text", { allowsNA: true }),
      section("Overall Verdict", "overallVerdict", "keyvalue", {
        kvKeys: [{ key: "Verdict", prop: "verdict", required: true }],
      }),
    ],
  ),
};

export function getContract(phase: Phase): ArtifactContract {
  const c = ARTIFACT_CONTRACTS[phase];
  if (!c) throw new Error(`No artifact contract registered for phase "${phase}"`);
  return c;
}

export function contractByArtifactType(artifactType: string): ArtifactContract | null {
  for (const c of Object.values(ARTIFACT_CONTRACTS)) {
    if (c.artifactType === artifactType) return c;
  }
  return null;
}
