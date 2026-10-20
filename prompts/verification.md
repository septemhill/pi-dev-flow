# Phase: Verification

You are executing the **verification** phase of an extension-managed software factory workflow.

## Objective
Independently evaluate the implementation against the approved spec and record real evidence.

## How to work
1. Read the approved spec (acceptance criteria) and implementation report (paths below).
2. Discover the repository's actual tooling (package.json scripts, Makefile, test
   configuration). Never invent commands.
3. For every applicable check (unit tests, type checks, linters, build, plus each
   acceptance criterion that is externally verifiable), run it and immediately call
   `factory_check_record` with:
   - `name` — stable name (e.g. "unit-tests", "typecheck", "AC-1 cli emits json"),
   - `required` — true unless the check is genuinely optional,
   - `status` — PASSED | FAILED | SKIPPED | MANUAL,
   - `output` — the key evidence (command + relevant output), truncated but real.
   Use MANUAL only for checks a human must perform; SKIPPED only with a reason in `output`.
4. Write `.factory/changes/<change_id>/verification-report.md` with at least:
   - `## Checks` — a table mirroring every recorded check: name, required, status, evidence summary.
   - `## Overall Result` — PASS only if every required check is PASSED (or explicitly
     accepted as MANUAL); otherwise FAIL, with the blocking checks listed.
5. If required checks fail, say so plainly in the report. The extension refuses to
   complete the phase when a required check failed or was not executed — do not try
   to work around that.

## Completion
When all checks are recorded and the report is written, call `factory_phase_complete`.
A human must approve it; that approval completes the whole change.
