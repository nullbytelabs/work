# TUI for live run output — Research + Direction

Research for a future, optional **terminal UI** that shows a workflow run as it
happens: each job's state (pending → running → success / failed / skipped),
updating live as parallel jobs progress, with step logs. Library facts verified
via npm + docs on 2026-05-31; sources at the bottom. **Status: research /
later-iteration polish — not built.**

## Where it plugs in (we're already set up for it)

The runtime already emits the event stream a presenter needs:
`onJobStart → onStepStart / onOutput / onStepEnd → onJobEnd` (see
`src/runtime/types.ts`), and the compiled `ExecutionPlan` carries the DAG
(`needs` + `jobOrder`). A TUI is purely a **presenter** over these events — no
engine changes required. The current CLI already implements the recommended
*non-TTY* behavior (buffer each job, flush as one block on `onJobEnd`), so a TUI
is strictly the interactive-terminal enhancement layered on top.

## What the mature tools actually do

| Tool | Live model | Notes |
|---|---|---|
| Turborepo | split-pane TUI: status **table** (spinner/✓/⨯/cache) + selected task's log pane | per-task buffered; CI → buffered-by-package grouped logs |
| Nx 21 | same: running-tasks panel + selected task logs (arrow/vim nav) | status list, not a graph |
| Dagger | the **only** one that draws a real DAG (git-log-graph style, columns=pipelines) | their own team calls it "cluttered… a lot to take in"; ambient, not readable |
| Bazel | single throttled progress bar (count + in-flight actions); detail out-of-band via Build Event Protocol | ~0.2s repaint |
| GitHub Actions / Buildkite | collapsible **log groups** (`::group::` / `---`/`+++`); render is the web UI | no live terminal DAG |
| Earthly / go-task / act | per-line **prefix** (`+target | …`) or raw streamed logs | interleaving is a known wart |

**Conclusions:**
- A live box-and-edge **DAG is overkill** — terminals reflow, edges get noisy, and the graph matters most *before* the run (inspection), not during it. Norm = a **status list keyed by job**.
- Two dominant live patterns: **sticky status block + scrollback** (Dagger/Bazel — pin running/failed rows at the bottom, completed logs scroll above), and **status table + view-one-task's-logs** (Turborepo/Nx).
- Interleaved-log fixes, in order of effort: per-line job-id prefix → buffer-and-flush per job on completion (**what we do now**) → per-task buffer with a selectable view → collapsible groups.
- **Non-TTY/CI:** every serious tool degrades to plain output (prefixed lines or buffered-grouped). Turborepo auto-switches to grouped-by-package in CI.
- **DAG visualization** lives in a **separate command** (Nx `nx graph` → browser/PNG/JSON). For terminals, the cheap pattern is **emit Mermaid or Graphviz DOT** and let an external/inline tool render it (Graph-Easy, mermaid-ascii) rather than building layout.

## Library landscape (Node / TS / ESM)

| Library | Latest (2026-05-31) | Fit | Verdict |
|---|---|---|---|
| **Ink** (React for terminals) | 7.0.5, active | in-place multi-row redraw, freeform layout, `<Static>` for streaming logs above a live region, **auto non-TTY/CI fallback**, ESM-only + typed | **Best for a snazzy live board** — cost: pulls React 19 + Yoga (heaviest); some helper pkgs (ink-table) stale |
| **listr2** | 10.2.1, active | purpose-built concurrent task list w/ spinners/status; **best automatic non-TTY fallback** (SimpleRenderer); light (5 deps), typed/ESM | Strong **runner-up** if a (nested) task-list shape suffices; it prefers to *own* execution, so we'd bridge our emitter → task promises |
| **log-update** (+ cli-spinners, picocolors) | 8.0.0, active | DIY in-place block redraw + `persist()` (same idea as Ink `<Static>`), lightest footprint | Lightest, most control, **most work** — must hand-roll layout, throttle, and the non-TTY branch |
| blessed / neo-blessed | dormant (2022–24) | powerful full-screen widgets but **no graceful non-TTY fallback**, CJS, no built-in types | Avoid for new ESM/TS |
| terminal-kit | 3.1.2 | capable but CJS, external `@types`, heavy, no auto non-TTY degrade | Overkill/awkward here |
| @clack/prompts | 1.5.0 | interactive prompts, not a concurrent status board | Wrong category |

## Direction for pi-workflows (when we get to it)

1. **Default (TTY):** a **sticky status block** — one row per job with a spinner,
   elapsed time, and state — rendered over native scrollback so finished step
   logs scroll above. Keep per-job buffering to avoid the interleave jumble.
2. **Non-TTY / CI:** auto-detect (`!process.stdout.isTTY` or `is-in-ci`) and fall
   back to today's **buffer-and-flush-per-job** output (optionally wrapped in
   `::group::` markers so GitHub/Buildkite viewers collapse them). We already do
   the core of this.
3. **Inspection, separate from the run:** a `pi-workflows graph <workflow.yaml>`
   command that emits the `needs` DAG as **Mermaid and/or Graphviz DOT** (and
   JSON). Cheap, and the graph is most useful pre-run. Inline ASCII (via
   mermaid-ascii/Graph-Easy) is best-effort only.
4. **Library choice:** **Ink** if we want the flexible live board (bridge our
   event hooks into a small store an Ink component subscribes to); **listr2** if
   a task-list shape is enough and we want the lightest path with the best
   built-in CI fallback. Either way, the live TUI is the TTY branch; the
   buffered/grouped output stays the non-TTY default.

Notably, **none** of the mature tools draw a live box-and-edge DAG except Dagger,
which hedges that it's ambient decoration — so the snazzy-but-readable target is a
**live status list**, with the real DAG reserved for a `--graph` inspection
command.

## Sources

- Ink: https://github.com/vadimdemedes/ink · render/interactivity: https://github.com/vadimdemedes/ink/blob/master/src/ink.tsx
- listr2 fallback: https://listr2.kilic.dev/renderer/fallback-condition.html · renderers: https://listr2.kilic.dev/renderer/renderer.html
- log-update: https://github.com/sindresorhus/log-update
- Turborepo TUI: https://deepwiki.com/vercel/turborepo/5.1-terminal-ui · https://turborepo.dev/blog/turbo-2-0 · CI buffering: https://www.codejam.info/2025/04/turborepo-buffer-logs-github-actions.html
- Nx 21 TUI: https://nx.dev/blog/nx-21-release · graph: https://nx.dev/docs/features/explore-graph
- Dagger TUI: https://dagger.io/blog/dagger-0-6-0/ · https://docs.dagger.io/features/visualization/
- Bazel UI / BEP: https://bazel.build/docs/user-manual · https://docs.bazel.build/versions/main/build-event-protocol.html
- GitHub Actions groups: https://octocat.dev/posts/Groups-and-formatting-in-GitHub-Actions · Buildkite: https://buildkite.com/docs/pipelines/configure/managing-log-output
- ASCII DAG: https://github.com/AlexanderGrooff/mermaid-ascii · https://github.com/scottvr/phart · npm registry (`npm view`) queried 2026-05-31
