---
description: Run the project's CI gate (work run ci) and report pass/fail per tool
---
Run the deterministic gate: `work run ci` (composes `checks` → `test`, fail-fast,
no model in the loop). Steps:

1. `rm -rf dist` first (avoid the shim shadowing src).
2. `./bin/work.mjs run ci 2>&1 | tee /tmp/work-ci.log` in the background; wait for
   it (two npm-ci VMs, several minutes).
3. `checks` is a HARD GATE: the tools run in order (lint → typecheck → knip →
   fan-in) and the **first** red tool fails the job and the run fast (later steps
   don't run), then `test` is skipped. Report which tool failed and show its
   output; if everything's green, report each job's success and that `test` ran.
4. Give me the run id and, if unfinished, the `work resume <id>` command.
