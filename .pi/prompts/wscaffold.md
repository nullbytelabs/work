---
description: Scaffold a new work workflow (or datasource/image/webhook) and verify it compiles
argument-hint: "<name> [hello-world|agent-action]"
---
Scaffold a new `work` workflow named `${1:?name required}`.

1. Load the `work-operator` skill's authoring cheatsheet
   (`.pi/skills/work-operator/references/authoring.md`) and skim `test/e2e/` for the
   closest existing example to copy from.
2. `./bin/work.mjs create $1 --template ${2:-hello-world}` (use `--dry-run` first to
   preview). For other nouns I may ask for `create datasource|image|webhook`.
3. If this is a genuinely new workflow *feature* (matrix, fan-in, a new step type),
   remember the project convention: add a `test/e2e/<name>/` example folder so
   `test/examples.test.ts` picks it up.
4. Verify it compiles before any run: `./bin/work.mjs graph $1 --steps` (or the
   `work_graph` tool). Report the planned DAG and the command to run it for real.
