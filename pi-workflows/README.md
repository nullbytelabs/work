# pi-workflows

A **GitHub-Actions-style workflow engine with durable execution**, built in TypeScript on three pillars:

| Pillar | Role | Reference |
|---|---|---|
| **Absurd** (`absurd-sdk`) | Durable execution backbone — turns a YAML workflow into checkpointed, crash-recoverable tasks/steps | [`docs/absurd-durable-workflows.md`](docs/absurd-durable-workflows.md) |
| **Gondolin** (`@earendil-works/gondolin`) | Secure execution target — runs a step's task inside a local micro-VM. Backs the `runs-on` concept | [`docs/gondolin-secure-execution.md`](docs/gondolin-secure-execution.md) |
| **Pi** (`@earendil-works/pi-coding-agent`) | Agent / model layer — when a step needs an agent, it calls Pi. Models are referenced through a single LiteLLM key | [`docs/pi-coding-agent-sdk.md`](docs/pi-coding-agent-sdk.md) |
| **PGMQ** (`pgmq` Postgres extension) | Message-transport layer at the edges of the Absurd graph — trigger ingress, runner-pool dispatch for `runs-on`, fan-out, results, signals, dead-letters | [`docs/pgmq-message-queues.md`](docs/pgmq-message-queues.md) |
| **PGLite** (`@electric-sql/pglite`) | Optional Postgres *provider* — WASM PG17.5 in-process. The embedded/dev/CI/single-tenant tier behind Absurd + PGMQ (server Postgres for production) | [`docs/pglite-wasm-postgres-database.md`](docs/pglite-wasm-postgres-database.md) |

> **Status:** design sketch. The three docs above are SDK research with API signatures verified against docs/source; items that couldn't be verified are flagged `UNVERIFIED` inline. This README is the architectural thesis tying them together.

---

## Thesis

We can run **GitHub-Actions-style workflows** (workflows → jobs → steps) with **durable execution in sandboxes**. A step's task can be a Linux command, a shell script, a program invocation, or an **agentic usage** that punts work into and out of a Pi agent. Workflows run sequentially, fan out in parallel, do matrix expansion, converge back in, depend on each other, and carry lightweight `if`/`when` conditionals — and every step is checkpointed so a crash resumes instead of restarting.

Three clean separations make this tractable:

1. **What to run** is a declarative YAML spec (jobs/steps/needs/matrix/if).
2. **How durably** is Absurd: each step becomes a memoized, crash-recoverable unit.
3. **Where** is the `runs-on` target: a Gondolin micro-VM (default, secure) or local (fast, less isolated).

And the **agent/model layer** (Pi) is uniform: one LiteLLM key fans out to every provider, so a step just names a model.

---

## Architecture at a glance

```
            ┌─────────────────────────────────────────────┐
            │  workflow.yaml  (jobs · steps · needs ·       │
            │                  matrix · if/when · runs-on)  │
            └───────────────────────┬─────────────────────-┘
                                     │  parse + validate
                                     ▼
            ┌─────────────────────────────────────────────┐
            │  Compiler:  YAML  ->  Absurd task graph       │
            │  job  -> child task     step -> ctx.step()    │
            │  needs -> spawn/await    matrix -> N children  │
            └───────────────────────┬─────────────────────-┘
                                     │
                                     ▼
            ┌─────────────────────────────────────────────┐
            │  Absurd runtime (Postgres-journaled)          │
            │  orchestrator queue  +  jobs queue            │
            │  durable: completed steps return cached JSON  │
            └───────────────────────┬─────────────────────-┘
                                     │  each step's task runs on a target
              ┌──────────────────────┴───────────────────────┐
              ▼                                                ▼
      ┌──────────────────┐                          ┌────────────────────┐
      │ ExecutionTarget   │                          │ ExecutionTarget     │
      │  = GondolinTarget │  runs-on: gondolin       │  = LocalTarget      │  runs-on: local
      │  (micro-VM)       │  (default, secure)       │  (host process)     │
      └─────────┬────────┘                          └──────────┬─────────┘
                │                                              │
                └──────────────────┬───────────────────────────┘
                                   ▼  (when a step is agentic)
                        ┌────────────────────────┐
                        │  Pi agent (createAgent  │
                        │  Session / RPC mode)    │
                        │  models via LiteLLM      │
                        │  (one key, many providers)│
                        └────────────────────────┘
```

---

## How the pieces map

### 1. YAML spec → Absurd (the compiler)

The engine parses a GHA-style YAML and compiles it to Absurd primitives. The key research finding: **Absurd has no built-in parallel/fan-out/matrix primitive** — concurrency comes from spawning child tasks and from worker concurrency. So the compiler is where GHA semantics get synthesized.

Mapping (full table in [`docs/absurd-durable-workflows.md`](docs/absurd-durable-workflows.md)):

| YAML concept | Absurd construct |
|---|---|
| a `job` | a registered **task** (child workflow), spawned by the orchestrator |
| a `step` | `ctx.step(name, fn)` — durable, memoized |
| `needs:` (job deps) | `spawn` children, then `await` their task results before spawning dependents |
| `matrix:` | the orchestrator **spawns N child tasks**, one per matrix combination, each with a deterministic unique name |
| fan-out / parallel | spawn many children **on a separate queue** from the parent |
| convergence / join | loop `ctx.awaitTaskResult()` over the spawned children |
| `if:` / `when:` | a plain conditional **inside a step**, gating whether the work runs |
| step `outputs` | the step's return value (cached JSON), read by later steps |
| retries / timeouts | Absurd step retry config |

Two hard constraints the compiler must respect (verified in Absurd source):

- **Code outside a step re-runs on every attempt.** All side effects and orchestration decisions must live *inside* steps. The compiler emits orchestration as steps, not as bare handler code.
- **`awaitTaskResult` deadlocks if the child is on the same queue as the parent.** This forces a **one-queue-per-tier** layout: an *orchestrator* queue that spawns jobs, and a *jobs* queue the children run on.

### 2. `runs-on` → ExecutionTarget (Gondolin vs local)

Every job declares `runs-on`. The engine resolves it to an `ExecutionTarget` — a small interface with two implementations (full code in [`docs/gondolin-secure-execution.md`](docs/gondolin-secure-execution.md)):

```typescript
interface ExecutionTarget {
  run(cmd: string, opts: { env?, cwd?, files?, signal? }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  dispose(): Promise<void>;
}
```

- `runs-on: gondolin` (**default**) → `GondolinTarget`: `VM.create()` → `vm.exec()` → `vm.close()`. Hardware-virtualized micro-VM (QEMU, minimal Alpine guest), deny-by-default networking, secrets injected only into outbound HTTP via `createHttpHooks({ secrets })` — the guest sees placeholders, never raw values. Boots in under a second; treat VMs as disposable.
- `runs-on: local` → `LocalTarget`: a plain host child process. Fast, no isolation — for trusted steps / local dev.

Engine gotchas surfaced by the research: **one exec at a time per VM**, so parallel jobs each get their **own VM**; the minimal Alpine image means language runtimes need a custom image; secrets must flow through `createHttpHooks`, not `env`; always `dispose()`.

### 3. Agentic steps → Pi, models → LiteLLM

When a step is agentic, the target runs a Pi agent. Pi exposes a clean SDK (`createAgentSession()` → `session.prompt()` → resolves on completion) and an RPC subprocess mode — the latter is the natural fit for running the agent **inside** a Gondolin VM with crash isolation.

The model-reference layer is the payoff for "one API key for several providers": register **one Pi custom provider** named `litellm` with `api: "openai-completions"`, `baseUrl` pointed at the LiteLLM proxy's `/v1`, and a single `apiKey`. Its `models[]` list mirrors the names in LiteLLM's `config.yaml`. A workflow step then just says `model: litellm/claude-sonnet-4` and the engine resolves it via `modelRegistry.find("litellm", "claude-sonnet-4")`. Full config (file-based and programmatic) in [`docs/pi-coding-agent-sdk.md`](docs/pi-coding-agent-sdk.md).

Pi's durability lives at the **session-tree** granularity (JSONL, branch/fork/label/checkpoint), which slots in below Absurd's step-level checkpointing — but note there is **no mid-LLM-turn suspend/resume**, so an agentic step is the durable unit, not a point inside one.

### 4. Dispatch & transport → PGMQ (optional, at the edges)

Absurd and PGMQ both live in Postgres but answer different questions — **Absurd remembers; PGMQ delivers.** Absurd owns durable execution state and step memoization; PGMQ provides SQS-style at-least-once message transport where the engine wants decoupling Absurd deliberately doesn't offer. PGMQ does **not** replace Absurd's internal task queues — it sits at the *edges* of the graph: a `wf_triggers` ingress queue feeding the dispatcher, per-`runs-on` runner queues (`runner_gondolin`, `runner_local`) that let a fleet of VM runners work-steal via `FOR UPDATE SKIP LOCKED` + visibility-timeout leases, a partitioned `wf_fanout` queue for fine-grained homogeneous work, and `wf_results` / `wf_signals` / `*_dlq` queues. The two compose cleanly because PGMQ's weakest guarantee (at-least-once delivery) is exactly covered by Absurd's strongest one (durable step memoization): a redelivered job whose step already completed returns the cached result instead of re-running. Full topology and rationale in [`docs/pgmq-message-queues.md`](docs/pgmq-message-queues.md).

---

## Illustrative workflow YAML

This is a sketch of the target authoring experience — the exact schema is TBD.

```yaml
name: build-and-review
on: [manual]

env:
  NODE_ENV: ci

jobs:
  build:
    runs-on: gondolin            # default secure micro-VM
    steps:
      - name: install
        run: npm ci
      - name: build
        run: npm run build
      - name: artifacts
        id: out
        run: echo "dist=./dist" >> "$OUTPUT"

  test:
    needs: build                 # depends on build
    runs-on: gondolin
    strategy:
      matrix:                    # fan-out: one child task per node version
        node: [20, 22, 24]
    steps:
      - name: test
        run: nvm use ${{ matrix.node }} && npm test

  review:
    needs: test                  # converge after all matrix legs
    runs-on: gondolin
    steps:
      - name: ai-review
        if: ${{ github.event_name == 'manual' }}   # lightweight conditional
        uses: agent                 # agentic step -> Pi
        with:
          model: litellm/claude-sonnet-4            # model ref via LiteLLM
          prompt: |
            Review the diff in /workspace for regressions and summarize risks.
          tools: [read, grep, bash]
```

How it compiles: `build`, `test`, `review` become Absurd child tasks on the jobs queue; the orchestrator enforces `needs` by awaiting results; the `matrix.node` expands into three `test` children with deterministic names; `if:` becomes a conditional inside the step; the `agent` step opens a Pi session pointed at LiteLLM, running inside the job's Gondolin VM.

---

## Suggested package layout

```
pi-workflows/
├── README.md                       ← this file (architecture / thesis)
├── docs/
│   ├── pi-coding-agent-sdk.md       ← Pi SDK reference (agent/model layer)
│   ├── absurd-durable-workflows.md  ← Absurd reference + YAML→Absurd mapping
│   ├── gondolin-secure-execution.md ← Gondolin reference + ExecutionTarget design
│   ├── pgmq-message-queues.md       ← PGMQ reference + dispatch/transport design
│   └── pglite-wasm-postgres-database.md ← PGLite reference + provider-tier fit
└── src/                             ← (future)
    ├── spec/        # YAML schema + parser + validation
    ├── compiler/    # spec -> Absurd task graph
    ├── runtime/     # Absurd worker wiring, queues
    ├── targets/     # ExecutionTarget: GondolinTarget, LocalTarget
    ├── agent/       # Pi wrapper: session/RPC, LiteLLM provider registration
    ├── queue/       # PGMQ wrappers: dispatcher, runner pool, results/signals
    └── core/        # the small functional library steps compose from
```

---

## Open design questions (carry-over from research)

1. **Matrix `max-parallel` / concurrency groups** — Absurd has no native cap; the compiler must throttle via queue/worker concurrency. *(UNVERIFIED in Absurd; prototype first.)*
2. **Inter-step replay determinism** — confirm Absurd's exact replay contract before relying on step ordering.
3. **Agent inside the VM vs host** — Pi's own Gondolin example runs Pi on the host and redirects only its tool I/O into the VM. For true isolation we likely want the whole agent process inside the guest via RPC mode. *(UNVERIFIED — needs confirmation.)*
4. **LiteLLM `compat` flags** — some OpenAI-compatible proxies need `supportsDeveloperRole:false` / `supportsReasoningEffort:false`. Test against the actual proxy.
5. **VM resource sizing** — explicit CPU/RAM/disk options in `VM.create` aren't documented; no full resource governance exists yet.
6. **Pi version/API stability** — pin and re-verify signatures.
```
