---
description: Run agent code review (work run review, or a focused <x>-review) and triage findings
argument-hint: "[security|compiler|runtime|web]"
---
Run `work` code review and triage like a maintainer.

1. `rm -rf dist`. Confirm `work.json` has a `defaultModel` (review needs a model;
   never `cat work.json` — check `work.example.json` for shape if unsure).
2. If `$1` is one of security/compiler/runtime/web, run the focused
   `./bin/work.mjs run $1-review` (2 agent VMs, minutes). Otherwise run the full
   `./bin/work.mjs run review` (9 agent VMs, ~10 min). Tee to `/tmp/work-review.log`,
   background, wait.
3. Extract the verified findings with the `work_review /tmp/work-review.log` tool
   (aggregate = unlabeled sentinel; focused = `[<subsystem>]` labeled).
4. For each finding: independently confirm it in the code, then either FIX it
   (+ a regression test) or REJECT it by appending a specific entry to
   `.review/accepted.md`. Never silently ignore one. Show me the plan before editing.
5. Re-run after fixes; the goal state is `"verdict":"clean"`.
