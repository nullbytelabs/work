---
description: Show work run history and surface the actionable (unfinished) runs
argument-hint: "[status]"
---
Show the `work` run history using the `work_runs` tool${1:+ filtered to status "$1"}.
Then:

1. Present the table (id, workflow, status, when), newest-first.
2. Call out any unfinished runs (interrupted/running/queued) — these are actionable.
   For each, give the exact `work resume <id>` (continue, reuse finished jobs) or
   `work rerun <id>` (fresh) command.
3. If I name a run of interest, offer `work logs <id>` to replay its stored log.
