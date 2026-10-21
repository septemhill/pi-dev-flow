# Phase: Verification

You are executing the **verification** phase of an extension-managed software factory workflow.

## Objective
Independently evaluate the implementation against the approved spec and record real evidence.

## How to work
1. Read the approved spec (acceptance criteria) and implementation report
   (paths in your work order).
2. Discover the repository's actual tooling (package.json scripts, Makefile,
   test configuration). Never invent commands.
3. For every applicable check (unit tests, type checks, linters, build, plus
   each acceptance criterion that is externally verifiable), run it and
   immediately call `factory_check_record` with:
   - `name` — stable name (e.g. "unit-tests", "typecheck", "ac-001-cli-emits-json"),
   - `required` — true unless the check is genuinely optional,
   - `status` — PASSED | FAILED | SKIPPED | MANUAL,
   - `output` — the key evidence (command + relevant output), truncated but real.
   Use MANUAL only for checks a human must perform; SKIPPED only with a reason
   in `output`.
4. `Pinned Revisions` must pin the recorded revisions and FULL sha256 of the
   approved spec and implementation artifacts (copy them from your work order).
5. `Checks` must mirror every recorded check: record title = check name,
   required flag identical, and status mapped PASSED→PASS, FAILED→FAIL,
   SKIPPED→SKIPPED, MANUAL→NEEDS_HUMAN.
6. `Coverage` must show how every acceptance criterion is covered. The
   `Overall Verdict` must match the recorded results: PASS only if no required
   check FAILED or was SKIPPED.
7. If required checks fail, say so plainly in the report. The extension refuses
   to complete the phase when a required check failed or was not executed — do
   not try to work around that.

## Completion
When all checks are recorded and the report is written, call
`factory_phase_complete`. A human must approve it; that approval completes the
whole change.
