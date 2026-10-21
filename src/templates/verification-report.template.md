# Verification Report

## Metadata

- Artifact Type: verification-report
- Contract Version: 1.0.0
- Change ID: <change-id>
- Revision: 1
- Status: draft
<!-- Optional: - Updated: <ISO-8601 timestamp> -->

## Pinned Revisions

- Specification Revision: 1
- Specification Hash: sha256:<64-hex hash of the approved spec artifact>
- Implementation Revision: 1
- Implementation Hash: sha256:<64-hex hash of the approved implementation-report artifact>

<!-- Copy the revisions and full sha256 hashes from the phase prompt /
     /factory status. The extension checks both against the persisted
     artifact registry — a mismatch rejects the report. -->

## Scope

<!-- What is verified here, against which specification, and what is out of scope. -->

## Checks

### CHK-001: <check description>

- Reference: <acceptance-criterion or requirement id, e.g. AC-001 — or: tooling>
- Required: yes
- Method: <the command or procedure executed>
- Expected: <what success looks like>
- Actual: <what actually happened, when executed>
- Status: PASS
- Evidence: <key output, truncated but real>

<One record per check recorded with factory_check_record — every recorded
check must appear here with the SAME status, and no check may appear here
without being recorded. Status mapping: PASSED→PASS, FAILED→FAIL,
SKIPPED→SKIPPED, MANUAL→NEEDS_HUMAN. "Required" is "yes" or "no".
Actual and Evidence are required for PASS and FAIL.
Keep CHK ids unique and zero-padded.>

## Coverage

<!-- Map every acceptance criterion to the check(s) that cover it, e.g.
     "- AC-001: covered by CHK-001, CHK-002". Every AC of the spec must be
     covered or explicitly listed here with a reason. -->

## Residual Risks

<!-- Risks that remain after verification, or the single line: None identified -->

## Overall Verdict

- Verdict: PASS

<!-- PASS only if every required check is PASS (NEEDS_HUMAN allowed with a
     note in Residual Risks). Any required FAIL or SKIPPED check forces FAIL.
     The extension recomputes this verdict from the recorded checks — a
     declared verdict that contradicts the results is rejected. -->
