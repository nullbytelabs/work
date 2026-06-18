---
description: Run a work workflow by name (boots real VMs), then report the verdict
argument-hint: "<name> [--inputs '<json>']"
---
Run the `work` workflow `${1:?workflow name required}` end-to-end. Steps:

1. First ensure `dist/` is absent (`rm -rf dist`) so the bin shim runs `src/` live.
2. Launch in the background and tee the output, e.g.
   `./bin/work.mjs run $@ 2>&1 | tee /tmp/work-$1.log` — a real run boots
   micro-VMs and can take minutes; wait for it rather than a short foreground call.
3. When it finishes, summarize the result: per-job status, any failed step (with
   the failing `steps.<id>.logs`), and the run id. Use the `work_runs` tool for the
   authoritative verdict + id.
4. If it was interrupted, tell me the `work resume <id>` command to continue it.

Do not mock or shortcut the run — the real VM execution is the point.
