# Examples / e2e fixtures

Each subfolder is one example: a `workflow.yaml` plus any committed companion
files (e.g. `run-script/script.sh`). They double as the end-to-end fixtures the
test suite runs. Run any of them with:

```bash
./pi-workflows ./test/e2e/<name>/workflow.yaml
```

When a workflow runs, **its folder is staged into each job's workspace** (copied
in for `local`, mounted at `/workspace` for `gondolin`) — analogous to a
checkout. So files committed next to `workflow.yaml` are available to the steps,
and other examples' files are not.

Everything here uses only Phase 1 capabilities: `name`, workflow/job/step `env`,
per-job `runs-on` (`local` | `gondolin`), `jobs`, `needs`, and `run` steps.

## Hello world

| Folder | Shows |
|---|---|
| `hello-world-local/` | the minimal workflow on the host (`runs-on: local`) |
| `hello-world-gondolin/` | the same workflow inside a Gondolin micro-VM (needs Node ≥ 23.6 + QEMU) |
| `hello-world-needs/` | a second job that `needs` the first — and runs on a different target |

## Going further

| Folder | Shows | New concept |
|---|---|---|
| `pipeline-steps/` | several steps in one job passing data through the shared per-job workspace; step-level env override | steps share a working directory |
| `fan-out-fan-in/` | a diamond DAG: one job fans out to three, which fan back into one | `needs` as fan-out / fan-in |
| `inline-polyglot/` | bash + Node + Python steps sharing files and cross-checking results | polyglot `run` steps |
| `run-script/` | a committed `script.sh`, staged into the workspace and run with `sh script.sh` | workspace staging of committed files |
| `with-inputs/` | typed `inputs:` (string `name`, number `age`) mapped into step env vars (defaults `world`/`36`; pass `--inputs '{"name":"josh","age":40}'`) | typed workflow inputs + interpolation |
| `input-validation/` | a `required` enum (`options`) + a regex-`pattern` (UUID) input; bad values are rejected at compile time (`--inputs '{"release":"staging","id":"<uuid>"}'`) | required / options / pattern validators |
| `agent-summarize/` | a job emits a job `output`; a dependent reads it via `needs.<job>.outputs` and runs `agent/summarize`, exposing `steps.<id>.outputs.summary` (needs `--config`; the suite mocks the LLM) | outputs + `needs.*`/`steps.*` + agent step |

## Notes on current behavior

- **Workspace staging.** A job's workspace starts as a copy of the workflow's
  folder. Each job gets its own copy, so jobs stay isolated; steps *within* a job
  share it (a file written by one step is visible to the next).
- **Job ordering.** `needs` defines a DAG; jobs run in deterministic topological
  order (alphabetical among ready jobs). Independent jobs do **not** yet run in
  parallel — that's a planned runtime enhancement. The DAG shape is already
  expressed and respected. There is no cross-job artifact passing yet.
- **`local` vs `gondolin`.** `local` runs steps as host child processes and
  inherits the host `PATH` (so `node`/`python3`/etc. are available). The Gondolin
  guest is a minimal Alpine image — no `node`/`python`/`bash`, but it does have
  BusyBox `/bin/sh`. So `inline-polyglot/` (needs node + python) is `local`,
  while scripts meant to run under `gondolin` must stay POSIX-`sh`. In the test
  suite, any example with a `gondolin` job is gated behind `PI_WF_TEST_GONDOLIN=1`
  (needs Node ≥ 23.6 + QEMU).
