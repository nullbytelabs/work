# Agent Steps & Actions

The agent surface is the dumb **`work/agent`** primitive: `uses: work/agent` runs a real [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding agent **inside the job's micro-VM**, rooted at the checkout with its full toolset. Its final message becomes the step output. Richer, reusable behavior lives one layer up in **user-space actions**.

## The `work/agent` Primitive

```yaml
jobs:
  review:
    runs-on: work:base
    steps:
      - id: summary
        uses: work/agent
        with:
          prompt: You are a code reviewer. Review main.ts and summarize it in one sentence.
      - run: echo "review -> ${{ steps.summary.outputs.output }}"
```

The agent is prompted entirely through `with:`:
- `prompt` (inline) or `promptFile` (a file in the checkout, validated against symlink-escape)
- `model` (alias resolved against config; defaults to `defaultModel`)
- No separate system-prompt input — Pi's own discovery (`.pi/` persona, `AGENTS.md`) supplies any standing role

The step's `output` is the agent's final assistant message. If `finishReason === "length"`, a truncation warning is emitted to stderr.

### How a `work/agent` Step Executes

`runWorkAgent()` (`src/agent/work-handler.ts`):
1. Resolves the prompt from `with:` — either inline `prompt:` or `promptFile:` (validated against symlink-escape via `realpath` containment).
2. Resolves the model alias → `{ model, provider }` from config.
3. Calls `selectRunner()` — injected runner wins (tests); otherwise `GuestPiRunner` constructed from the execution context.
4. Returns a `UsesResult` with `stdout` = final assistant message, `outputs.output` = same text, plus an optional `agent` telemetry block (model, provider, usage, setupMs, runMs).

## In-Guest Agent Execution (`GuestPiRunner`)

There is **no host-side runner** — every job is a gondolin sandbox, so the entire agent loop (model calls + tools) executes inside the VM. The host side only stages a request and reads back a result over a shared `/workspace` mount.

### Flow (`src/agent/guest-pi-runner.ts`)

1. Creates an **unguessable** staging dir (`.pi-agent-<random8>`) inside the shared mount — randomization defeats pre-planting by a hostile checkout.
2. Copies the standalone wrapper `guest-runner-script.mjs` with `COPYFILE_EXCL` (fails if a symlink already exists). Writes request JSON with flag `"wx"` (O_EXCL protection).
3. The request JSON carries `{ system?, prompt, cwd, model: { baseUrl, model, maxTokens?, temperature? }, keyEnv }` — **never the API key**.
4. Makes Pi loadable in-guest: first tries `linkPreinstalledPi()` (symlinks a globally-installed Pi from the `work:pi` guest image, skipping a ~30s npm install); falls back to `npm install` (hardened against hostile `.npmrc`).
5. `exec("node <wrapper> <req> <res>")` with env `NODE_EXTRA_CA_CERTS=/etc/gondolin/mitm/ca.crt` — so in-guest Node trusts Gondolin's MITM proxy.
6. Reads the result JSON back, **refusing to follow a symlink** at the result path (hostile). Cleans up staging files.

### The Guest Wrapper (`src/agent/guest-runner-script.mjs`)

A standalone `.mjs` that runs in a **separate Node process inside the guest VM**:
- Loads `@earendil-works/pi-coding-agent` from the guest's module path.
- Registers a custom OpenAI-compatible provider with the model config from the request.
- Reads the API key from `process.env[req.keyEnv]` — the placeholder that Gondolin swaps into the Authorization header host-side.
- Creates a Pi agent session with `cwd` = the workspace mount, runs `session.prompt(req.prompt)`, extracts the last assistant message text, and reads cumulative token usage from `session.getSessionStats()`.
- Writes result JSON `{ text, finishReason?, usage? }` or `{ error }`.

### The `work:pi` Image

The `work:pi` image (`src/images/image-builtin/pi/build-config.json`) is `work:base` with `@earendil-works/pi-coding-agent` globally pre-installed. Agent steps reuse the baked-in Pi, skipping the ~30s npm install on every run.

## Host-Side Key Injection & Egress

**Egress is open** — `allowedHosts: ["*"]` for every job. The deny-by-default wall on `run:`-only jobs was removed (it was theater — agent steps and checkout steps already got allow-all). Internal/private ranges stay blocked by gondolin's default.

**The load-bearing control is host-side header-swap key injection.** `makeAgentEgressResolver(config)` (`src/agent/egress.ts`, wired in `run.ts`) returns a callback that, for each step that `mightRunModel` (`work/agent` or any `action/*` which might wrap one):

1. Resolves the model → extracts `modelHostOf(baseUrl)` (refuses `*` wildcards — fail-closed).
2. Creates a secret entry: `{ [modelKeyEnv(host)]: { hosts: [host], value: model.apiKey } }`.
3. Multiple steps on the same host collapse to one entry; different providers get distinct host-scoped keys.

### Security Model

The real API key **never enters the guest**. Gondolin injects a placeholder under the per-host env-var name, and swaps that placeholder into the `Authorization` header **for that host only** — it blocks the key if sent elsewhere. A job calling two providers reads a different, host-correct key per step, each derived from the same deterministic `modelKeyEnv(host)` formula:

```
modelKeyEnv(host) → PI_WF_MODEL_KEY_<SLUG>_<HASH8>
```

Both the egress resolver and the in-guest runner compute the **same name independently** — no out-of-band coordination.

> **Before designing anything that touches sandbox networking, read `docs/egress-data-path.md`.** The headline invariant: guest DNS is synthetic and the host re-resolves the SNI hostname and dials from the engine process — the guest-dialed IP is ignored.

## The Action System

An **action** is a project-owned directory (`<workflow-dir>/actions/<name>/`) with an `action.yaml` manifest — the step-level reuse unit, analogous to a GitHub Actions local action.

### Action Types

| Kind | `runs.using` | How it runs |
|---|---|---|
| **JS action** | `node` | Runs an `index.mjs` in-guest via `runGuestNode()`. Env: `INPUT_<NAME>` for each input, `WORK_OUTPUT` for output capture. The action's code never runs on the host. |
| **Composite action** | `composite` | A step bundle — each inner step is a `run:` command, a `uses: work/agent`, or a `uses:` of another action. The whole action runs as the caller's single durable `uses:` checkpoint. |

### Composite Actions

A composite action can wrap `work/agent` to create a named, reusable agent:

```yaml
# .workflows/actions/review/action.yaml
name: review
inputs:
  prompt:
    type: string
    required: true
runs:
  using: composite
  steps:
    - id: agent
      uses: work/agent
      with:
        prompt: ${{ inputs.prompt }}
    - run: echo "review done"
outputs:
  result:
    value: ${{ steps.agent.outputs.output }}
```

Inner step outputs are stored by `step.id` and available to later steps via `${{ steps.<id>.outputs.<key> }}`. Agent telemetry from inner `work/agent` sub-steps is **bubbled up** via `mergeAgent()` — sums token usage across inner agent calls, keeps the first model — so a composite wrapping an agent still reports one `chat` span.

### Builtin Actions

The engine ships two builtin composite actions (`src/actions/builtin/`), reached via `work/<name>`:

| Action | What it does |
|---|---|
| `work/checkout` | Installs git via `apk`, trusts gondolin's MITM CA, resolves `owner/name` shorthand to GitHub HTTPS, shallow-clones, outputs `ref` and `sha`. |
| `work/install-node` | Downloads musl Node build, extracts into `/tmp/.work-node`, symlinks `node`/`npm`/`npx` into `/usr/local/bin` so later steps resolve the new version. Outputs `version`. |

Both run through the same `runAction()` path as user-space actions.

### Using Actions

```yaml
steps:
  - uses: work/checkout
    with:
      repository: owner/repo
  - uses: action/review           # user-space action from .workflows/actions/review/
    with:
      prompt: Review the changes
```

`uses:` routing by scheme:
- `work/<name>` → builtin actions + `work/agent` (dispatched by `createWorkHandler`)
- `action/<name>` → user-space actions (dispatched by `createActionUsesHandler`)

A composite action's inner `uses:` sub-steps route through a late-bound `SubUsesDispatch` dispatcher wired in `run.ts`.

## Packaging a Reusable Agent

To package a named, reusable agent, wrap `work/agent` in a composite action under `.workflows/actions/<name>/`. [`test/e2e/agent-project/`](../../test/e2e/agent-project/) is a complete, runnable example — a verification workflow and a `review.yaml` where a composite action reviews the source.

> The old engine-owned `agent/<name>` package format was removed — don't reintroduce it. See `docs/agent-primitive-and-actions.md`.

## Key Source References

| Area | Key files |
|---|---|
| Agent types & runner seam | `src/agent/index.ts` |
| `work/agent` handler | `src/agent/work-handler.ts` |
| In-guest Pi runner | `src/agent/guest-pi-runner.ts` |
| Guest wrapper script | `src/agent/guest-runner-script.mjs` |
| Egress & key injection | `src/agent/egress.ts` |
| Action loading | `src/actions/load.ts` |
| Action dispatch | `src/actions/uses-handler.ts` |
| JS action runner | `src/actions/guest-node.ts` |
| Composite action runner | `src/actions/composite.ts` |
| Builtin actions | `src/actions/builtin/checkout/action.yaml`, `src/actions/builtin/install-node/action.yaml` |
| `work:pi` image config | `src/images/image-builtin/pi/build-config.json` |
| Design record | `docs/agent-primitive-and-actions.md` |
| Egress data path | `docs/egress-data-path.md` |
| Pi-in-gondolin threat model | `docs/pi-in-gondolin.md` |
