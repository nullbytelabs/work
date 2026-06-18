---
description: Resume or rerun a prior work run by id (continue reusing finished jobs, or fresh)
argument-hint: "[id]"
---
Recover a prior `work` run.

1. If `$1` is given, use it as the run id; otherwise call the `work_runs` tool and
   pick the most recent unfinished run (interrupted/running/queued), confirming with
   me which one.
2. `rm -rf dist` first.
3. By default `./bin/work.mjs resume <id>` — continues the run, **reusing finished
   jobs** (only the unfinished/failed jobs re-execute). Use `rerun <id>` instead only
   if I want a completely fresh run with the same inputs.
4. Tee to a log, background, wait, then report the final per-job status and id.
