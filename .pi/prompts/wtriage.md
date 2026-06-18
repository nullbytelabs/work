---
description: Triage findings from an existing review run log without re-running
argument-hint: "[logfile]"
---
Triage the findings from a review log (default `/tmp/work-review.log` if no path
given): `${1:-/tmp/work-review.log}`.

1. Extract the verified REVIEW JSON with the `work_review` tool on that file.
2. For each finding (subsystem/file/line/severity/issue/fix/evidence), open the
   cited code and **independently confirm** it — the editor agent verifies, but I own
   the fix. Treat false positives as candidates for rejection.
3. Produce a triage table: finding → decision (FIX / REJECT) → rationale.
4. For FIX: make the change and add a regression test. For REJECT: append a specific,
   reasoned entry to `.review/accepted.md` (the suppression channel).
5. Show me the table and the plan before making edits.
