# Reusable Workflows — Research + Design

> Design note for **reusable workflows**: a workflow that calls another workflow
> as a unit (`staging.yaml` orchestrating `lint.yaml` + `build.yaml` +
> `deploy.yaml`), passing parameters via `with:` and consuming the callee's
> outputs. The GitHub-Actions prior art is verified against their docs; the
> mapping onto work' **flat, runtime-agnostic `ExecutionPlan`** is the
> design work here. Companion seams: [`durable-orchestrator.md`](durable-orchestrator.md)
> (durability model), [`agent-primitive-and-actions.md`](agent-primitive-and-actions.md) (the
> *step*-level `uses:` surface this deliberately does **not** touch). Date: 2026-06-06.
>
> **Status: implemented.** The core vertical shipped — spec (`uses:`/`with:`
> jobs + `on: workflow_call`), inlining by substitution (`src/compiler/reusable.ts`),
> and the CLI resolver (`resolveWorkflowRef` in `src/project.ts`). `with:` carries
> both compile-time and **runtime** (`needs.*`) values — the latter deferred and
> substituted into the callee's `inputs.*`, resolving at run (§8). Design points
> revised in implementation are flagged inline: the compiler takes an *injected*
> resolver (stays filesystem-pure, §7); the inlining namespace uses `__` not `::`
> (§14-Q2); runtime-valued inputs are supported, not deferred to "Strategy B"
> (§8, §14-Q3). Remote/cross-repo refs are reserved (§14-Q6).
>
> **Superseded — inlining is now by substitution, not a join node.** This doc was
> written around a synthesized *virtual join* node (`PlannedJob.virtual`) per call.
> That was replaced: a single-job callee now **collapses onto the call's id** (the
> call *is* the job) and a multi-job callee is spliced in with namespaced ids and
> **no join** — a downstream `needs:[C]` attaches to the callee's real leaves and
> `needs.C.outputs.*` is rewritten onto the producing job. There are no virtual
> nodes. The "join node" passages below (§§ "Synthesize a join", "Algorithm")
> describe the old shape; `src/compiler/reusable.ts` is the source of truth.

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

| Mechanism | `uses:` sits on a… | Pulls in… | work analog |
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

The caller reads results as `needs.<callerJob>.outputs.<x>`. On GitHub.com nesting
is now capped at **10 levels** (the older "4" survives only on GitHub Enterprise
Server), and a single file may reference at most **50** reusable workflows. We set
our own caps in §10 — the GHA numbers are reference points, not a contract we owe.

**The work decision falls out cleanly:** keep the two levels separate.
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
  it by the **existing `resolveInputs()`**. No new input machinery. Note this is a
  deliberate **superset** of GHA: `workflow_call` inputs there are
  `boolean|number|string` only (no `choice`/`options` — that's `workflow_dispatch`
  territory), whereas we reuse our richer `options`/`pattern` validation for free.
- **Outputs.** Today outputs are *job*-level only; there is no workflow-level
  output. A callee needs to publish a flat output surface to its caller. Two
  options:

  | Option | Shape | Trade |
  |---|---|---|
  | **(a) explicit** *(recommended)* | `on: { workflow_call: { outputs: { version: ${{ jobs.compile.outputs.version }} } } }` | GHA-parity; the callee curates exactly what it exposes; one new parse path. |
  | **(b) implicit union** | callee's outputs = union of all its jobs' `outputs:` | zero ceremony; but leaks every job output and collides on duplicate keys. |

  > **DECISION:** ship **(a)**, explicit only — no implicit union. The callee
  > should own its public surface, exactly as a job owns `outputs:` today. This is
  > GHA-confirmed: there is *no* implicit/union output behavior on GitHub — nothing
  > leaves a reusable workflow unless mapped under `workflow_call.outputs`. (b) has
  > no prior art, leaks every job output, and collides on duplicate keys; rejected.
  > The expanded `workflow_call` mapping form is where workflow-level `outputs:` lives.

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
| `env` | **no** | env stays per-workflow; no cross-boundary inheritance (§14-Q4) |
| `outputs` | **no** | outputs come *from* the callee, not declared here |

This matches GitHub's allow-list for reusable-workflow caller jobs almost exactly.
GHA's full list is `name, uses, with, secrets, strategy, needs, if, concurrency,
permissions` — `steps`/`runs-on`/`env` are simply *absent* from it (not forbidden
keywords so much as keys the call has no slot for), and GHA likewise does **not**
propagate caller `env` into a called workflow. We drop `secrets` (egress is
mediated, §9), `concurrency`, and `permissions` only because those are not engine
concepts today; if they land later they slot straight into this allow-list.

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
  (§7). Inputs that drive the callee's *own* compilation (its `matrix`/`if:`)
  must be compile-time; **runtime data still passes cleanly through `with:` →
  `inputs.*`** via deferred substitution (§8).

### Strategy B — runtime sub-run

A `uses:` job stays a single node; at runtime it calls `startRun()` on the
callee as a nested run, passing `with` (now concrete, post-`needs`) as inputs and
collecting its outputs.

- **Pro:** `with:` can carry **runtime** values (`needs.build.outputs.version`),
  because the sub-run is compiled *after* upstream jobs finish. Clean
  encapsulation — the callee never sees caller-side job names.
- **Con:** nests the runtime. At the time of writing, whole-workflow crash-resume
  was incomplete (it has since shipped — see
  [`durable-orchestrator.md`](durable-orchestrator.md)); nesting runs would
  compound resume complexity either way. `work graph` can't
  show the inner DAG without resolving + compiling the callee. Parallelism is
  coarser (the sub-run is one scheduling unit).

> **RECOMMENDATION:** ship **Strategy A**. It is the architecturally consistent
> move (the plan is flat and runtime-agnostic; matrix already flattens), and it
> makes every existing tool work for free. Runtime-valued inputs are supported on
> top of it via deferred substitution (§8): a `with:` value that references
> `needs.*` is left intact and substituted into the callee's `${{ inputs.* }}`,
> resolving at runtime. The only thing that genuinely *must* be compile-time is a
> value that drives the callee's **own** `matrix`/`if:`. Strategy B (a true
> sub-run) remains the escape hatch only if a future need can't be met by
> substitution.

## 7. How inlining works (Strategy A in detail)

> **As shipped (v1):** the algorithm below lives in `src/compiler/reusable.ts`
> (`inlineCall`), invoked from `compile()`. The compiler stays **filesystem-pure**:
> rather than reading callee files itself, it takes an injected
> `resolveWorkflow(ref, fromDir) → { spec, dir, file }` (`CompileOptions.resolveWorkflow`),
> exactly as `makeTarget`/`usesHandlers` are injected. The CLI supplies the real
> (synchronous) resolver (`resolveWorkflowRef` in `src/project.ts`); compiler tests
> inject an in-memory one — no temp files. Recursion state (`_chain`/`_depth`/`_fromDir`)
> rides alongside in `CompileOptions`.

When `compile()` hits a `uses:` job `C` referencing workflow `W`:

1. **Resolve** `W` via the injected resolver (`workflow/<name>` scans `fromDir`;
   `./path.yaml` resolves relative to the referencing file's dir). It returns the
   parsed spec plus the callee's dir and canonical file path (the cycle key).
2. **Assert opt-in** — `W` declares `on: workflow_call`, else a compile error.
3. **Bind inputs** — interpolate `C`'s `with:` against the *caller's*
   compile-time context (`inputs`/`matrix`/`event`); a `needs.*` reference is
   left intact and its input marked **deferred** (§8), while `steps.*` and a
   `needs.<job>` not in `C`'s `needs:` are rejected with a clear error. Then
   `resolveInputs(W.inputs, boundWith, deferred)` validates the rest
   (unknown/missing-required/option/pattern), passing deferred values through
   verbatim for substitution into the callee.
4. **Recursively compile** `W` with those inputs → a sub-`ExecutionPlan`.
5. **Namespace** every sub-job id off a `\w`-safe prefix: `C__<subjobId>`. (The
   join keeps the call's id — `C`, or `C::<cell>` for a matrix call — but sub-jobs
   use `__`, **not** matrix's `::`: a sub-job is referenced at runtime via
   `${{ needs.<id>… }}`, and `::` isn't valid in that grammar, whereas `__` is.
   See §14-Q2.) Rewrite all *intra-call* `needs` **and** every deferred
   `needs.<sibling>` reference inside steps/outputs/`if:` to the namespaced ids.
   Prefix titles for display (`deploy / compile`).
6. **Rewire the boundary:**
   - sub-DAG **roots** (no intra-call deps) inherit `C`'s `needs`;
   - downstream jobs that did `needs: [C]` must now depend on the sub-DAG
     **leaves** — handled by the join node below, which keeps id `C`.
7. **Synthesize a join node** with id `C` (the caller's original id), `needs` =
   the sub-DAG leaves **plus any job referenced by an output** (a curated mid-DAG
   output's producer may not be a leaf, yet must be in the join's needs context),
   and `outputs` = `W`'s declared `workflow_call.outputs` **syntactically rewritten**
   from `${{ jobs.<id>.outputs.<k> }}` (callee vocabulary) to
   `${{ needs.C__<id>.outputs.<k> }}`. This single node makes `needs.C.outputs.x`
   and `needs: [C]` resolve **unchanged** for everything downstream — the call is
   transparent.

The join node does no work (it only aggregates outputs), so it must **not boot a
VM**. That is the *one* runtime change this design needs:

> **DECISION:** add `virtual?: boolean` to `PlannedJob`. When set, the runtime
> (`runJobInTask`) **skips `makeTarget`/provision/dispose** and computes
> `outputs` from its `needs` context directly. A virtual job has `steps: []`.
> Everything else (the `needs` DAG walk, output threading, `if:` gating) already
> works on it as-is — `runJob` computes `outputs` from `job.outputs` regardless
> of step count. Small, contained, and arguably useful on its own (pure fan-in
> nodes).

**Env scope across the splice.** Each inlined sub-job's `env` must be layered from
the **callee's** workflow `env` (then the callee job's `env`), *not* the caller's —
env is per-workflow. This is GHA-parity (GitHub explicitly does not propagate caller
`env` into a called workflow) and falls out naturally from recursively compiling the
callee in step 4 with `mergeEnv` (`compile.ts`) seeded by the callee's own
workflow-level env. The compiler must not leak the caller's `env` into the spliced
jobs. (See the §14 decision on `env:`.)

Net effect: a 3-job callee invoked once becomes 3 real `PlannedJob`s + 1 virtual
join, all in the caller's flat map. `topoSort` orders them with everything else;
`work graph` renders the whole thing; the durable runtime runs them as normal
Absurd tasks.

## 8. Runtime data flow: runtime-valued `with:` inputs

A reusable call can be parameterized with a value known only at **runtime** — a
producer job's output — passed explicitly through `with:`, matching GitHub
Actions:

```yaml
build:
  uses: workflow/build          # exposes output `version`
deploy:
  needs: [build]                # required: the value's producer must be a need
  uses: workflow/deploy
  with:
    version: ${{ needs.build.outputs.version }}   # ✅ runtime value → callee's inputs.version
```

The callee declares `inputs: { version: { type: string } }` and references only
`${{ inputs.version }}`. It never reaches into a caller-side job, so it reads
cleanly and runs standalone (the input falls back to its default).

How it compiles, given the flat-plan model (inputs are otherwise bound at compile
time, where they drive matrix fan-out, `if:`, and interpolation):

- The compiler resolves the **compile-time** roots in a `with:` value
  (`inputs`/`matrix`/`event`) immediately, but leaves a `${{ needs.* }}`
  reference **intact** and marks that input *deferred*.
- Inside the callee, `${{ inputs.version }}` expands to the deferred expression
  `${{ needs.build.outputs.version }}` — a single substitution, not a literal.
- That expression then resolves at runtime through the callee's inherited
  `needs` (the call's `needs: [build]` flows onto the callee's root jobs, step
  6), exactly like any other `needs.*` reference.

Two guardrails keep it honest (`bindWith` in `reusable.ts`):

- a `needs.<job>` referenced in `with:` **must** be in the call's own `needs:`,
  or it can't resolve at runtime — the compiler rejects it with a clear error;
- `steps.*` is rejected outright — a `uses:` job has no steps of its own.

The split to keep in mind: pass **config** (which env, which target) and
**data** (a built version, captured tool output) both through `with:` →
`inputs.*`. The data simply happens to be a runtime expression. What you must
*not* do is have a reusable workflow read `${{ needs.<caller-job>.* }}` for a job
it never declared — that's the implicit, surprising coupling this design exists
to avoid. Declare an input; pass it at the call site.

> Compile-time-only contexts still apply where a value genuinely must be known at
> compile time: a `with:` value that drives the **callee's own** `matrix`, `if:`,
> or further nested input binding can't be a runtime expression (the callee is
> compiled before any job runs). Such uses still resolve only against
> `inputs`/`matrix`/`event`. Passing a runtime value into a plain `run:`/`env:`/
> step `with:` — the common case — works as shown above.

## 9. Secrets / egress

GitHub passes `secrets:` (or `secrets: inherit`). work doesn't carry
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
  compilation; revisiting one is a compile error (`A → B → A`). (Note `topoSort`
  already catches cycles in the *flattened* job DAG at `compile.ts:211`, but a
  reusable-call cycle must be caught **earlier**, during resolution — by the time
  it reaches `topoSort` it would already be an infinite expansion.)
- **Depth cap:** bound nesting to stop runaway expansion; exceeding it is a compile
  error naming the chain. Propose **10**, matching current GHA-cloud; since we
  inline eagerly the cap is a real runaway guard, not just etiquette (§14-Q7).
- **Fan-out interaction:** a `strategy.matrix` on a `uses:` job multiplies the
  whole inlined sub-DAG per cell. The join keeps the cell id `C::<cell>` (so
  downstream `needs: [C]` converges on every per-cell join); its sub-jobs hang off
  the `\w`-safe prefix `C__<cell>__<subjob>`. As shipped there **is** now a shared
  plan-size ceiling (`MAX_PLAN_JOBS` in `compile.ts`) enforced after all expansion,
  closing the old gap where matrix only checked for *zero* cells and nothing capped
  the maximum (§14-Q7).

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
`reusable.ts` (`inlineCall`) invoked from `compile()`'s second pass:
- resolve + opt-in-assert the callee **via the injected `resolveWorkflow`** (the
  compiler does no file I/O itself — the CLI's `resolveWorkflowRef` does, keeping
  `compile()` pure and unit-testable with an in-memory resolver),
- bind `with:` (defer runtime `needs.*`; reject `steps.*` and out-of-`needs`
  refs; §8) and `resolveInputs`,
- recursively `compile()`, namespace ids (`__`), rewrite `needs` **and deferred
  `needs.<sibling>` references in steps/outputs/`if:`**, synthesize the virtual
  join (§7),
- splice into the flat `jobs` map (with an id-collision guard) *before* `topoSort`.
  Pass 1's `expandJob` registers a `uses:` job's join leg ids so a downstream
  `needs: [C]` converges via `legsOf`. `compileLeg` stays as-is; the matrix leg
  loop was factored into a shared `matrixLegs` helper both paths call. A
  `MAX_PLAN_JOBS` ceiling guards runaway expansion.

**Runtime (`src/runtime/absurd/`).** One change: honor `PlannedJob.virtual` in
`runJobInTask` (skip stage/provision/steps; compute outputs from `needs`). The DAG
walk, output threading, and `if:` gating already handle the resulting nodes.

**Graph / TUI.** No changes — they render the flat plan. Inlined jobs and the
join show up automatically (the join is a natural fan-in node, shown as `0 steps`).

**`src/run.ts` / CLI / web.** `startRun` is unchanged (it consumes a compiled
plan; the plan is just bigger). The **CLI** passes `resolveWorkflowRef` +
`_fromDir`/`_chain` into `compile()`; the **web** server passes a resolver that
errors on any `uses:` job (reusable workflows aren't wired through `--web` yet).

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
    with:
      env: ${{ inputs.target }}                  # compile-time input
      version: ${{ needs.build.outputs.version }} # runtime input — deferred, resolves at run (§8)
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

## 14. Design decisions (resolved)

Each former open question, now decided. Rationale is grounded in the GHA prior art
(§2–§5) and the engine's actual seams (file:line refs verified against `main`).

**Q1 — Output declaration. DECIDED: explicit `workflow_call.outputs` only; no
implicit union.** GHA has no union behavior — nothing leaves a reusable workflow
unless mapped — and a callee owning its public surface mirrors how a job owns
`outputs:` today. The union form leaks every job output and collides on duplicate
keys for zero real benefit. (See §4.)

**Q2 — Id separator. DECIDED (revised in implementation): `__` for the inlining
namespace; `::` stays matrix-only.** The design first proposed reusing matrix's
`::`, but implementation surfaced a blocker: an inlined sub-job is *referenced at
runtime* by its siblings (`${{ needs.<sub>.outputs.* }}`, `if: needs.<sub>.result`),
and `::` is **not** valid in the `needs.<id>` expression/condition grammar (it
accepts `[\w-]` only — `expr.ts`, `condition.ts`). Matrix gets away with `::`
solely because a matrix leg's *outputs* are never referenced in an expression;
inlined jobs are. Rather than widen the shared expression language in three places
(risk across every condition/interpolation), sub-jobs use a `\w`-safe `__` prefix
(`C__<sub>`), which parses unchanged. The join still keeps the call's id (`C`, or
`C::<cell>` for a matrix call, since that id only appears as a `needs:` *array
entry*, never inside an expression). A matrix call composes as `C__<cell>__<sub>`.

**Q3 — Runtime-valued inputs (§8). DECIDED: support them via deferred
substitution, matching GHA.** An earlier iteration of this design shipped only
compile-time `with:` and told authors to route runtime data by having the callee
read `${{ needs.<caller-job>.* }}` directly — an implicit coupling where a
reusable workflow silently depended on a job in whoever called it. That violated
least-surprise and was wrong, regardless of how it was rationalized. The fix:
`with:` accepts a `needs.*` expression, the compiler defers it and substitutes it
into the callee's `${{ inputs.* }}`, and it resolves at runtime through the
inherited need (§8). The callee now references only `inputs.*` — self-contained
and runnable standalone. The only genuinely compile-time-bound case left is a
value that drives the callee's *own* `matrix`/`if:`. Strategy B (a true sub-run)
stays the escape hatch only if some future need can't be met by substitution.

**Q4 — `env:` across the boundary. DECIDED: forbid `env:` on a `uses:` job; env
stays per-workflow; no cross-boundary inheritance.** This is GHA-parity (GitHub
explicitly does not propagate caller `env` into a called workflow) and it's also the
*correct* inlining semantics: each spliced sub-job layers the **callee's** workflow
env via the existing `mergeEnv` (`compile.ts:74`), seeded by the callee file's own
`env`, never the caller's (§7 "Env scope"). No new machinery, no precedence puzzle.

**Q5 — Virtual-job generality. DECIDED: compiler-internal for v1.** `virtual?:
boolean` on `PlannedJob` (§7) is synthesized by the compiler, not user-authorable.
`needs` already expresses fan-in; a user-facing step-less output-only node is a niche
without a demanding use case yet. Keeping it internal minimizes the authoring surface
and lets us change the join representation freely. Promote it to a primitive only if
real demand appears.

**Q6 — Cross-repo reuse. DECIDED: reserve the grammar now, defer the implementation.**
Parse a `workflow@<repo>/<name>@<ref>`-shaped ref (GHA's analog is
`owner/repo/path@ref`) and fail with a clear "remote reuse not yet supported" error,
rather than letting the syntax mean something else later. Reserving now prevents a
breaking grammar change; the §3 scheme decision already left the room. Everything
about fetching/pinning/caching a remote callee is out of scope for v1.

**Q7 — Depth cap + plan-size guard. DECIDED: depth cap 10; add one shared
expanded-job-count ceiling.** Cap nesting at **10** (current GHA-cloud parity; since
we inline eagerly it's a genuine runaway guard). Separately, there is **no** maximum
on expanded jobs today — matrix only rejects *zero* cells (`compile.ts:162`) — so add
a single plan-size ceiling enforced after both matrix and reusable expansion, erroring
with the offending chain. This retroactively closes the existing matrix-explosion gap
too. Exact numeric limit (jobs-per-plan) is a tuning knob, not a design fork.

### Still genuinely open (tuning, not architecture)

- The numeric value of the plan-size ceiling (Q7) — pick once we have a sense of
  realistic plan sizes.
- Whether the depth-cap and cycle checks share one resolution-chain walk or stay
  separate passes (implementation detail).

## 15. Sources

- GitHub Actions — Reusing workflow configurations (caller-job allow-list,
  `on: workflow_call` inputs/outputs/secrets, 10-level nesting + 50-ref-per-file
  caps on GitHub.com, no implicit outputs, `secrets: inherit`, local vs `@ref`):
  https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations
- GitHub Actions — How-to: reuse workflows (matrix on a caller job; input types
  limited to boolean/number/string):
  https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows
- GitHub Actions — Contexts reference (`jobs.<id>.with.<input>` allows `github,
  needs, strategy, matrix, inputs, vars` — i.e. runtime `needs`, which §8 now
  matches via deferred substitution):
  https://docs.github.com/en/actions/reference/workflows-and-actions/contexts
- Internal seams: [`durable-orchestrator.md`](durable-orchestrator.md) (durability/orchestration),
  [`agent-primitive-and-actions.md`](agent-primitive-and-actions.md) (step-level `uses:`),
  `src/compiler/compile.ts` (`expandJob` matrix-flatten precedent, `topoSort`),
  `src/compiler/inputs.ts` (`resolveInputs`, reused for `with:`),
  `src/project.ts` (`findWorkflowByName`, checkout resolution),
  `src/runtime/absurd/runtime.ts` (DAG walk + output threading).
</content>
</invoke>
