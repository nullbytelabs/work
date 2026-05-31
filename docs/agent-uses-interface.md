# Agentic `uses:` Interface — Research + Design

> Design note for the agent-step authoring surface. The **problem framing and
> proposed schema are pi-workflows design decisions** (not yet implemented —
> Phase 1 recognizes `uses` and rejects it). Every claim about *what Pi can do*
> underneath is verified against the live Pi docs (SDK, Prompt Templates,
> Extensions, Skills, Custom Providers) and flagged `UNVERIFIED — needs
> confirmation` where the docs don't settle it. Companion reference for the Pi
> surface: [`pi-coding-agent-sdk.md`](pi-coding-agent-sdk.md). Date: 2026-05-31.

## 1. The problem: inline `uses: agent` leaks

The README's illustrative agent step puts the agent's entire definition at the
call site:

```yaml
- name: ai-review
  if: ${{ github.event_name == 'manual' }}
  uses: agent                          # generic "an agent runs here"
  with:
    model: litellm/claude-sonnet-4
    prompt: |
      Review the diff in /workspace for regressions and summarize risks.
    tools: [read, grep, bash]
```

This conflates four concerns that have different owners, change at different
rates, and want different review:

1. **Behavior** (`prompt`) — the most-iterated-on, most-security-sensitive
   artifact, scattered inline across every workflow file. Untestable as a unit,
   unversioned, un-reusable. Two workflows that both want "the review agent"
   copy-paste and drift.
2. **Capability** (`tools`) — an arbitrary list with no validation that the
   tools are coherent or safe for the `runs-on` target (`bash` on `runs-on:
   local` executes on the host).
3. **Ops/cost** (`model`) — a deployment knob that legitimately varies per
   environment, mixed into the same block as behavior.
4. **Everything Pi can actually do** (extensions, skills, thinking level,
   compaction, custom providers, context files) — has nowhere to live, so it
   either gets crammed into `with` (surface explosion) or is unreachable.

There is also **no identity**: you can't say "this is `review`, v2" and pin it,
so you can't roll an agent forward or back, diff two versions, or test one in
isolation. That is the "room for weird things."

## 2. The reframe: an agent is a named, versioned package

Model an agent the way GitHub Actions models a reusable action. `uses:
actions/checkout@v4` references a packaged unit with its own `action.yml`
declaring inputs/outputs and an implementation; the call site supplies only what
varies. By direct analogy:

```yaml
- name: ai-review
  if: ${{ github.event_name == 'manual' }}
  uses: agent/review@v2                # identity + version
  with:
    model: litellm/anthropic-sonnet-4-6  # ops override of the agent's default
    target: /workspace/packages/core      # a declared, typed input
```

The agent **package** owns behavior, capability, and Pi configuration. The step
owns identity, the model choice, and declared inputs. `prompt` and `tools` are
**gone from the call site** — that is the entire point.

## 3. Grammar: `uses: agent/<name>@<ref>`

The user floated two separators — `agent@review` or `agent/review`. **Decision:
use `agent/<name>@<ref>`.**

- In GitHub Actions, `@` already means *version ref* (`@v4`, `@<sha>`). Reusing
  it for the *name* (`agent@review`) inverts that learned meaning and leaves no
  room for a real version. Anyone with GHA muscle memory misreads it.
- `agent/<name>@<ref>` maps GHA's `owner/repo@ref` exactly: `agent` is the
  scheme/namespace ("this `uses` resolves to a Pi agent, not a container
  action"), `<name>` is the agent, `@<ref>` is an optional pin.

```
uses: agent/review              # latest resolvable `review`
uses: agent/review@v2           # semver / tag pin
uses: agent/review@9f3c1a2      # content-hash pin (lockfile-resolved)
```

`agent` as a reserved scheme keeps the door open for other schemes later
(`docker/…`, `wasm/…`, a marketplace namespace) without re-litigating syntax.

## 4. What Pi actually gives us (and what it doesn't)

**Critical finding: Pi has no native, single-name "agent" object** that bundles a
system prompt + tool allowlist + model + extensions + skills. Pi exposes those as
**separate resource types** discovered/loaded by `DefaultResourceLoader` and
passed to `createAgentSession()`. The `agent/<name>` package is therefore a
**pi-workflows composition** over Pi's primitives — we are inventing the bundle,
not surfacing a Pi feature. (Pi's closest packaging concept is *Pi Packages* —
npm packages exposing `prompts/`, skills, extensions via `package.json` —
adjacent prior art, but still per-resource, not a unified agent. Source: Prompt
Templates → Locations; SDK → Skills/Extensions.)

What that means concretely — each field of our manifest lowers onto a documented
Pi primitive:

| Agent-package concept | Pi primitive it compiles to | Source |
|---|---|---|
| standing persona / policy (`instructions`) | `DefaultResourceLoader({ systemPromptOverride: () => … })` | SDK → System Prompt |
| per-invocation task (`task` + inputs) | text passed to `session.prompt(text)` | SDK → Prompting |
| tool allowlist (`tools`) | `createAgentSession({ tools, excludeTools, noTools })` | SDK → Tools |
| model default (`model.default`) | `modelRegistry.find("litellm", id)` → `createAgentSession({ model })` | SDK → Model; sdk doc §5 |
| thinking level (`thinking`) | `createAgentSession({ thinkingLevel })` | SDK → Model |
| extensions (`extensions`) | `DefaultResourceLoader({ additionalExtensionPaths, extensionFactories })` | SDK → Extensions |
| skills (`skills`) | `DefaultResourceLoader({ skillsOverride })` / `.pi/skills`, `.agents/skills` | SDK → Skills |
| context files | `DefaultResourceLoader({ agentsFilesOverride })` / `AGENTS.md` | SDK → Context Files |
| custom provider wiring | extension `pi.registerProvider("litellm", …)` | sdk doc §5c; Custom Providers |

So an agent package is, operationally, a **serialized `CreateAgentSessionOptions`
+ `DefaultResourceLoader` config** with a name and a version. Nothing in the model
requires Pi to add anything — it's assembly of existing parts.

### 4a. The system-prompt vs task-prompt distinction (don't collapse them)

Pi has two separate behavior surfaces, and the old inline `prompt:` blurred them:

- **System prompt** (`systemPromptOverride`) — the agent's *standing* identity and
  policy ("You are a code reviewer. Flag regressions, never edit files, output a
  risk summary"). Same on every invocation. This is what makes `review` *be*
  `review`.
- **Prompt** (`session.prompt(text)`) — the *specific task* for this run ("Review
  the diff at `/workspace/packages/core`"). Varies per step; this is where
  `inputs` flow in.

The package should carry both: `instructions` (→ system prompt) and an optional
`task` template (→ the prompt text). Splitting them is most of the safety win —
the persona/policy is fixed and reviewable; only the task varies.

### 4b. Prompt-template interpolation caveat (verified, important)

Pi's file-based prompt templates use **positional** arguments only — `$1`, `$2`,
`$@`/`$ARGUMENTS`, `${@:N:L}` — not named variables. (Source: Prompt Templates →
Arguments.) Our manifest `inputs` are **named** (`target`, `severity`, …).
Therefore:

> **DECISION 2026-05-31:** the engine performs its **own named interpolation** of
> declared `inputs` into the `task` template and passes the finished string to
> `session.prompt(text)` with `expandPromptTemplates: false`. We do **not** rely
> on Pi's positional template expansion for agent inputs — it is order-fragile
> and can't validate names. Pi's `/`-command templates remain available for
> interactive use; they are simply not the input-binding mechanism here.

## 5. The agent package

Resolved as a directory, mirroring Pi's own `~/.pi/agent/{extensions,skills,
prompts}` and project `.pi/` layout:

```
.pi/agents/review/
  agent.yaml          # manifest: model default, tool allowlist, typed inputs/outputs
  instructions.md     # -> systemPromptOverride (standing persona/policy)
  task.md             # -> session.prompt() text; receives `inputs` (optional)
  extension.ts        # optional: pi.registerTool / pi.registerProvider / hooks
  skills/             # optional bundled skills (SKILL.md dirs)
```

### Manifest (`agent.yaml`) — the `action.yml` analog

```yaml
name: review
description: Reviews a diff for regressions and summarizes risk.
version: 2.1.0                      # semver; @ref pins resolve against this + hash

model:
  default: litellm/claude-sonnet-4  # overridable by the step's `with.model`
thinking: medium                    # off|minimal|low|medium|high|xhigh

tools: [read, grep, bash]           # the allowlist — owned by the agent
# excludeTools: [write]             # optional subtractive form

instructions: instructions.md       # or inline string
task: task.md                       # optional; omit for a pure system-prompt agent

inputs:                             # typed, validated like GHA action inputs
  target:
    description: Path to review
    type: string
    default: /workspace
    required: false
  severity:
    description: Minimum severity to report
    type: enum
    values: [low, medium, high]
    default: medium

outputs:                           # exposed as steps.<id>.outputs.<key>
  summary:
    description: Risk summary text

extensions: [extension.ts]          # optional
```

### The step shrinks to identity + variation

```yaml
- name: ai-review
  uses: agent/review@v2
  with:
    model: litellm/anthropic-sonnet-4-6   # well-known override
    thinking: high                         # well-known override
    target: /workspace/packages/core       # declared input (validated)
    severity: high                         # declared input (validated)
```

`with` now means exactly two things: a small fixed set of **well-known overrides**
(`model`, `thinking`) and **declared inputs**. Unknown keys are an error, not a
silent passthrough.

> **Escape hatch (discouraged, explicit).** A raw `prompt:`/`tools:` override at
> the call site can be permitted only behind an explicit opt-in
> (e.g. `uses: agent/inline`), so the safe path is the default and the unsafe one
> is conspicuous. The baseline posture is: behavior lives in the package.

## 6. Resolution, precedence, and pinning

`agent/<name>` resolves against an ordered search path (first match wins),
mirroring Pi's global-vs-project resource precedence:

1. **Project** — `<repo>/.pi/agents/<name>/`
2. **User** — `~/.pi/agent/agents/<name>/`  *(naming TBD; see open questions)*
3. **Built-in** — agents shipped inside the pi-workflows package, so
   `uses: agent/review` works with zero local files.

Project overrides user overrides built-in, so a repo can specialize a shipped
agent by dropping in `.pi/agents/review/`.

**Pinning.** `@v2` is human-authored (semver/tag against `version:`); a
**lockfile** records the resolved **content hash** of the agent directory for
reproducibility (so "v2" can't silently change underfoot). Support both: semver
for ergonomics, hash for determinism. *(Lockfile format UNVERIFIED — design
pending; content-hash-of-dir is the proposal.)*

## 7. Capability ∩ target: tools must agree with `runs-on`

An agent declaring `bash`/`write`/`edit` and running on `runs-on: local`
executes on the host with no isolation. The engine must compute:

```
effective_tools = agent.tools ∩ target.allowed_tools
```

and **error** when the agent requires a tool the target forbids, rather than
silently dropping it (a silently de-fanged agent is a correctness bug). Rough
target policy (refine against the Gondolin doc):

| Tool | `runs-on: local` | `runs-on: gondolin` |
|---|---|---|
| `read`, `grep`, `find`, `ls` | allow | allow |
| `edit`, `write` | warn / opt-in | allow (VM-isolated) |
| `bash` | deny by default | allow (VM-isolated, deny-by-default net) |

This makes Gondolin the natural home for any shell-capable agent and gives a
clear, early error instead of a surprising runtime footgun. (Target capabilities:
[`gondolin-secure-execution.md`](gondolin-secure-execution.md).)

## 8. Outputs

Declared `outputs:` let later steps read `${{ steps.ai-review.outputs.summary }}`,
consistent with the README's `outputs` row in the YAML→Absurd table. Population
options (pick one; lean to the structured tool):

- **Structured** — the engine injects a `customTool` (`emit_output(key, value)`)
  via `defineTool`, and the agent calls it. Deterministic, typed. (SDK → Custom
  Tools.)
- **Final-message** — capture the agent's last assistant message
  (`session.messages` after `prompt()` resolves) into a default `summary` output.
  Zero-config but unstructured.

Outputs become the step's cached return value — which is exactly the durable unit
Absurd memoizes (the agent step is the checkpoint boundary; there is no
mid-LLM-turn resume — sdk doc §8).

## 9. How it compiles (ties to the existing seams)

The work splits cleanly across the layers already in `src/`:

**Parse (`src/spec/parse.ts`) — syntax only.** Today `parseStep` stores
`uses: string` and rejects nothing structural. Add: parse `agent/<name>@<ref>`
into a structured `AgentRef { scheme: "agent"; name: string; ref?: string }`,
reject malformed refs, and require `with` to be a mapping. It cannot validate
inputs yet — the manifest isn't loaded at parse time.

**Compile (`src/compiler/`) — resolve + validate + lower.** Resolve the agent
directory via the §6 search path, load `agent.yaml`, then:
- type-check `with` against `inputs` (unknown key → error, missing required →
  error, defaults applied, enums enforced),
- apply well-known overrides (`model`, `thinking`),
- intersect `tools` with the target's allowed set (§7), error on conflict,
- emit a typed `AgentStep` into the `ExecutionPlan` (alongside today's run-step),
  carrying the resolved instructions, task+bound inputs, tools, model ref, and
  declared outputs.

**Runtime (`src/runtime/direct.ts`) — execute.** The branch that currently
returns *"uses steps are not supported in Phase 1"* instead builds a
`DefaultResourceLoader` (`systemPromptOverride` from instructions, `extensions`,
`skills`), resolves the model via `modelRegistry.find("litellm", id)`, calls
`createAgentSession({ model, thinkingLevel, tools, resourceLoader })`, runs
`await session.prompt(boundTask)`, collects outputs (§8), and `dispose()`s. Under
the future `AbsurdRuntime` the same call sits inside `ctx.step(...)` unchanged —
the agent step is the memoized unit.

`StepSpec.uses` can stay `string` on the wire; the structured `AgentRef` is a
parsed/compiled artifact. No change to the run-step path.

## 10. Open design questions

1. **User-scope directory name.** `~/.pi/agent/agents/<name>/` nests "agent"
   twice and collides conceptually with Pi's own `~/.pi/agent/`. Prefer a
   pi-workflows-owned dir (e.g. `~/.pi/workflows/agents/` or `~/.pi-wf/agents/`).
2. **Built-in agent set.** Which to ship (`review`, `triage`, `summarize`?) and
   where they live in the package tree (`agents/` beside `images/`?).
3. **Lockfile format + hash scope.** Whole-dir hash vs manifest-only; where the
   lock lives; how `@ref` resolution interacts with project-over-built-in.
4. **`inputs` type system depth.** Just `string|number|bool|enum`, or also
   `path` (with workspace-relative validation) and `secret` (routed through
   Gondolin's `createHttpHooks`, never interpolated into the prompt)?
5. **Outputs contract.** Structured `emit_output` tool vs final-message capture
   as the default; whether to support typed/multiple outputs in v1.
6. **Agent-inside-VM vs host.** Where the Pi process runs for `runs-on: gondolin`
   (host with tool I/O redirected, vs whole agent in-guest via RPC). Carries over
   from the SDK/Gondolin research; affects how `tools` and secrets are wired.
   *(UNVERIFIED — see sdk doc §8 and gondolin doc §5.)*
7. **Inline escape hatch.** Final call on whether `agent/inline` (raw
   `prompt`/`tools` at the call site) ships at all, and if so how loudly it warns.

## 11. Sources

- Pi SDK (ResourceLoader, system prompt, tools, model, skills, extensions,
  prompting): https://pi.dev/docs/latest/sdk
- Pi Prompt Templates (positional args, locations, loading rules):
  https://pi.dev/docs/latest/prompt-templates
- Pi Extensions (registerTool/registerProvider/commands/hooks):
  https://pi.dev/docs/latest/extensions
- Pi Skills: https://pi.dev/docs/latest/skills
- Pi Custom Providers / Custom Models (LiteLLM wiring):
  https://pi.dev/docs/latest/custom-provider · https://pi.dev/docs/latest/models
- Internal companions: [`pi-coding-agent-sdk.md`](pi-coding-agent-sdk.md) (Pi
  surface), [`gondolin-secure-execution.md`](gondolin-secure-execution.md)
  (target capabilities), [`absurd-durable-workflows.md`](absurd-durable-workflows.md)
  (step/outputs memoization), [`phase-1.md`](phase-1.md) (current `uses` status).
- GitHub Actions `uses:`/`action.yml` prior art (inputs/outputs/`@ref`):
  https://docs.github.com/actions/sharing-automations/creating-actions/metadata-syntax-for-github-actions
