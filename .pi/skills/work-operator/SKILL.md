---
name: work-operator
description: Operating the `work` engine as a power user — running, resuming, inspecting, and triaging local workflows, reading run output and history, authoring/scaffolding workflows, and driving the project's own CI/review pipelines. Use whenever the task is to RUN or OPERATE work (`work run/runs/resume/rerun/logs/graph/serve/doctor/init/create`), interpret a run's result, or drive `work run ci|review|checks|test`. (For changing the engine's own source, the sibling `work` skill is the dev layer.)
---

# Operating `work`

This skill is the **operator's manual**: every command, the run lifecycle, how to
read results, and the playbooks for triage and recovery. The sibling `work` skill
covers *developing the engine*; this one covers *driving it*. AGENTS.md is the
architecture map.

The companion **`work` extension** (`.pi/extensions/work/`) gives me deterministic
tools — prefer them over scraping stdout:
- `work_runs` — structured run history (id, workflow, status, when)
- `work_graph` — compiled DAG as JSON for a workflow file/name
- `work_doctor` — preflight status as JSON
- `work_review` — extract the verified REVIEW JSON (findings) from a run log

And the prompt templates (`/wrun`, `/wci`, `/wreview`, `/wtriage`, `/wruns`,
`/wresume`, `/wgraph`, `/wscaffold`) are the fast paths for the common operations.

## Prime directives

1. **Never let `dist/` shadow `src/`.** The bin shim prefers `dist/cli.js`; if it
   exists it runs stale built code and silently ignores your `src/` edits. Before
   any real run during development, ensure `dist/` is absent (`rm -rf dist`). The
   extension blocks runs while `dist/` is present.
2. **The dev launcher is `./bin/work.mjs`** (runs `src/cli.ts` live, no build).
   `npm start --` is the same thing. Production users get the `work` command.
3. **Real runs boot real micro-VMs and need QEMU.** `work doctor` first if unsure.
4. **Agent/review runs need a model in `work.json`** (gitignored; copy
   `work.example.json`, `apiKey` takes `$VAR`). The key is injected host-side via
   mediated egress — it never enters the guest. Never `cat work.json` (secrets);
   read `work.example.json` for shape.

## The command surface (complete)

All commands accept `--workdir <dir>` (scratch dir), `--quiet`, `--no-global`
(hermetic; ignore the global creds home), `--config <file>`, and
`--datasources <a,b>` where they make sense.

| Command | What it does |
|---|---|
| `work <file.yaml>` | Run an **ad-hoc** workflow file. Checks out the file's own folder. |
| `work [--workspace <dir>] run <name>` | Run the `.workflows/*.yaml` whose `name:` matches. Checks out the **project root**. |
| `… run <name> --inputs '<json>'` | Bind typed inputs at compile time (`'{"name":"ada"}'`). |
| `… run <name> --resume <id>` | Resume a specific prior run id into this run. |
| `work [--workspace <dir>] resume <id>` | Continue an interrupted run — **reuses finished jobs** (workflow+inputs from history). |
| `work [--workspace <dir>] rerun <id>` | Re-run a past run **fresh**, same inputs. |
| `work [--workspace <dir>] runs [--status …]` | Run history, newest-first. `--status queued\|running\|success\|failure\|interrupted`. |
| `work [--workspace <dir>] logs <id>` | Replay a past run's stored log (web-run logs; id by short prefix). |
| `work graph <file.yaml> [--format mermaid\|dot\|json\|ascii] [--steps]` | Emit the compiled DAG instead of running. `--steps` expands step-level detail. |
| `work [--workspace <dir>] graph <name> [--format …] [--steps]` | Same, by workflow name (resolves from cwd like `run`). |
| `work [--workspace <dir>] serve [--port <n>]` | Boot the long-lived host: HTTP API + web console + webhook receiver + scheduler over `.workflows/`. Prints URL + auth token. Ctrl-C stops. |
| `work init [--global] [--include-skill] [--from-template hello-world\|agent-action] [--force] [--dry-run]` | Scaffold a workspace. |
| `work create <name> [--template hello-world\|agent-action] [--force] [--dry-run]` | Scaffold a single workflow. (Also `create datasource\|image\|webhook` per scaffold subsystem.) |
| `work doctor [--json]` | Preflight: Node version, gondolin SDK, QEMU, config. Run first when a real run misbehaves. |

`graph`-only flags: `--format`, `--steps`. `serve`-only: `--port`. The CLI rejects
mismatched flags with exit 2 — see [references/commands.md](references/commands.md)
for the full flag/verb matrix and gotchas.

## The run lifecycle (how to read a result)

A run walks the `needs` DAG; independent jobs run in parallel up to a concurrency
cap, each job in its own micro-VM. Everything is journaled to PGLite under
`.workflows/db` (gitignored), which is what makes runs **resumable**.

- **Live**: on a TTY you get a DAG board; in a pipe, buffered per-job blocks;
  `--quiet` is silent. Tee long runs: `./bin/work.mjs run ci 2>&1 | tee /tmp/ci.log`.
- **Outputs**: a step appends `key=value` (or `key<<EOF` heredoc) to `$WORK_OUTPUT`;
  read as `${{ steps.<id>.outputs.<key> }}`. Every `id`ed step also exposes
  `${{ steps.<id>.logs }}`, `.outcome` (success/failure/skipped), `.exitCode` free.
  Cross-job: `${{ needs.<job>.outputs.<key> }}`.
- **After a run**: `work runs` (or the `work_runs` tool) for the verdict + id;
  `work logs <id>` replays a web run. Unfinished runs (`interrupted`/`running`/
  `queued`) are the actionable ones — resume them.
- **Recovery**: `work resume <id>` continues (reuses finished jobs); `work rerun <id>`
  starts fresh. Ids come from `work runs` (short prefix is fine).

## The project's own pipelines (dogfood)

`.workflows/` holds the repo's CI, run by the engine itself. These are the workhorses:

| `work run …` | What | Cost |
|---|---|---|
| `ci` | `checks` → `test` (composes via `uses: workflow/<name>`), fail-fast. The deterministic gate. | 2 npm-ci VMs |
| `checks` | one VM: `npm ci`, then lint → typecheck → knip → fan-in in order. **Hard gate**: the first red tool fails the job and the run fast (later steps skipped); each tool's `outcome` is still forwarded to `review`. Note: `.pi/` is in the checked-out tree, so lint/typecheck cover extensions too. | 1 VM |
| `test` | self-hosts the FULL suite (incl. real-VM e2e) in **nested** gondolin VMs (`work:nested`, TCG). Needs a roomy host. | nested VMs |
| `review` | composition of four focused reviews (`security`/`compiler`/`runtime`/`web`) + a `collect` merge that de-dupes/ranks/caps to 6 and emits sentinel-wrapped JSON. Needs a model. | 9 agent VMs |
| `<x>-review` | one focused subsystem review (`security`/`compiler`/`runtime`/`web`): `scan` → `collect`, labeled sentinels. Minutes, not ~10. | 2 agent VMs |

Reading a review verdict: a `collect` job prints verified JSON between sentinels.
Aggregate (`ci`/`review`): unlabeled `===== REVIEW JSON BEGIN/END =====`. Focused:
`===== REVIEW JSON [<subsystem>] BEGIN/END =====`. A failed-tool `ci` run prints a
deterministic `⚠ TOOLING FAILED` banner before the aggregate (the `review`/`ci`
reviewer path uses `continue-on-error` so a tool's failure is summarized rather
than gating — distinct from `checks`/`test` run directly, which hard-gate). Shape:
`{"verdict":"clean"|"findings","summary":"…","findings":[{subsystem,file,line,severity,confidence,issue,fix,evidence}…]}`
(≤ 6, already verified against the checkout). Use the **`work_review`** tool to
extract it instead of regexing by hand.

## The triage loop (operate review on the work)

1. **Run** `work run ci` (or `review`, or one `<x>-review`) — tee to a log.
2. **Parse** the verdict with `work_review <logfile>` (or extract the sentinel block).
3. **Triage like a maintainer**: independently confirm each finding in the code,
   then either **fix it** (+ regression test) or **reject it** by appending a
   specific entry to `.review/accepted.md` (the suppression channel so a settled
   question doesn't resurface). Never silently ignore.
4. **Iterate** to `"verdict":"clean"` — reviewers carry no quota, so clean is real.
5. Reviewer prompts live in `.workflows/prompts/review-*.md` (versioned; edit to tune).

## Authoring & scaffolding

- Syntax is GitHub-Actions-like: `name`, `on` (`workflow_call` reusable, `webhook`
  trigger), `jobs.<id>.{runs-on, needs, machine, outputs, steps}`; steps are
  `run:` XOR `uses:`. Canonical ref: `docs-site/reference/workflow-syntax.md`;
  live examples: `test/e2e/`. Authoring cheatsheet:
  [references/authoring.md](references/authoring.md).
- `runs-on: gondolin` (stock, default) or `work:base` (git/jq/curl — for `npm ci`
  jobs); custom variants via `.workflows/images/<name>/build-config.json`.
- `machine:` — small 2G / **medium 8G (default)** / large 12G / xlarge 24G. Don't
  lower the default casually (knip's oxc parser reserves ~6 GiB).
- Agent steps: `uses: work/agent` + `with: { prompt | promptFile, model? }` — a real
  Pi agent in-guest, full toolset over the checkout, final message = step output.
- Scaffold with `work create <name> --template hello-world|agent-action`, then
  `work graph <name> --steps` to verify compilation before the first real run.

## When something's wrong

- Run does nothing / ignores edits → `dist/` exists. `rm -rf dist`.
- "QEMU"/boot errors → `work doctor`.
- Agent/review step fails with auth/egress → check `work.json` has a `defaultModel`
  and the `$VAR` is exported; the key is injected host-side (never in-guest).
- Interrupted mid-run → `work runs` for the id, `work resume <id>`.
- Need the structure without running → `work graph <name> --steps` / `--format json`.
