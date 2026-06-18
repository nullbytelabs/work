# `work` command & flag reference

Exhaustive verb/flag matrix and the gotchas the CLI enforces (`src/cli.ts`).
The dev launcher is `./bin/work.mjs`; production users invoke `work`.

## Verb resolution order

`parseArgs` dispatches on the first positional, in this order: `runs` → `resume`
→ `rerun` → `logs` → `serve` → `graph` → `run` → (else) bare file path.

## Global / common flags

| Flag | Applies to | Meaning |
|---|---|---|
| `--workdir <dir>` | all run forms | scratch/working directory for the run |
| `--quiet` | all run forms | silent presenter |
| `--no-global` | all | hermetic: ignore the global creds home, project config only |
| `--config <file>` | all | explicit config file (else layered global + project `work.json`) |
| `--datasources <a,b>` | run forms | enable named datasources (scoped egress with header-injected token) |
| `--inputs '<json>'` | run forms | bind typed inputs at compile time; must be a JSON **object** |
| `-h` / `--help` | any | print usage, exit 0 |

## Verb-specific flags & rules

| Verb | Extra flags | Rules the CLI enforces (exit 2 on violation) |
|---|---|---|
| `<file.yaml>` (bare) | `--resume <id>` | `--workspace` rejected (pass a path directly); `--format`/`--steps` rejected |
| `run <name>` | `--workspace`, `--resume <id>` | requires a name; one positional only |
| `graph <file\|name>` | `--format mermaid\|dot\|json\|ascii` (default mermaid), `--steps`, `--workspace` (by-name only) | target is a file if it ends `.ya?ml` or has `/`, else by-name; `--resume` rejected |
| `resume <id>` | `--workspace` | needs an id; `--resume` flag and `--format`/`--steps` rejected; reuses finished jobs |
| `rerun <id>` | `--workspace` | needs an id; same rejections as `resume`; runs fresh with same inputs |
| `runs` | `--status queued\|running\|success\|failure\|interrupted`, `--workspace` | no positionals; `--format`/`--steps`/`--resume` rejected |
| `logs <id>` | `--workspace` | needs an id (short prefix ok); `--resume`/`--format`/`--steps` rejected |
| `serve` | `--port <1-65535>`, `--workspace` | no positionals; `--format`/`--steps`/`--resume` rejected |
| `init` | `--global`, `--include-skill`, `--from-template hello-world\|agent-action`, `--force`, `--dry-run` | scaffolds a workspace |
| `create <name>` | `--template hello-world\|agent-action`, `--force`, `--dry-run` | scaffolds one workflow; `create datasource\|image\|webhook` for other nouns |
| `doctor` | `--json` | preflight checks |

## `runs` output

Columns: `ID  WORKFLOW  STATUS  WHEN` (relative time). Unfinished runs
(`interrupted`/`running`/`queued`) get a resume hint line. The id shown is an
8-char prefix — fine to pass back to `resume`/`rerun`/`logs`.

## `serve`

Boots one shared engine for all runs over a workspace's `.workflows/`: HTTP API,
web console, webhook receiver, scheduler. Persists history to `.workflows/db`
(PGLite, single-process owner). Prints `url`, `workspace`, `history`, `auth token`.
`ci` is `on: webhook`, so `serve` is how you exercise the webhook trigger locally.

## Resolution: ad-hoc file vs by-name

- **`work <file.yaml>`** → ad-hoc; checks out the file's **own folder**.
- **`work run <name>`** → resolves `.workflows/*.yaml` by `name:`; checks out the
  **project root** (parent of `.workflows/`). `--workspace` scopes the lookup.
- `.git/` and `node_modules/` are never staged into a job — jobs `npm ci` themselves.
