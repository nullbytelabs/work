# The Agent Primitive + User-Space Actions — Research + Design

> Design note for a reframe of the agent surface: instead of the engine owning an
> **agent-shaped package format** (`agent/<name>` with a manifest, `instructions.md`,
> `task.md`, a `{{ }}` mini-language, and an outputs-JSON convention), ship one
> **dumb built-in primitive** — `uses: work/agent`, prompted entirely through
> `with:` — and let rich, bespoke behavior live in **user-space actions**
> (composite step-bundles and **JavaScript** actions). The agent stops being a
> first-class engine concept and becomes "the thing a user-owned action calls."
> This is the **step-level sibling** of [reusable workflows](reusable-workflows.md).
> It **replaces an earlier exploration** that proposed the engine *own* a rich
> agent-package format; §10 records that rejected alternative and why. GitHub's
> composite/JS-action prior art is verified against their docs. Date: 2026-06-06.

## 1. The problem: the engine owns an agent-shaped package format

The runtime is already clean. `AbsurdRuntime` dispatches a `uses: <scheme>/<…>`
step to a registered `UsesHandler` keyed by scheme and maps the result back; it
"imports none of the agent/Pi/config code" (`src/runtime/types.ts:78-83`). Agents
are *one* handler (`scheme: "agent"`), composed in at the CLI.

The weight is one layer up, in `src/agent/`. To author "a review agent," the
engine makes you adopt an **engine-defined package format**:

- a manifest schema (`agent.yaml`: `inputs`, `outputs`, `description`, …),
- two specially-named files (`instructions.md` → system prompt, `task.md` → task),
- an engine-owned templating mini-language (`{{ input }}` binding in `buildAgentPrompt`),
- an engine-owned outputs convention (single message, *or* declared-2+-and-JSON →
  structured, in `agentOutputs`).

That's a lot of **agent-specific surface the engine defines and must maintain** —
and it competes with, rather than reuses, the general composition mechanisms the
project is otherwise building toward (reusable workflows; a step-level action
unit). Every knob a real agent wants — pre/post-processing, looping, shaping
inputs from a previous step, parsing the model's output into structured
fields — either gets crammed into the manifest (surface explosion) or is
unreachable. The `agentOutputs` JSON-splitting rule is already a symptom: bespoke
output logic leaking into the engine because there's nowhere else for it to go.

Project memory already says **the core doesn't govern agent permissions** — agents
get the full toolset over their workspace, no restriction machinery in core. This
reframe extends that same instinct to *everything else about an agent*: the core
shouldn't own the agent's prompt format, input templating, or output parsing
either. Those are user concerns.

## 2. The reframe: a dumb primitive + user-space composition

GitHub Actions has **no "agent" concept at all.** It ships a tiny runtime and a
single reuse unit — the **action** — and everything rich is user/marketplace
space. Apply that here:

- **The engine ships one primitive:** `uses: work/agent`. It runs a Pi agent
  in-guest with exactly what you pass in `with:` (system, prompt, model, tools).
  No manifest, no special filenames, no templating language, no output convention.
  It is a thin wrapper over the runner the engine *already has* (`GuestPiRunner`).
- **Rich behavior is a user-space action.** "The review agent" becomes an action
  the *project* owns — a directory with its prompts as files and, when it needs
  logic, **JavaScript** — that internally `uses: work/agent` and adds its own
  input-shaping / output-parsing / orchestration. The engine doesn't know what
  "review" is; the user composes it.

```yaml
# the dumb primitive, used directly (the simple inline case)
- uses: work/agent
  with:
    instructions: "You are a code reviewer. Flag regressions; never edit files."
    prompt: "Review the diff under /workspace and summarize the risks."
    model: anthropic/claude-sonnet-4-6
```

```yaml
# rich behavior, owned by the project as an action (the package case)
- uses: ./.workflows/actions/review     # a user-space action…
  with:
    target: packages/core               # …with its own typed inputs + JS
```

The "package" concern (versioning, testing, reuse, typed inputs/outputs) **moves
up one layer** — from an agent-specific format to a *general* action unit that is
useful for far more than agents. That is the entire trade.

## 3. Prior art: composite vs JavaScript actions

GitHub's `action.yml` `runs.using` selects the kind:

| Kind | `runs.using` | Body | Inputs ABI | Outputs ABI |
|---|---|---|---|---|
| **Composite** | `composite` | a list of `steps:` (`run`/`uses`) | `${{ inputs.x }}` | `${{ steps.y.outputs.z }}` mapped in `outputs:` |
| **JavaScript** | `node20` | `main: index.js` (+ `pre`/`post`) | `INPUT_<NAME>` env vars | `core.setOutput()` → appends to `$GITHUB_OUTPUT` |
| Docker | `docker` | a container | env | file |

Two facts make this a near-free fit for work:

1. **The JS-action output ABI is literally our `$WORK_OUTPUT`.** `core.setOutput`
   just appends `key=value` to `$GITHUB_OUTPUT`. We already implement that exact
   mechanism (and just landed an e2e for it). A JS action's outputs need **no new
   machinery** — it writes `$WORK_OUTPUT`.
2. **The JS-action execution model is what `GuestPiRunner` already does.** Stage
   files into the shared `/workspace` mount, `npm install` in-guest (native deps
   build for the guest), `exec("node …")`, read the result back
   (`guest-pi-runner.ts`). A JS action is the same dance with a user's script
   instead of the Pi wrapper.

We replace GitHub's Docker kind with our gondolin sandbox (every action runs
in-guest by construction), so there is no third kind to design.

## 4. The unified surface: one `uses:`, four resolutions

Combined with [reusable workflows](reusable-workflows.md), `uses:` becomes a
single keyword whose meaning is set by **level** and **scheme**:

| `uses:` value | Level | Resolves to | Status |
|---|---|---|---|
| `work/agent` (and future `work/*`) | step | **built-in engine primitive** | new — this doc |
| `./actions/review`, `action/<name>` | step | **user-space action** (composite or JS) | new — this doc |
| `agent/<name>` | step | legacy engine agent package | ships today; §10 |
| `workflow/<name>`, `./x.yaml` | **job** | reusable workflow | [its doc](reusable-workflows.md) |

> **DECISION:** `work/` is the reserved scheme for **engine built-ins** (the CLI is
> `work`); `work/agent` is the first. User actions resolve by **path**
> (`./actions/<name>`, relative to the workflow dir) or the `action/<name>` scheme
> (search `<workflowDir>/actions/<name>/`, mirroring how agents resolve from
> `<workflowDir>/agents/<name>/` today). This keeps built-ins, user actions,
> legacy agents, and reusable workflows legible at a glance.

## 5. `work/agent` — the dumb primitive (Phase 1)

A new `UsesHandler` with `scheme: "work"`, dispatching `work/agent`. It is almost
entirely the **existing** agent handler with the package-loading removed: no
`loadAgent`, no `buildAgentPrompt`, no `agentOutputs` — `with:` *is* the
`AgentRequest`.

`with:` surface (everything optional except a prompt source):

| Key | → | Notes |
|---|---|---|
| `instructions` | system prompt | inline string, or `instructionsFile:` to read from the workspace |
| `prompt` | task prompt | inline string, or `promptFile:` |
| `model` | resolved model | the existing `with.model` override; falls back to config default |
| `tools` / `excludeTools` | Pi tool set | **pass-through, unpoliced** (core doesn't govern agent permissions) |
| `thinking` | Pi thinking level | pass-through |

Outputs: the final assistant message becomes a single `output` (and `stdout`).
**No JSON-splitting convention** — if a caller wants structured fields, the agent
writes `$WORK_OUTPUT` itself (it has tools and the workspace), or a wrapping
action parses the message. The engine stops owning that.

Why this is nearly free: the runner (`GuestPiRunner`), the egress resolver
(`makeAgentEgressResolver`), the in-guest staging, and the model resolution all
exist. Phase 1 is "register a second handler that skips the package layer." It can
ship before actions exist and immediately makes the simple inline case first-class.

> **On the "inline prompt leaks" objection.** A fair worry (and the original
> motivation for an engine-owned agent package): putting prompts inline at the call
> site makes them scattered, unversioned, untestable. The answer here is **not**
> "inline is fine"
> — it's "the versioned, testable home for a prompt is a *user action*, not an
> engine-defined agent package." `work/agent` is the primitive an action wraps;
> the action supplies file-backed, reviewable prompts. The concern is real and is
> *answered by §6/§7*, not dismissed.

## 6. JavaScript actions — "keep the JavaScript" (Phase 2)

This is the direct home for "in the user workspace we'd keep the JavaScript and
enable bespoke behavior." A JS action is a user-owned directory:

```
.workflows/actions/review/
  action.yaml        # runs: node, main: index.mjs; typed inputs/outputs
  index.mjs          # arbitrary JS — shape inputs, call work/agent, parse output
  package.json       # optional deps (npm install'd in-guest)
```

```yaml
# action.yaml
name: review
inputs:
  target: { type: string, default: /workspace }
outputs:
  summary:    { description: one-line risk summary }
  severity:   { description: low | medium | high }
runs:
  using: node
  main: index.mjs
```

```js
// index.mjs — bespoke logic the engine never sees
import { appendFileSync, readFileSync } from "node:fs";
const target = process.env.INPUT_TARGET;                       // INPUT_<NAME> ABI
// …shape a prompt, shell out to the agent, parse the model's reply however you like…
const out = process.env.WORK_OUTPUT;
appendFileSync(out, `summary=${summary}\n`);                   // $WORK_OUTPUT ABI
appendFileSync(out, `severity=${severity}\n`);
```

**Execution** reuses `GuestPiRunner`'s mechanics almost verbatim, generalized into
a small `runGuestNode(dir, env)` helper: stage the action dir into the mount,
`npm install` in-guest if it has a `package.json`, `exec("node <main>")` with
`INPUT_*` env set from `with:` and `WORK_OUTPUT` pointed at a capture file, then
read outputs back through the **existing** `$WORK_OUTPUT` parser.

**ABI** (lifted straight from GitHub so it's learnable):

- inputs → `INPUT_<UPPERCASED_NAME>` env vars (validated against `action.yaml`
  `inputs:` by the **existing `resolveInputs`** — reused again, like reusable
  workflows reuse it for `with:`).
- outputs → `$WORK_OUTPUT` `key=value` lines, surfaced as `steps.<id>.outputs.*`.
- the agent is just a subprocess the JS calls (a tiny `work agent` shell entry, or
  the action `uses: work/agent` as a *sub-step* once composite actions land).

A JS action is implemented as a third `UsesHandler` (`scheme: "action"`, or the
path form), so — like `work/agent` — it slots into the runtime with **zero core
changes**. All the new code is one staging helper + the `action.yaml` loader.

## 7. Composite actions — step bundles (Phase 3)

The general step-level reuse unit: `runs.using: composite` with a `steps:` list
(each a `run:`, a `uses: work/agent`, a `uses:` of another action). It's the
**step-level sibling of reusable workflows** — same idea, one level down.

```yaml
# .workflows/actions/review/action.yaml
name: review
inputs:  { target: { type: string, default: /workspace } }
outputs: { summary: { value: ${{ steps.run.outputs.output }} } }
runs:
  using: composite
  steps:
    - run: git diff > /tmp/diff.txt          # shape input
    - id: run
      uses: work/agent                       # the dumb primitive
      with:
        instructionsFile: review.system.md
        prompt: "Review /tmp/diff.txt for regressions affecting ${{ inputs.target }}."
```

**Implementation fork** — exactly the §6 fork from the reusable-workflows doc, at
step granularity:

| Strategy | When the steps become real | Trade |
|---|---|---|
| **A: compile-time step-inlining** | `compile()` splices the action's steps into the calling job's step list, namespaced | runtime unchanged; inner steps get their own checkpoints + TUI rows; **but** `with:` binds at compile time — can't take a *previous step's runtime output* as an input |
| **B: runtime handler** *(leaning)* | an `ActionHandler` runs the action's steps at runtime via `ctx.exec` | preserves **runtime `with:`** (`with: { x: ${{ steps.prev.outputs.y }} }`) — the core already resolves `needs.*`/`steps.*` in a `uses` step's `with` before calling the handler (`runUsesStep`); cost: a mini step-runner inside the handler, and the action is one checkpoint, not N |

> **RECOMMENDATION:** lean **B (runtime handler)** for composite actions —
> step-to-step runtime data flow within a job is the common case and GitHub
> composite actions support it, so fidelity matters. The "mini step-runner" cost
> is mitigated by factoring the existing `runSteps` loop so the handler reuses it
> rather than re-implementing. (Reusable *workflows* lean the opposite way —
> inline — because they're parameterized by compile-time config, not mid-run data.
> The asymmetry is intentional and worth stating: GHA supports runtime `with:` at
> *both* levels, so leaning the runtime handler here keeps us **GHA-faithful** at
> the step level, whereas reusable-workflow inlining is a deliberate **divergence**
> from GHA — the one documented in that doc's §8. We match GHA where it's cheap and
> diverge only where matching would cost us the flat-plan architecture.)

Phase 3 is the largest piece and is optional: **Phases 1+2 already deliver the
user's ask** ("dumb `work/agent` + bespoke JS in user space"). Composite actions
are the clean generalization once that lands.

## 8. The extreme case: custom extensions, packaging, and remote actions

The sharpest test of the model: a user writes a **custom Pi extension** and wants
an agent that uses it. Two readings — and they turn out to be the **same thing at
two granularities**, not a fork.

**Reading A — primitive + supplied resources.** `work/agent` exposes Pi's resource
surface as *pass-through*: beyond `instructions`/`prompt`/`model` it accepts paths
to extensions, skills, and context files, stages them into the guest, and forwards
them to Pi's `DefaultResourceLoader`/`createAgentSession`. The core never
*interprets* a resource — it stages a path and hands it to Pi:

```yaml
- uses: work/agent
  with:
    instructionsFile: prompts/find-bugs.md
    extensions: [ext/find-bugs.ts]      # a custom Pi extension — your code
    skills: [skills/triage]
```

This is the literal "expose the primitive of injecting the Pi agent, let the user
supply resources." Flexible — but the call site re-states the whole composition
every time, and there's no identity: you can't say `find-bugs@v2`.

**Reading B — a named, versioned, distributable agent.** `myorg/find-bugs@v2`
bundles its prompt + extension + skills + model default behind a name, resolvable
locally or from a remote repo.

**The reconciliation: B is just A, packaged — and the package is an _action_, not a
new engine object.** A bespoke named agent is a (composite or JS) action whose
directory *contains* the extension `.ts`, the prompt files, and an `action.yaml`
with typed inputs/outputs, and which internally `uses: work/agent` supplying those
resources. The primitive is the substrate; the action is the box you draw around
one use of it to give it a name, a version, a test surface, and a distribution
channel.

So the engine grows **two general capabilities, neither agent-specific:**

1. `work/agent` accepts Pi resources as **pass-through paths** (extensions, skills,
   context files), staged into the guest and forwarded to Pi's loader. The in-guest
   wrapper's request protocol (`guest-runner-script.mjs`) gains resource paths
   alongside system/prompt/model — an additive change, not a new subsystem.
2. The action mechanism (§6/§7) gains **remote sourcing**: an action referenced as
   `owner/repo@ref` (or `owner/repo/sub@ref`) is fetched and resolved exactly like
   a local `./action`. This is uniform across *all* actions — that one wraps
   `work/agent` is invisible to the resolver.

The punchline for the question this doc keeps circling: **the engine has no concept
of "a bespoke agent."** It has the `work/agent` primitive and the action mechanism.
`myorg/find-bugs` is a **remote action that happens to wrap `work/agent`** — its
custom extension is a file inside it, passed to the primitive as a resource. We
never build agent-specific packaging, versioning, or distribution; agents ride the
general action rails. (Contrast the rejected alternative in §10, which gave agents
their *own* manifest with `extensions:`/`skills:` fields — that reinvents a worse,
agent-only action mechanism and binds the engine to track Pi's resource surface
forever.)

**Local↔remote and primitive↔package are independent axes** that compose into the
full matrix the question implies:

| | local | remote |
|---|---|---|
| **loose resources** | `work/agent` + paths in your repo | — (no name to fetch) |
| **packaged** | `./actions/find-bugs` | `myorg/find-bugs@v2` |

The bottom row *is* "a bespoke agent"; the top-left is the inline primitive; the
difference between the two bottom cells is **only the resolver**. That uniformity is
the whole reason to make agents ride actions rather than grow their own packaging.

**Security stays the boundary, not a vetting step.** A custom extension runs
**in-guest**, so it reaches the network only through the deny-by-default mediated
egress, and the model key is injected host-side for the configured model host only
(`makeAgentEgressResolver`). A bring-your-own extension that tries to egress
elsewhere simply has no route and no key. So "bring your own code" is safe *by
construction* — the sandbox vets it, the engine needn't (memory: core doesn't
govern agent permissions).

> **Caveat — custom *providers* are not clean pass-through.** Extensions, skills,
> and context files are just files to stage. A custom *provider* (an extension that
> `pi.registerProvider(...)` for a new model endpoint) introduces a **host** the
> egress allowlist and host-side key injection don't know about — today both are
> scoped to the configured model host. Supporting user providers therefore means
> extending the run's **egress/secret config**, not just staging a file. Treat
> extension/skill/context pass-through as the easy win and provider pass-through as
> a follow-on gated on egress config (open question §12.8).

### 8a. The `.pi/` folder: ambient resources you already get

There is a **third** provenance besides the explicit `with:` pass-through (Reading
A) and the packaged action (Reading B), and it is the most important one:
**Pi-native ambient discovery from the checkout.**

`work/agent` does not run a locked-down Pi — it runs Pi's own
`DefaultResourceLoader` **rooted at the checkout**. The shipped wrapper already
does exactly this (`guest-runner-script.mjs:87-94`):

```js
const resourceLoader = new pi.DefaultResourceLoader({
  cwd,                                   // the /workspace mount = the checkout
  agentDir: cwd,
  systemPromptOverride: () => req.system,
  extensionFactories: [ /* + the custom provider */ ],
});
await resourceLoader.reload();
```

So a `.pi/` folder committed in the workspace — hand-written skills, extensions,
`AGENTS.md` context — is **already discovered, for free.** The answer to "I've
already written my perfect review/triage skills, can `work` just use them?" is
**yes, ambiently** — not "refactor them into composite actions first." Forcing a
refactor would contradict the entire thesis: `work/agent` means *"run Pi here,"*
and *here already has `.pi/`.* That ambient discovery costs the engine nothing is
itself evidence the dumb-primitive reframe is right — the engine-owned
`agent/<name>` format would have had to *re-plumb* these resources through its
manifest; the primitive just doesn't suppress them.

The three provenances all feed the **same loader** and compose rather than compete:

| Provenance | Mechanism | Use it for |
|---|---|---|
| **Ambient** | `.pi/` in the checkout → `DefaultResourceLoader` discovers it | "I already have skills/extensions in this repo" — zero config |
| **Explicit** | `with: { extensions, skills, … }` staged + passed to the loader | resources *outside* the checkout; portability |
| **Packaged** | an action bundles its resources | distribution / versioning / sharing across repos |

Composite/JS actions (§6/§7) are for workflow-level **composition and
distribution** — *not* a mandatory re-housing of what Pi already understands.

Three properties make this clean, and one wrinkle to fix:

- **Scoped to project `.pi/`, by construction.** Only the checkout is staged into
  the guest, so discovery sees the in-repo, **checked-in, reproducible** `.pi/` —
  and naturally *not* the host's `~/.pi/` (which would break isolation and
  reproducibility, and isn't mounted). We get the good ambient discovery; the
  non-reproducible kind is excluded for free.
- **Reproducible-ish, but implicit.** Behavior depends on files not named in the
  workflow YAML. They're versioned in-repo so this is acceptable, but it warrants
  an explicit **opt-out** for a hermetic run (`with: { resources: none }`).
- **Precedence when layers combine** (ambient + explicit + packaged): the natural
  rule is **additive, with explicit/packaged layering over ambient** — mirroring
  env precedence (workflow < job < step).
- **Wrinkle — the system prompt is currently force-overridden.** The wrapper always
  sets `systemPromptOverride: () => req.system`. Under `work/agent`, make
  `instructions` **optional**: when omitted, pass *no* override so Pi's discovered
  system prompt / `AGENTS.md` stands. Only then is "just use what my `.pi/` already
  enables" fully true rather than "true except the persona." (Skills/extensions are
  separate resource types and already flow through ambient discovery untouched.)

> **VERIFY against Pi's loader docs:** the exact set `DefaultResourceLoader`
> auto-discovers from `cwd`/`agentDir` — skill directory names (`.pi/skills`,
> `.agents/skills`), whether extensions auto-load from a conventional dir or need
> explicit paths, and how `AGENTS.md` context injection interacts with
> `systemPromptOverride`. The wrapper *constructs the discovery loader rooted at
> the checkout* (confirmed in-tree); the precise discovered surface is a Pi
> behavior to pin down. (Open question §12.9.)

## 9. How it compiles (ties to existing seams)

- **Runtime (`src/runtime/`):** unchanged for Phases 1–2. `work/agent` and JS
  actions are new `UsesHandler`s registered at the composition root — exactly how
  the agent handler is wired today. Phase 3 composite actions either inline at
  compile time (A) or add one more handler that reuses a factored `runSteps` (B).
- **Agent layer (`src/agent/`):** factor `GuestPiRunner` into a reusable
  `runGuestNode(stageDir, argv, env)` mechanism (it already does stage→install→exec→read).
  `createWorkAgentHandler` is the existing `createAgentUsesHandler` minus
  `loadAgent`/`buildAgentPrompt`/`agentOutputs`.
- **New `src/actions/`:** `action.yaml` loader + the JS-action handler + (Phase 3)
  the composite runner. Resolution mirrors `src/agent/`'s `<workflowDir>/agents/`
  → `<workflowDir>/actions/`. Inputs validated by the **existing** `resolveInputs`.
- **Spec/compiler:** no change for handler-based kinds — `uses:` is already an
  opaque string the core dispatches by scheme. Compile-time composite inlining
  (Strategy A only) would touch the compiler, like reusable-workflow inlining.
- **Egress/security:** unchanged. `work/agent` uses the same
  `makeAgentEgressResolver`; the core polices no tools (memory: core doesn't
  govern agent permissions). A JS action runs in the same sandbox as a `run:`
  step with the same deny-by-default egress.

## 10. The rejected alternative, and what happens to `agent/<name>`

**Rejected alternative — an engine-owned agent package.** An earlier exploration
(now removed; see git history for `docs/agent-uses-interface.md`) proposed the
opposite of this doc: the *engine* defines a rich agent-package format — an
`agent.yaml` manifest with typed inputs/outputs, `tools`, `extensions`, `skills`,
an `@ref`/search-path resolver, and engine-enforced tool∩target. **Rejected**
because it reinvents a worse, *agent-only* version of the general action mechanism
(§6/§7), forces a package on the simple inline case, and binds the engine to track
Pi's entire resource surface forever. Its genuinely useful part — the verified
mapping of agent concepts onto Pi primitives (`DefaultResourceLoader`,
`createAgentSession`, the system-prompt-vs-task-prompt split) — lives on in
§5/§8/§8a here (and in the Pi SDK docs, https://pi.dev/docs). Recorded
so it isn't relitigated.

**What happens to today's `agent/<name>`.** This doc argues the richness belongs in
user space — so reconcile by **dogfooding**: reimplement today's `agent/<name>`
format as a **built-in composite action** over `work/agent`. The manifest/
`instructions.md`/`task.md`/`{{ }}`/outputs convention becomes one shipped action,
not core behavior.

| Option | Back-compat | Engine surface |
|---|---|---|
| **(a) reimplement `agent/<name>` as a built-in composite action** *(recommended)* | byte-for-byte | proves the action mechanism; deletes bespoke logic from core into a shipped action |
| (b) keep the `agent` handler, add `work/agent` beside it, deprecate slowly | full | two agent code paths to maintain during the deprecation |
| (c) hard cut to `work/agent` + actions | breaking | smallest core, but breaks existing `.workflows/agents/` |

> **RECOMMENDATION:** (a). It keeps every existing agent working, immediately
> validates composite actions against a real format, and lets `loadAgent`/
> `buildAgentPrompt`/`agentOutputs` move *out* of the engine and into a shipped
> action where they're just one possible convention — not the only one. Per
> project memory, agent steps must keep running real Pi and be verified against
> `demo.sh` + a real run, not just the suite: the reimplementation is validated
> the same way before the old path is removed.

## 11. Phasing

1. **`work/agent` primitive** — register the `work` scheme handler over the
   existing `GuestPiRunner`. Nearly free; makes the inline case first-class.
2. **JS actions** — `action.yaml` (`runs: node`) + `runGuestNode` + `INPUT_*`/
   `$WORK_OUTPUT` ABI. Delivers "bespoke JavaScript in user space." One handler.
3. **Composite actions** — `runs: composite` step bundles (Strategy B). The
   general reuse unit; reimplement `agent/<name>` on it (§10a).

Each phase is independently shippable and independently useful.

## 12. Open design questions

1. **Prompt sourcing in `work/agent`:** inline `instructions:`/`prompt:` only,
   `instructionsFile:`/`promptFile:` only, or both? (Files answer the "leak"
   objection without an engine package format.)
2. **JS-action runtime pin:** `runs: node` (use the guest's node) vs `node20`-style
   versioned `using` (would need guest images per version). Lean unversioned —
   the guest ships one node.
3. **The `work agent` sub-invocation from JS:** does a JS action reach the agent
   via a `work agent …` CLI shim in-guest, or only by being a *composite* step
   that `uses: work/agent`? (Affects whether JS actions are useful before Phase 3.)
4. **Composite strategy:** confirm runtime-handler (B) over compile-time inline
   (A); decide how much of `runSteps` to factor for reuse.
5. **Action resolution + pinning:** `./path` and `action/<name>` local for v1;
   **remote `owner/repo@ref` sourcing (§8) is part of the vision, not a maybe** —
   the question is *when* and how it's fetched/cached/pinned (parallels the
   reusable-workflow cross-repo question).
6. **`agent/<name>` removal timeline:** ship (10a) reimplementation first; when (if
   ever) to drop the legacy handler.
7. **Outputs from `work/agent`:** single `output` only, or also a documented
   "agent writes `$WORK_OUTPUT`" path for structured results (replacing the
   `agentOutputs` JSON convention)?
8. **Resource pass-through scope (§8):** which Pi resources does `work/agent` accept
   as staged paths — `extensions`/`skills`/`context` (clean, just files) — and how
   far to go with **custom providers**, which need egress/secret config extended
   for a new model host, not just a staged file?
9. **Ambient `.pi/` discovery (§8a):** make `instructions` optional so an omitted
   prompt leaves Pi's discovered system prompt/`AGENTS.md` intact; pin the exact
   `DefaultResourceLoader` discovery surface against Pi docs; decide the
   `resources: none` hermetic opt-out and the ambient/explicit/packaged precedence
   rule.

## 13. Sources

- GitHub Actions — Composite actions (`runs.using: composite`, `steps`, inputs/outputs):
  https://docs.github.com/actions/sharing-automations/creating-actions/creating-a-composite-action
- GitHub Actions — JavaScript actions (`runs.using: node20`, `main`/`pre`/`post`,
  `INPUT_*`, `core.setOutput` → `$GITHUB_OUTPUT`):
  https://docs.github.com/actions/sharing-automations/creating-actions/creating-a-javascript-action
- GitHub Actions — Metadata syntax (`action.yml` inputs/outputs/runs):
  https://docs.github.com/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions
- Internal seams: `src/runtime/types.ts` (the agent-agnostic `UsesHandler`
  contract), `src/agent/index.ts` (`loadAgent`/`buildAgentPrompt`/`agentOutputs`
  — the engine-owned format this reframe dissolves), `src/agent/guest-pi-runner.ts`
  (the stage→install→exec→read mechanics JS actions reuse),
  `src/agent/uses-handler.ts` (the handler `work/agent` slims down from),
  `src/compiler/inputs.ts` (`resolveInputs`, reused for action inputs).
- Companions: [`reusable-workflows.md`](reusable-workflows.md) (the job-level
  sibling), the Pi SDK docs (https://pi.dev/docs — the Pi resource/
  session surface `work/agent` lowers onto), [`pi-in-gondolin.md`](pi-in-gondolin.md)
  (in-guest Pi execution).
</content>
