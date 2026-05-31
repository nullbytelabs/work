# Examples

Workflow files, roughly in order of increasing complexity. Run any of them with:

```bash
./pi-workflows ./test/e2e/<name>.yaml
```

Everything here uses only Phase 1 capabilities: `name`, workflow/job/step `env`,
`runs-on` (`local` | `gondolin`), `jobs`, `needs`, and `run` steps.

## Hello world

| File | Shows |
|---|---|
| `hello-world-local.yaml` | the minimal workflow on the host (`runs-on: local`) |
| `hello-world-gondolin.yaml` | the same workflow inside a Gondolin micro-VM (needs Node ≥ 23.6 + QEMU) |
| `hello-world-needs.yaml` | a second job that `needs` the first — and runs on a different target |

## Going further

| File | Shows | New concept |
|---|---|---|
| `pipeline-steps.yaml` | several steps in one job passing data through the shared per-job workspace; step-level env override | steps share a working directory |
| `fan-out-fan-in.yaml` | a diamond DAG: one job fans out to three, which fan back into one | `needs` as fan-out / fan-in |
| `matrix-style.yaml` | sibling jobs per parameter → an aggregate job (the manual stand-in for a future `strategy.matrix`) | parameterized fan-out |
| `inline-polyglot.yaml` | bash + Node + Python steps sharing files and cross-checking results | polyglot `run` steps |
| `generated-script.yaml` | one step authors a POSIX `sh` script, a later step runs it over data — inside a Gondolin VM | scripting + persisted workspace on `gondolin` |

## Notes on current behavior

- **Job ordering.** `needs` defines a DAG; jobs run in deterministic topological
  order (alphabetical among ready jobs). Independent jobs do **not** yet run in
  parallel — that's a planned runtime enhancement. The DAG shape is already
  expressed and respected.
- **Workspaces.** Steps *within a job* share a working directory, so files
  written by one step are visible to the next. Separate jobs get separate
  directories; there is no cross-job artifact passing yet.
- **`local` vs `gondolin`.** `local` runs steps as host child processes and
  inherits the host `PATH` (so `node`/`python3`/etc. are available). The
  Gondolin guest is a minimal Alpine image — no `node`/`python`/`bash`, but it
  does have BusyBox `/bin/sh`. So `inline-polyglot.yaml` (needs node + python)
  is a `local` example, while `generated-script.yaml` runs on `gondolin` by
  keeping its script POSIX-`sh`. Gondolin examples in the test suite are gated
  behind `PI_WF_TEST_GONDOLIN=1` (they need Node ≥ 23.6 + QEMU).
