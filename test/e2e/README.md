# Examples / e2e fixtures

Each subfolder is one example. Most are a single `workflow.yaml` plus any
committed companion files (e.g. `run-script/script.sh`); `agent-project/` shows
the fuller **project shape** — `.workflows/*.yaml` pipelines (like
`.github/workflows/`) alongside the project it builds. They double as the
end-to-end fixtures the test suite runs. Run any of them with:

```bash
./pi-workflows ./test/e2e/<name>/workflow.yaml
./pi-workflows --workspace ./test/e2e/agent-project run ci       # project-shaped: by name
./pi-workflows --workspace ./test/e2e/agent-project run review   # its second pipeline
```

When a workflow runs, **its checkout is staged into each job's workspace**
(mounted at `/workspace` in the gondolin guest) — analogous to a
git checkout (`node_modules/` and `.git/` are never staged; a job installs its
own deps). The checkout is the workflow's own folder, or — when the workflow
lives in a `.workflows/` directory — the **project root** (its parent), so
`package.json`/source files are present. Other examples' files are not.

Everything here uses the engine's core capabilities: `name`, workflow/job/step `env`,
per-job `runs-on` (`gondolin`), `jobs`, `needs`, `run` steps,
`strategy.matrix`, and `if`/`when` conditionals.

## Hello world

| Folder | Shows |
|---|---|
| `hello-world-gondolin/` | the minimal workflow inside a Gondolin micro-VM (needs Node ≥ 23.6 + QEMU) |
| `hello-world-needs/` | a second job that `needs` the first, so it runs after it |

## Going further

| Folder | Shows | New concept |
|---|---|---|
| `pipeline-steps/` | several steps in one job passing data through the shared per-job workspace; step-level env override | steps share a working directory |
| `fan-out-fan-in/` | a diamond DAG: one job fans out to three, which fan back into one | `needs` as fan-out / fan-in |
| `inline-polyglot/` | bash + Node + Python steps sharing files and cross-checking results | polyglot `run` steps |
| `run-script/` | a committed `script.sh`, staged into the workspace and run with `sh script.sh` | workspace staging of committed files |
| `with-inputs/` | typed `inputs:` (string `name`, number `age`) mapped into step env vars (defaults `world`/`36`; pass `--inputs '{"name":"josh","age":40}'`) | typed workflow inputs + interpolation |
| `input-validation/` | a `required` enum (`options`) + a regex-`pattern` (UUID) input; bad values are rejected at compile time (`--inputs '{"release":"staging","id":"<uuid>"}'`) | required / options / pattern validators |
| `matrix-build/` | `strategy.matrix` over `node` × `os` with an `exclude` and an `include`, converging into `report` via `needs` | matrix fan-out + `${{ matrix.* }}` |
| `conditional-steps/` | step-level `if` (`inputs.*`, `always()`) and a job-level `if` gate; default `mode=ci` skips the release-only work (`--inputs '{"mode":"release"}'`) | `if`/`when` conditionals |
| `agent-project/` | a **real coding project**: two pipelines + an agent live in `.workflows/` (like `.github/workflows/`), each running against the project-root checkout — `ci.yaml` (`npm install` → `tsc` validity → `npm start` smoke) and `review.yaml` (a workspace-aware agent reads `main.ts` and reviews it). Runs `npm install` for real and the agent runs the real in-guest Pi (gondolin), so it needs Node ≥ 23.6 + QEMU. | `.workflows/` project model; checkout = project root; multiple pipelines per project; workflow-local agents |

## Notes on current behavior

- **Workspace staging.** A job's workspace starts as a copy of the workflow's
  folder. Each job gets its own copy, so jobs stay isolated; steps *within* a job
  share it (a file written by one step is visible to the next).
- **Job ordering.** `needs` defines a DAG; jobs run in deterministic topological
  order (alphabetical among ready jobs), and independent jobs run **in parallel**
  via the Absurd worker's concurrency. There is no cross-job artifact passing
  beyond job/step `outputs` yet.
- **`runs-on`: always `gondolin`.** Every example runs in the Gondolin micro-VM.
  The guest is fully equipped — `sh`, `bash`, `node`, `npm`, and `python3` are all
  present — so even `inline-polyglot/` (bash + node + python) runs entirely in the
  sandbox; no step needs the host. `runs-on: local` has been **removed** — host
  execution is gone, `gondolin` is the only target, and `runs-on: local` is a hard
  compile error. An omitted `runs-on` defaults to `gondolin` (the compiler warns,
  nudging you to state it explicitly). The whole suite therefore boots real
  micro-VMs — `npm test` needs Node ≥ 23.6 + QEMU on the machine.
