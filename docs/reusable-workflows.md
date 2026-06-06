# Reusable Workflows — Research + Design

> Design note for **reusable workflows**: a workflow that calls another workflow
> as a unit (`staging.yaml` orchestrating `lint.yaml` + `build.yaml` +
> `deploy.yaml`), passing parameters via `with:` and consuming the callee's
> outputs. The GitHub-Actions prior art is verified against their docs; the
> mapping onto pi-workflows' **flat, runtime-agnostic `ExecutionPlan`** is the
> design work here. Companion seams: [`phase-1.md`](phase-1.md) (durability
> caveat), [`agent-primitive-and-actions.md`](agent-primitive-and-actions.md) (the
> *step*-level `uses:` surface this deliberately does **not** touch). Date: 2026-06-06.

## 1. The problem

Today a pipeline is one file. A team that wants a shared `lint` or `build`
sequence across `ci.yaml`, `staging.yaml`, and `release.yaml` has exactly one
tool: copy-paste. The jobs drift, a fix lands in one file and not the others, and
there's no way to say "staging is lint + build + deploy" as composition rather
than duplication.

What's wanted is the obvious thing: a `staging.yaml` that **references** smaller
workflows, hands each one inputs, and wires their outputs together — the same way
`needs:` wires jobs today, one level up.

## 2. The reframe: GitHub has *two* `uses:` mechanisms, at different levels

People conflate these. They are distinct, and the distinction is the whole design:

| Mechanism | `uses:` sits on a… | Pulls in… | pi-workflows analog |
|---|---|---|---|
| **Composite action** | **step** | a bundle of *steps* | `uses: agent/<name>` (already shipped) |
| **Reusable workflow** | **job** | an entire *workflow* (its jobs) | **this doc** — `uses: workflow/<name>` |

A reusable-workflow caller job is unusual: it has **no `steps:` of its own** — it
delegates the whole called workflow.

```yaml
# GitHub: caller
jobs:
  build:
    uses: ./.github/workflows/build.yml   # a whole workflow file
    with: { target: staging }             # inputs
    secrets: { token: ${{ secrets.TOK }} } # secrets, passed explicitly
```

The callee opts in and declares its contract via a dedicated trigger:

```yaml
# GitHub: callee (build.yml)
on:
  workflow_call:
    inputs:  { target: { type: string, required: true } }
    outputs: { version: { value: ${{ jobs.compile.outputs.version }} } }
    secrets: { token: { required: true } }
```

The caller reads results as `needs.<callerJob>.outputs.<x>`. Nesting is capped at
4 levels.

**The pi-workflows decision falls out cleanly:** keep the two levels separate.
Step-level `uses:` stays the agent surface; **job-level `uses:` becomes the
reusable-workflow surface.** That is *clearer* than GitHub's single overloaded
keyword, because the level tells you which kind you're looking at.

## 3. Grammar: `uses:` on a job

A job is now **either** a `steps:` job **or** a `uses:` job — never both (mirrors
the step-level `run`-xor-`uses` rule the parser already enforces).

```yaml
jobs:
  lint:
    uses: workflow/lint            # by name — resolves .workflows/*.yaml whose name: is "lint"
  build:
    needs: [lint]
    uses: ./build.yaml             # by path — relative to the calling workflow's dir
    with:
      target: staging             # bound to the callee's declared inputs
  deploy:
    needs: [build]
    uses: workflow/deploy
    with:
      env: staging
```

Two reference forms:

| Form | Resolves to | Notes |
|---|---|---|
| `workflow/<name>` | the `.workflows/*.yaml` whose `name:` matches | Mirrors `run <name>` (`findWorkflowByName`) and the `agent/<name>` scheme. **Recommended.** |
| `./path.yaml`, `../x/y.yaml` | a file relative to the calling workflow's directory | For files outside `.workflows/`, or explicit pinning. |

> **DECISION:** `workflow/` is a reserved scheme, parallel to `agent/`. It can
> never collide with an agent ref because agents are step-level and workflows are
> job-level — but using a distinct scheme keeps the two legible side by side and
> leaves room for future schemes (`workflow@<repo>/...` for cross-repo reuse).

## 4. The callee's contract: `on: workflow_call`

A workflow is **not** callable unless it opts in — same philosophy as the
`on: webhook` gate ([workflow-syntax → triggers](../docs-site/reference/workflow-syntax.md#triggers)):
being reusable is a deliberate, reviewable property, not an accident of existing.

```yaml
name: build
on: workflow_call            # string shorthand — callable, inputs from the existing inputs: block
inputs:
  target: { type: string, required: true }
jobs:
  compile:
    steps: [ ... ]
    outputs: { version: ${{ steps.meta.outputs.version }} }
```

Two pieces of the contract:

- **Inputs.** We already have a typed, validated top-level `inputs:` block
  (`string|number|boolean`, `required`, `default`, `options`, `pattern`). A
  called workflow reuses it verbatim — `with:` on the caller is validated against
  it by the **existing `resolveInputs()`**. No new input machinery.
- **Outputs.** Today outputs are *job*-level only; there is no workflow-level
  output. A callee needs to publish a flat output surface to its caller. Two
  options:

  | Option | Shape | Trade |
  |---|---|---|
  | **(a) explicit** *(recommended)* | `on: { workflow_call: { outputs: { version: ${{ jobs.compile.outputs.version }} } } }` | GHA-parity; the callee curates exactly what it exposes; one new parse path. |
  | **(b) implicit union** | callee's outputs = union of all its jobs' `outputs:` | zero ceremony; but leaks every job output and collides on duplicate keys. |

  > **DECISION (proposed):** ship **(a)**. The callee should own its public
  > surface, exactly as a job owns `outputs:` today. The expanded `workflow_call`
  > mapping form is where workflow-level `outputs:` lives.

The expanded form mirrors `webhook`:

```yaml
on:
  workflow_call:
    outputs:
      version: ${{ jobs.compile.outputs.version }}
```

## 5. The caller job shape

| Key on a `uses:` job | Allowed? | Meaning |
|---|---|---|
| `uses` | **required** | the workflow reference |
| `with` | yes | inputs to the callee (validated against its `inputs:`) |
| `needs` | yes | caller-side DAG ordering |
| `if` / `when` | yes | guard the whole call |
| `strategy.matrix` | yes | fan the *call* out — one invocation per cell |
| `steps` | **no** | a `uses:` job delegates; it has no steps |
| `runs-on` / `machine` | **no** | sizing belongs to the callee's jobs |
| `env` | **no** (v1) | env layering across the boundary is deferred (§8) |
| `outputs` | **no** | outputs come *from* the callee, not declared here |

This matches GitHub's allow-list for reusable-workflow caller jobs almost exactly.

## 6. Two implementation strategies

This is the real fork. Both produce the same authoring surface; they differ in
*when* the callee becomes real.

### Strategy A — compile-time inlining (recommended)

`compile()` resolves the callee, binds `with:` → its inputs, **recursively
compiles it**, and **splices its jobs into the caller's flat job map** with
namespaced ids and rewired `needs`. The runtime never learns reusable workflows
exist — it still sees one `Record<string, PlannedJob>` over one `needs` DAG.

This is *exactly the pattern matrix already uses*: one spec job → many
`PlannedJob`s in the flat map (`expandJob` in `compile.ts`). Reusable workflows
are "one caller job → a sub-DAG of `PlannedJob`s." Same shape, larger unit.

- **Pro:** runtime, durability, parallelism, `work graph`, and the TUI board all
  work unchanged — they operate on the flattened DAG. Maximum reuse, minimum new
  surface.
- **Con:** namespacing + `needs`-rewiring + an output-join node to build
  (§7); and **inputs bind at compile time**, so a callee can't be parameterized
  by a *runtime* value (§8) — the central constraint.

### Strategy B — runtime sub-run

A `uses:` job stays a single node; at runtime it calls `startRun()` on the
callee as a nested run, passing `with` (now concrete, post-`needs`) as inputs and
collecting its outputs.

- **Pro:** `with:` can carry **runtime** values (`needs.build.outputs.version`),
  because the sub-run is compiled *after* upstream jobs finish. Clean
  encapsulation — the callee never sees caller-side job names.
- **Con:** nests the runtime. Whole-workflow crash-resume is *already* incomplete
  (cross-job orchestration lives in JS, not a durable task — see
  [`phase-1.md`](phase-1.md)); nesting runs compounds that. `work graph` can't
  show the inner DAG without resolving + compiling the callee. Parallelism is
  coarser (the sub-run is one scheduling unit).

> **RECOMMENDATION:** ship **Strategy A** for v1. It is the architecturally
> consistent move (the plan is deliberately flat and runtime-agnostic; matrix
> already flattens), and it makes every existing tool work for free. Its one real
> limitation — compile-time-only inputs — is acceptable for the dominant use case
> (callees parameterized by *which env / which target*, which is known up front),
> and §8 shows runtime **data flow** still works through the normal `needs` graph.
> Revisit Strategy B only if runtime-valued inputs become a hard requirement.

## 7. How inlining works (Strategy A in detail)

When `compile()` hits a `uses:` job `C` referencing workflow `W`:

1. **Resolve** `W` (`findWorkflowByName` for `workflow/<name>`, or a path resolve
   relative to the caller's `workflowDir`). Parse it.
2. **Assert opt-in** — `W` declares `on: workflow_call`, else a compile error.
3. **Bind inputs** — interpolate `C`'s `with:` against the *caller's* compile-time
   context (`inputs`/`matrix`/`event`), then `resolveInputs(W.inputs, boundWith)`.
   Unknown/missing-required/option/pattern errors surface here, reusing today's
   validator unchanged.
4. **Recursively compile** `W` with those inputs → a sub-`ExecutionPlan`.
5. **Namespace** every sub-job id with the caller's id: `C::<subjobId>` (the `::`
   convention matrix already uses, so ids stay path-safe for workdir naming; a
   sub-matrix leg becomes `C::<subjobId>::<cell>`). Rewrite all *intra-call*
   `needs` to the namespaced ids. Prefix titles for display (`deploy / compile`).
6. **Rewire the boundary:**
   - sub-DAG **roots** (no intra-call deps) inherit `C`'s `needs`;
   - downstream jobs that did `needs: [C]` must now depend on the sub-DAG
     **leaves** — handled by the join node below, which keeps id `C`.
7. **Synthesize a join node** with id `C` (the caller's original id), `needs` =
   the sub-DAG leaves, and `outputs` = `W`'s declared `workflow_call.outputs`
   (rewritten to reference the namespaced producing jobs). This single node makes
   `needs.C.outputs.x` and `needs: [C]` resolve **unchanged** for everything
   downstream — the call is transparent.

The join node does no work (it only aggregates outputs), so it must **not boot a
VM**. That is the *one* runtime change this design needs:

> **DECISION:** add `virtual?: boolean` to `PlannedJob`. When set, the runtime
> (`runJobInTask`) **skips `makeTarget`/provision/dispose** and computes
> `outputs` from its `needs` context directly. A virtual job has `steps: []`.
> Everything else (the `needs` DAG walk, output threading, `if:` gating) already
> works on it as-is — `runJob` computes `outputs` from `job.outputs` regardless
> of step count. Small, contained, and arguably useful on its own (pure fan-in
> nodes).

Net effect: a 3-job callee invoked once becomes 3 real `PlannedJob`s + 1 virtual
join, all in the caller's flat map. `topoSort` orders them with everything else;
`work graph` renders the whole thing; the durable runtime runs them as normal
Absurd tasks.

## 8. The crux: compile-time inputs vs runtime data flow

The one thing Strategy A *can't* do: parameterize a callee's **compilation** with
a value only known at **runtime**.

```yaml
build:
  uses: workflow/build
deploy:
  needs: [build]
  uses: workflow/deploy
  with:
    version: ${{ needs.build.outputs.version }}   # ❌ runtime value — NOT allowed as an input in v1
```

Inputs resolve at compile time (it's how the architecture binds them — they drive
matrix fan-out, `if:`, interpolation). A `needs.*`/`steps.*` value isn't known
then. So **`with:` may reference only compile-time contexts** (`inputs`,
`matrix`, `event`) — the compiler must reject `needs.*`/`steps.*` in `with:` with
a clear error pointing here.

This sounds worse than it is. **Runtime data still flows** — just through the
`needs` graph, not through inputs:

```yaml
build:  { uses: workflow/build }
deploy:
  needs: [build]                # deploy's sub-DAG roots inherit this need
  uses: workflow/deploy
```

Because deploy's root sub-jobs inherit `needs: [build]` (step 6), they can read
`${{ needs.build.outputs.version }}` **at runtime** like any other job. The cost:
the callee's authors reference a caller-side job name (`build`), which leaks the
composition — a mild encapsulation break. Passing *config* (which env, which
target — compile-time) goes through `with:`; passing *data* (a built version —
runtime) goes through `needs`. v1 documents this split explicitly.

> If clean runtime-valued **inputs** become a hard requirement, that is the
> trigger to adopt Strategy B (or a hybrid: inline by default, sub-run when
> `with:` carries a runtime expression).

## 9. Secrets / egress

GitHub passes `secrets:` (or `secrets: inherit`). pi-workflows doesn't carry
secrets in YAML at all — egress is **mediated**, keys injected host-side, never
in-guest (`makeAgentEgressResolver` + the datasource resolver, composed in
`startRun`). Those resolvers are **run-level**, derived from config.

**v1 consequence:** an inlined callee's jobs run inside the caller's single run,
so they **inherit the caller run's egress posture** automatically — there is no
per-call secret block to design, and nothing new can leak. A future refinement
(parallel to GitHub's explicit `secrets:`) would let a `uses:` job *narrow* the
egress scope handed to its callee; deny-by-default makes "inherit, optionally
narrow" the safe direction. Out of scope for v1.

## 10. Recursion, cycles, depth

- **Cycle detection:** track the chain of resolved callee file paths during
  compilation; revisiting one is a compile error (`A → B → A`).
- **Depth cap:** bound nesting (propose **5**, ≥ GitHub's 4) to stop runaway
  expansion; exceeding it is a compile error naming the chain.
- **Fan-out interaction:** a `strategy.matrix` on a `uses:` job multiplies the
  whole inlined sub-DAG per cell. The id scheme (`C::<cell>::<subjob>`) stays
  unique; worth a guard on total expanded job count so a matrix-of-callees can't
  explode the plan silently.

## 11. Project layout / checkout

`resolveWorkflowLayout` (`src/project.ts`) gives a workflow inside `.workflows/`
the **project root** as its checkout; a standalone file gets its own folder. For
a call, **all inlined jobs use the caller's `workspaceSource`** — they're one
logical pipeline over one checkout. `workflow/<name>` resolves within the same
`.workflows/`, so this is automatic. Cross-project / cross-repo reuse (a path
into another tree, a `@ref` pin) is explicitly **out of scope for v1**; the
scheme leaves room for it later.

## 12. How it compiles (ties to existing seams)

**Spec (`src/spec/`).** `JobSpec.steps` becomes optional; add `uses?: string` and
`with?: Record<string,unknown>` to `JobSpec`. `parseJob` enforces `steps`-xor-`uses`
(reusing the exact pattern `parseStep` uses for `run`-xor-`uses`), and rejects
`runs-on`/`machine`/`env`/`outputs` on a `uses:` job. Add `workflow_call?:
WorkflowCallSpec` to `OnSpec` (boolean shorthand + `{ outputs }` mapping),
validated like `webhook`. **No execution logic here** — syntax only.

**Compiler (`src/compiler/`).** The new work lives almost entirely in a new
`reusable.ts` invoked from `compile()` during the first/second pass:
- resolve + parse + opt-in-assert the callee,
- bind `with:` (reject runtime contexts; §8) and `resolveInputs`,
- recursively `compile()`, namespace ids, rewrite `needs`, synthesize the virtual
  join (§7),
- splice into the flat `jobs` map *before* `topoSort` (so ordering & cycle
  detection cover the inlined nodes for free).
  `expandJob`/matrix and `compileLeg` stay as-is; reusable expansion is a sibling
  expansion step, not a rewrite of them.

**Runtime (`src/runtime/absurd/`).** One change: honor `PlannedJob.virtual`
(skip `makeTarget`/provision; compute outputs from `needs`). The DAG walk, output
threading, and `if:` gating already handle the resulting nodes.

**Graph / TUI.** No changes — they render the flat plan. Inlined jobs and the
join show up automatically (the join is a natural fan-in node).

**`src/run.ts` / web.** No changes — `startRun` consumes a compiled plan; the plan
is just bigger.

## 13. Worked example

```yaml
# .workflows/staging.yaml
name: staging
inputs:
  target: { type: string, default: staging }
jobs:
  lint:
    uses: workflow/lint
  build:
    needs: [lint]
    uses: workflow/build
    with: { target: ${{ inputs.target }} }     # compile-time input — OK
  deploy:
    needs: [build]
    uses: workflow/deploy
    with: { env: ${{ inputs.target }} }
    # build's runtime version reaches deploy's jobs via needs, not with: (§8)
```

```yaml
# .workflows/build.yaml
name: build
on:
  workflow_call:
    outputs: { version: ${{ jobs.compile.outputs.version }} }
inputs:
  target: { type: string, required: true }
jobs:
  compile:
    machine: large
    steps:
      - id: meta
        run: echo "version=$(date +%s)" >> "$WORK_OUTPUT"
    outputs: { version: ${{ steps.meta.outputs.version }} }
```

After compile, the flat plan contains (ids illustrative):
`lint::<jobs…>`, a virtual `lint` join, `build::compile`, a virtual `build`
(outputs `{version}`), `deploy::<jobs…>`, a virtual `deploy` join — wired by one
`needs` DAG that `work graph` renders end to end.

## 14. Open design questions

1. **Output declaration:** ship explicit `workflow_call.outputs` (§4a) only, or
   also allow the implicit union as a shorthand?
2. **Id separator:** `C::<subjob>` reuses matrix's `::`. Nested calls/matrix
   produce `a::b::c` — readable enough, or do we want a distinct call separator?
3. **The `needs`-leak in §8:** accept that callee jobs reference caller-side job
   names for runtime data, or invest early in Strategy B / a hybrid to keep
   callees fully encapsulated?
4. **`env:` across the boundary:** v1 forbids `env:` on a `uses:` job. Do we want
   workflow-call env layering (callee jobs inherit caller env), and if so with
   what precedence?
5. **Virtual-job generality:** expose `virtual`/output-only jobs as an authoring
   primitive (pure fan-in nodes), or keep it compiler-internal?
6. **Cross-repo reuse:** reserve `workflow@<repo>/...` syntax now, or defer the
   whole remote story?
7. **Depth cap value** (proposed 5) and **expanded-job-count guard** for
   matrix-of-callees.

## 15. Sources

- GitHub Actions — Reusing workflows (`uses:` at job level, `on: workflow_call`,
  `with`/`secrets`/`outputs`, 4-level nesting cap):
  https://docs.github.com/actions/sharing-automations/reusing-workflows
- GitHub Actions — `workflow_call` event & `secrets: inherit`:
  https://docs.github.com/actions/using-workflows/events-that-trigger-workflows#workflow_call
- Internal seams: [`phase-1.md`](phase-1.md) (durability/orchestration caveat),
  [`agent-primitive-and-actions.md`](agent-primitive-and-actions.md) (step-level `uses:`),
  `src/compiler/compile.ts` (`expandJob` matrix-flatten precedent, `topoSort`),
  `src/compiler/inputs.ts` (`resolveInputs`, reused for `with:`),
  `src/project.ts` (`findWorkflowByName`, checkout resolution),
  `src/runtime/absurd/runtime.ts` (DAG walk + output threading).
</content>
</invoke>
