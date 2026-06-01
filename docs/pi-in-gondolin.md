# Running Pi Agent Steps Inside Gondolin

> Design note for moving agentic `uses: agent/<name>` execution off the host and
> **into the `runs-on` sandbox**. The **problem framing and proposed design are
> pi-workflows decisions**; every claim about what Pi or Gondolin can do
> underneath is grounded in the repo's existing research docs
> ([`pi-coding-agent-sdk.md`](pi-coding-agent-sdk.md),
> [`gondolin-secure-execution.md`](gondolin-secure-execution.md),
> [`gondolin-custom-images.md`](gondolin-custom-images.md)) and the live Pi/Gondolin
> sources, and flagged **UNVERIFIED — needs confirmation** where the sources don't
> settle it. Builds on the code-path trace recorded below. Date: 2026-05-31.
>
> Status: **research / design sketch — no code change.** This doc records the
> options and a recommendation; it does not implement anything.

---

## 1. The problem: the agent runs on the host, bypassing the sandbox

pi-workflows' entire isolation thesis is that **`runs-on: gondolin` is the
default and secure target** — a step's work executes inside a hardware-virtualized
micro-VM whose network and filesystem I/O is mediated by host code. Shell (`run`)
steps honor this. **Agent (`uses:`) steps do not.** They execute on the host
regardless of `runs-on`, which is precisely the threat the sandbox exists to
contain.

### 1a. The current code path (traced)

For a job, the runtime builds one `ExecutionTarget` from `runs-on` and provisions
it, then dispatches each step inside a durable `taskCtx.step(...)`
(`src/runtime/absurd/runtime.ts`, `runJobInTask`):

```ts
// src/runtime/absurd/runtime.ts  (runJobInTask, ~line 251)
const result = await taskCtx.step<StepResult>(step.name, async () => {
  if (step.uses !== undefined) {
    return runUsesStep(step, job, workdir, deps, exprCtx());   // ← no `target`
  }
  return runShellStep(step, job, target!, workdir, ctx, exprCtx()); // ← `target` passed
});
```

Note the asymmetry: `runShellStep` receives the `target` and calls
`target.run(command, …)` — so a shell step on `runs-on: gondolin` runs inside the
VM. `runUsesStep` (`src/runtime/absurd/runtime.ts`, ~line 329) has **no `target`
parameter at all**. It resolves the scheme to a registered handler and calls it:

```ts
// src/runtime/absurd/runtime.ts  (runUsesStep, ~line 359)
const res = await handler.run({
  uses, with: resolvedWith, workdir,
  projectDir: …, workflowDir: …,
  runsOn: job.runsOn,   // ← passed as metadata only
  emit,
});
```

`UsesContext.runsOn` is carried (`src/runtime/types.ts`) but the agent handler
ignores it. `createAgentUsesHandler` (`src/agent/uses-handler.ts`) defaults the
runner to `new PiAgentRunner()` and calls `runner.run({ system, prompt, model })`.
`PiAgentRunner` (`src/agent/pi-runner.ts`) dynamic-imports the Pi SDK and calls
`createAgentSession({ cwd: process.cwd(), noTools: "all", … })` / `session.prompt(…)`
**in the host Node process**. No VM, no `target.run`, no sandbox boundary.

### 1b. Why this breaks the security model

A `uses: agent` step is an LLM-driven loop. Today it runs host-side with:

- **the host filesystem** — anything the agent's tools touch is the real host FS
  (the current runner pins `noTools: "all"`, but the design intent is shell- and
  file-capable agents on `gondolin`, per
  [`agent-uses-interface.md`](agent-uses-interface.md) §7; the moment tools are
  enabled, `bash`/`write`/`edit` execute on the host);
- **the host network** — unmediated egress, no allowlist;
- **the host's secrets** — the model API key sits in the host process env, and any
  host-side tool the agent runs can read it.

This is the same footgun the project already calls out for `runs-on: local`
(`agent-uses-interface.md` §7: *"an agent declaring `bash`/`write`/`edit` and
running on `runs-on: local` executes on the host with no isolation"*) — except
here it happens **even when the author asked for `gondolin`**. The sandbox is
provisioned for the job and then bypassed for its agent step. It is recorded as
open question #6 in [`agent-uses-interface.md`](agent-uses-interface.md) (*"Agent
inside VM vs host"*) and the **UNVERIFIED** note in
[`gondolin-secure-execution.md`](gondolin-secure-execution.md) §5. This doc resolves
the direction.

### 1c. Goal

When `runs-on` is a sandbox (`gondolin` / `gondolin:<variant>`), the **entire Pi
agent loop — model calls and tool execution — must run inside the guest**, with
the model API reached only through Gondolin's mediated egress and the API key
never present in the guest. `runs-on: local` keeps the host-side runner (it has
already opted out of isolation).

---

## 2. What Pi gives us to work with

Pi can be driven three ways (verified — see
[`pi-coding-agent-sdk.md`](pi-coding-agent-sdk.md) §1, §10, and the live RPC
docs):

| Mode | How | Where it can run | Fit for in-guest |
|---|---|---|---|
| **SDK** (in-process) | `createAgentSession()` / `session.prompt()` | wherever the Node process runs | only if a Node host runs *inside* the guest |
| **Print / JSON** | `pi --mode json` (single-shot; reads piped stdin, emits structured JSON events) | subprocess | **strong** — one-shot per step |
| **RPC** | `pi --mode rpc` or `runRpcMode()` (JSONL over stdin/stdout, `id`-correlated request/response) | subprocess | **strong** — long-lived, multi-turn |

The CLI and SDK ship in the **same npm package** (`@earendil-works/pi-coding-agent`),
so installing the package in a guest image gives both the `pi` binary and the SDK.
[`pi-coding-agent-sdk.md`](pi-coding-agent-sdk.md) §1/§10 already states the
conclusion we build on: *"RPC mode is the right surface if you want process
isolation / language independence … which is also the natural fit when steps run
inside a Gondolin sandbox."* Relevant hermetic knobs: `PI_OFFLINE=1` / `--offline`
disables startup network ops; `PI_SKIP_VERSION_CHECK=1` skips the update probe
([`pi-coding-agent-sdk.md`](pi-coding-agent-sdk.md) §11).

The current `PiAgentRunner` already speaks Pi via the SDK; the work here is about
**where that process lives**, not re-integrating Pi.

## 3. What Gondolin gives us to work with

From [`gondolin-secure-execution.md`](gondolin-secure-execution.md) (verified) and
the live Gondolin docs:

- **Execution:** `vm.exec(["/bin/sh","-lc", cmd], { cwd, env, signal, stdout, stderr })`
  → `ExecResult`. This is exactly what `GondolinTarget.run` already wraps
  (`src/targets/gondolin.ts`). **One `exec` at a time per VM** — a long-running
  in-guest server blocks further `exec` on that VM, so a persistent Pi server and
  concurrent tool `exec`s can't share one VM trivially (see §4, Option A).
- **Filesystem boundary:** the job's host workdir is mounted read-write into the
  guest at `/workspace` via `RealFSProvider` (`src/targets/gondolin.ts`,
  `provision()`). **This is a shared filesystem** — files the host writes to the
  workdir appear in-guest under `/workspace` and vice versa. That is the cleanest
  channel for crossing inputs/outputs (§5).
- **Networking is deny-by-default.** Non-HTTP/TLS TCP is dropped; there is no raw
  NAT. HTTP/TLS egress is allowed only to an **allowlist** (`createHttpHooks({
  allowedHosts })`), with a host-side TLS MITM: the host injects a local CA at
  `/etc/gondolin/mitm/ca.crt` and guest init builds a merged trust bundle so
  standard tools trust the proxy. (Verified against the Gondolin security docs.)
- **Secret injection:** `createHttpHooks({ secrets: { NAME: { hosts, value } } })`
  puts only a **placeholder** in the guest env; the host substitutes the real
  value into the outbound `Authorization` header for allowlisted hosts only. The
  real secret **never enters the guest**. `GondolinTarget.provision()` already
  wires `allowedHosts` + `secrets` through `createHttpHooks` when configured.
- **Custom images:** the default Alpine guest is minimal (no Node). A guest image
  with `nodejs`/`npm` (and the Pi package) is a declarative build-config away — the
  Gondolin default config already lists `nodejs`, `npm`
  ([`gondolin-custom-images.md`](gondolin-custom-images.md) §1). Selected at boot
  via `sandbox.imagePath`, which the planned `gondolin:<variant>` mechanism already
  contemplates.

The pieces line up: a shared `/workspace`, an allowlistable HTTPS egress for the
model API, header-only secret injection for the key, and a CLI/SDK that runs as a
subprocess. The missing wiring is on the pi-workflows side.

---

## 4. Options

Three placements, in decreasing isolation. (a) and (b) both put the **whole agent
in-guest** and differ only in process lifetime; (c) is the host-side compromise,
included for honesty about tradeoffs.

### Option A — Long-lived Pi RPC server inside the guest

Boot a guest image with Node + Pi, start `pi --mode rpc` (or `runRpcMode()`) as a
**persistent in-guest process**, and have the host handler drive it over a
JSONL request/response channel.

- **Transport.** Two candidates, both **UNVERIFIED** as wired today:
  1. **Gondolin ingress** (`vm.enableIngress()`) exposes a guest server on a host
     loopback port — but ingress is documented as **HTTP** ingress, and Pi RPC is
     **JSONL over stdio**, not HTTP. Bridging would need an in-guest stdio↔HTTP
     shim. **UNVERIFIED** that this composes cleanly.
  2. **A single long-running `vm.exec`** holding the `pi --mode rpc` process, with
     the handler writing JSONL to its stdin and reading stdout. But Gondolin is
     **one-exec-at-a-time per VM**, and the agent's own tool calls (`bash`,
     `edit`) need to run in the same guest — they'd contend with the held exec.
     Resolving that likely needs Pi's tools to execute **within the RPC process**
     (in-guest, same VM) rather than as separate host-issued `exec`s — which is
     the natural shape anyway if the whole agent is in-guest. **UNVERIFIED**
     whether one held `exec` can carry bidirectional JSONL with live streaming via
     the current `GondolinTarget` surface (it wraps `exec` for buffered/`pipe`
     output, not interactive stdin).
- **Pros:** multi-turn sessions, steering/follow-up, Pi's streaming events, and
  session-tree durability all available; closest to Pi's "real" usage.
- **Cons:** most moving parts; needs a stdin-capable exec channel the current
  target abstraction doesn't expose; the one-exec-per-VM constraint forces either
  a second VM or in-process tools; lifecycle/cleanup of the in-guest server.
- **Verdict:** the right **eventual** shape for rich, multi-turn agents, but too
  much new surface for a first cut.

### Option B — One-shot Pi subprocess in-guest via `target.run` (recommended)

Treat an agent step like a shell step: build the final system+task prompt
host-side (already done by `buildAgentPrompt` in `src/agent/uses-handler.ts`),
then invoke Pi **once** inside the guest through the existing `ExecutionTarget.run`
seam — `pi --mode json` (single-shot, structured JSON events) or a thin in-guest
wrapper script that calls the SDK with `noTools`/tool config and prints a result.

```
host: build prompt + model config  ──▶  write to /workspace (shared mount)
                                         │
guest: target.run("pi --mode json …")    │  (or: node /workspace/.pi-run.mjs)
        ├─ Pi makes the model call ──────┼──▶ Gondolin HTTP mediation (allowlist + key inject)
        ├─ tools (bash/edit) run in-guest │
        └─ writes result/outputs ─────────┘
host: read result back from /workspace (shared mount)
```

- **Reuses the existing seam.** `GondolinTarget.run` already does
  `vm.exec(["/bin/sh","-lc", cmd], { env, onOutput })` with live streaming and
  exit codes — exactly what a one-shot `pi` invocation needs. No new transport.
- **Whole agent in-guest.** Model loop *and* tools execute inside the VM; the host
  only stages inputs and reads outputs.
- **Maps onto the agent step's existing durability.** An agent step is already the
  memoized `taskCtx.step` unit (there is **no mid-LLM-turn resume** —
  [`pi-coding-agent-sdk.md`](pi-coding-agent-sdk.md) §8), so one-shot-per-step
  loses nothing the engine relied on.
- **Cons:** one prompt per step (no in-step multi-turn steering); requires a
  Pi-equipped guest image (§3); Pi's stdout must be parsed for the final
  message/outputs (use `--mode json`, or the wrapper writes a JSON file). Abort =
  cancel the `exec` / `dispose()` the VM.
- **Verdict:** the **smallest viable path to real isolation** — it changes *where*
  the existing runner runs, not the agent contract. Recommended first.

### Option C — Host-side Pi, tool I/O redirected into the guest

The pattern in Gondolin's own `host/examples/pi-gondolin.ts`
([`gondolin-secure-execution.md`](gondolin-secure-execution.md) §5): Pi runs on the
host, but its `read`/`write`/`edit`/`bash` tools are overridden to execute via
`vm.exec` inside the VM.

- **Pros:** keeps the in-process SDK (events, multi-turn, session tree) with no
  custom image; the agent's *tool side effects* land in the sandbox.
- **Cons — does not solve the stated problem.** The **model loop and the API key
  remain host-side**; only tool execution is sandboxed. A compromised/role-confused
  agent still drives an unmediated host process and holds the host's network and
  key. The threat in §1b is the agent process itself, not only its shell tool — so
  this is a partial mitigation, not isolation.
- **Verdict:** rejected as the primary design (insufficient), but a reasonable
  fallback for `runs-on: gondolin` on a host that can't build a Pi image, **if**
  we decide a partial mitigation beats none — flag loudly that it is not full
  isolation.

| | A: in-guest RPC server | B: in-guest one-shot (rec.) | C: host Pi + guest tools |
|---|---|---|---|
| Model loop in sandbox | ✅ | ✅ | ❌ (host) |
| Tools in sandbox | ✅ | ✅ | ✅ |
| API key out of host process | ✅ (via §5) | ✅ (via §5) | ❌ |
| Multi-turn / steering in one step | ✅ | ❌ | ✅ |
| New transport surface needed | high | **none (reuses `run`)** | medium (tool overrides) |
| Needs Pi-equipped guest image | ✅ | ✅ | ❌ |
| Solves §1b | ✅ | ✅ | ✗ partial |

---

## 5. Cross-cutting mechanics (apply to A and B)

### 5a. Model API egress — the key synergy

Pi in-guest must reach the model endpoint (LiteLLM / any OpenAI-compatible base
URL) over HTTPS. Gondolin is deny-by-default, so the engine **allowlists the model
host** and **injects the key host-side**:

```ts
createHttpHooks({
  allowedHosts: ["litellm.internal.example.com"],        // the model base URL host
  secrets: {
    LITELLM_API_KEY: { hosts: ["litellm.internal.example.com"], value: realKey },
  },
});
```

The guest's `pi` sees only a placeholder env value; Gondolin swaps the real key
into the `Authorization` header for the allowlisted host only. This is **strictly
better than host-side execution**, where the key sits in the agent's own process
env. `GondolinTarget.provision()` already wires `allowedHosts`/`secrets` through
`createHttpHooks` — the agent path needs to populate them from the resolved model
config (`src/config`, `ResolvedModel { baseUrl, apiKey, model }`).

Caveats / **UNVERIFIED**:

- **TLS trust.** Gondolin MITMs TLS with a CA at `/etc/gondolin/mitm/ca.crt`. Node
  does **not** read the system trust store by default, so Pi's fetch/undici likely
  needs `NODE_EXTRA_CA_CERTS=/etc/gondolin/mitm/ca.crt` in the guest env.
  **UNVERIFIED — needs confirmation** that this makes Pi's model calls trust the
  proxy (the merged bundle covers `curl`/`ca-certificates`-aware tools; Node is the
  open question).
- **Localhost LiteLLM.** If the model proxy is a host-loopback service, Gondolin's
  `blockInternalRanges` (default on: 127/8, 10/8, …) will block it. A localhost
  proxy must be reached via **mapped TCP** (`tcp: { hosts }`, opt-in) — but mapped
  TCP **bypasses HTTP hooks and secret substitution**
  ([`gondolin-secure-execution.md`](gondolin-secure-execution.md) §4), losing the
  key-injection benefit. **Recommendation:** require the model endpoint to be a
  real (non-internal) HTTPS host for in-guest agents, or run the proxy off-host.
  **(Open question — §7.)**
- **Body substitution.** Secret substitution covers headers, not request bodies
  ([`gondolin-secure-execution.md`](gondolin-secure-execution.md) §3d) — fine,
  since the key rides in `Authorization`.

### 5b. Workspace, inputs, and the `with` block

Inputs are already resolved and interpolated **host-side** before the runner is
called: `runUsesStep` interpolates `${{ needs.* }}` / `${{ steps.* }}` in `with`
(`src/runtime/absurd/runtime.ts`), and `createAgentUsesHandler` binds them into the
agent's inputs and builds the prompt string (`src/agent/uses-handler.ts`,
`buildAgentPrompt`). So **what crosses the boundary is a finished prompt string +
model config**, not the agent package files. Channels:

- **Prompt + system + model:** write to the shared `/workspace` (e.g.
  `/workspace/.pi/agent-request.json`) and have the in-guest wrapper read it, or
  pass via `env`/argv to `pi`. Prefer a file on the shared mount to avoid leaking
  the prompt through process listings. The agent package's `instructions.md`/
  `task.md` stay host-side; only their rendered output crosses.
- **Workspace files** the agent reads/edits are already the job's `/workspace`
  mount — no extra work.

### 5c. Outputs across the boundary

Agent outputs today come from the runner's returned text, mapped by
`agentOutputs()` (`src/agent/index.ts`) to declared keys. In-guest, the wrapper
writes the result where the host can read it. Because `/workspace` is a **shared
`RealFSProvider` mount**, the host reads outputs straight from the job workdir —
no `vm.fs` round-trip needed. The same mount **lifts the former `$PI_OUTPUT`
"local-only" limitation** — now done (`runShellStep`, `src/runtime/absurd/runtime.ts`):
each target exposes `workspacePath` (`workdir` for local, `/workspace` for
gondolin), so `$PI_OUTPUT` points at `<workspacePath>/.pi-output-<step>` inside
the command while the host reads the same file back from `workdir/.pi-output-<step>`.
Output capture is therefore uniform across targets.

### 5d. Auth summary

| | host-side (today) | in-guest (B, via §5a) |
|---|---|---|
| Where the model key lives | host process env | host only; guest sees a placeholder |
| Who can read the raw key | any host-side tool the agent runs | nothing in the guest |
| Egress scope | unrestricted host network | allowlisted model host only |

---

## 6. Recommendation & implementation sketch

**Recommend Option B** (one-shot Pi subprocess in-guest via `target.run`),
behind the existing `runs-on` switch: `gondolin*` → in-guest runner; `local` →
today's host `PiAgentRunner`. Evolve toward Option A only if/when in-step
multi-turn or streaming becomes a requirement. Reject Option C as the default.

This requires giving the `uses` handler access to the job's execution target —
the one seam deliberately missing today (§1a). Two coordinated changes.

### 6a. Thread the target into the `uses` path

`runUsesStep` already has `target` available in `runJobInTask`'s scope; today it
simply isn't passed. Extend `UsesContext` with a minimal exec capability (not the
whole `ExecutionTarget`, to keep the handler decoupled from the target module):

```ts
// src/runtime/types.ts  (additions to UsesContext)
export interface UsesContext {
  // …existing fields…
  runsOn: string;
  /** Run a command in the job's execution environment (host for local, guest VM
   *  for gondolin). Mirrors ExecutionTarget.run; lets a handler place work where
   *  the job runs instead of always on the host. */
  exec(command: string, opts?: {
    env?: Record<string, string>;
    onOutput?: (c: { stream: "stdout" | "stderr"; text: string }) => void;
  }): Promise<{ exitCode: number; stdout: string; stderr: string; ok: boolean }>;
  /** True when `exec` runs inside an isolated sandbox (i.e. not the host). */
  sandboxed: boolean;
}
```

The runtime wires `ctx.exec` to `target.run` (the same `RunResult` shape) and sets
`sandboxed = job.runsOn !== "local"`:

```ts
// src/runtime/absurd/runtime.ts  (runUsesStep — pass the target through)
async function runUsesStep(step, job, target, workdir, deps, expr) {   // ← add `target`
  // …resolve handler, interpolate `with`…
  const res = await handler.run({
    uses, with: resolvedWith, workdir, projectDir, workflowDir,
    runsOn: job.runsOn,
    sandboxed: job.runsOn !== "local",
    exec: (cmd, o) => target.run(cmd, o),
    emit,
  });
}
// caller (taskCtx.step branch): runUsesStep(step, job, target!, workdir, deps, exprCtx())
```

This is a contract change to `UsesHandler`/`UsesContext` only; the runtime core
still imports no agent code, and `LocalTarget`/`GondolinTarget` are unchanged.

### 6b. Add a sandbox-aware agent runner

`AgentRunner` stays the seam (`src/agent/index.ts`). Add a `GuestPiRunner` that,
instead of calling the SDK in-process, stages a request on the shared mount and
runs Pi in-guest via `ctx.exec`:

```ts
// src/agent/uses-handler.ts  (selection by sandboxed-ness)
const runner = opts.runner
  ?? (ctx.sandboxed ? new GuestPiRunner({ exec: ctx.exec }) : new PiAgentRunner());
```

```ts
// src/agent/guest-pi-runner.ts (new) — sketch
export class GuestPiRunner implements AgentRunner {
  constructor(private deps: { exec: UsesContext["exec"] }) {}
  async run(req: AgentRequest): Promise<AgentResult> {
    // 1. Write {system, prompt, model-without-key} to /workspace/.pi/req.json
    //    (host writes to the shared workdir; appears in-guest under /workspace).
    // 2. Run Pi in-guest; the key is injected by Gondolin into the model call,
    //    so the guest command references only a placeholder env var.
    const r = await this.deps.exec(
      `node /opt/pi-workflows/run-agent.mjs /workspace/.pi/req.json /workspace/.pi/res.json`,
      { env: { NODE_EXTRA_CA_CERTS: "/etc/gondolin/mitm/ca.crt", PI_OFFLINE: "0" } },
    );
    if (!r.ok) throw new UserFacingError(`in-guest agent failed: ${r.stderr.slice(0, 300)}`);
    // 3. Read /workspace/.pi/res.json from the host side of the mount → {text, finishReason}.
  }
}
```

The model config the handler resolves (`resolveModel`) splits into (a) the
non-secret part written into the request file (baseUrl, model id) and (b) the
secret, which the **handler must also push into the `GondolinTarget`'s
`createHttpHooks` config** — i.e. the target needs the model host on its
`allowedHosts` and the key in its `secrets` **at `provision()` time**. That is the
one ordering wrinkle: targets are provisioned per job before steps run, but the
model/allowlist is known per agent step. Options: provision the VM lazily on first
step, or pass agent network needs into `makeTarget` from the compiled plan.
**(Open question — §7.)**

### 6c. Guest image

`runs-on: gondolin:pi` (or fold Pi into the default sandbox image) — a custom
image with `nodejs`, `npm`, and `@earendil-works/pi-coding-agent` plus the small
`run-agent.mjs` wrapper, built via the mechanism in
[`gondolin-custom-images.md`](gondolin-custom-images.md) (`rootfsPackages: [ …,
nodejs, npm ]` + a `postBuild` `npm i -g` / vendored copy). **UNVERIFIED**: that
the Pi package installs and runs cleanly on Alpine/musl with its native deps — the
custom-images doc confirms `nodejs`/`npm` are valid Alpine packages but not that
this specific package builds there.

---

## 7. Open questions & risks

1. **Node trust of the MITM CA.** Does `NODE_EXTRA_CA_CERTS=/etc/gondolin/mitm/ca.crt`
   make Pi's model calls succeed through Gondolin's TLS MITM? **UNVERIFIED** —
   prototype first; this gates the whole approach.
2. **Localhost LiteLLM vs `blockInternalRanges`.** In-guest agents can't reach a
   host-loopback proxy without mapped TCP, which bypasses key injection. Decide:
   require a non-internal HTTPS model endpoint for `gondolin`, or accept mapped-TCP
   (and a different key-handling story). (§5a)
3. **Per-step network config vs per-job VM provisioning.** The model host/key are
   known per agent step, but the VM (and its `createHttpHooks` allowlist) is
   provisioned per job. Lazy provisioning, or hoisting agent network needs into the
   compiled plan / `makeTarget`. (§6b)
4. **Pi on Alpine/musl.** Does `@earendil-works/pi-coding-agent` install and run in
   the guest image? **UNVERIFIED.** Fallback: an `oci` Debian base
   ([`gondolin-custom-images.md`](gondolin-custom-images.md) §1).
5. **Image weight & boot cost.** A Node+Pi image is much larger than base Alpine;
   measure boot/first-run download against the sub-second-boot assumption.
   **UNVERIFIED.**
6. **One-exec-per-VM under Option A.** A held RPC `exec` and concurrent tool
   `exec`s contend on one VM; resolved only if tools run inside the RPC process.
   Confirm before pursuing A.
7. **Tools ∩ target, revisited.** With the agent genuinely in-guest, the
   `effective_tools = agent.tools ∩ target.allowed_tools` rule from
   [`agent-uses-interface.md`](agent-uses-interface.md) §7 can finally **allow**
   `bash`/`write`/`edit` on `gondolin` safely (they're VM-isolated). Wire the
   policy to the runner placement.
8. **Streaming fidelity.** One-shot `pi --mode json` yields structured events the
   handler can forward through `emit`; confirm the JSON event schema
   (`/docs/latest/json`) covers what the CLI/TUI surfaces. **UNVERIFIED** detail.
9. **Abort/cleanup.** Cancelling an in-guest agent = cancel the `exec` and/or
   `dispose()` the VM; confirm Gondolin reliably kills the guest process on signal
   ([`gondolin-secure-execution.md`](gondolin-secure-execution.md) flags this as
   **UNVERIFIED** for `exec` abort).

---

## Sources

- **Internal (this repo):** [`pi-coding-agent-sdk.md`](pi-coding-agent-sdk.md)
  (Pi modes/SDK/RPC, durability, auth), [`gondolin-secure-execution.md`](gondolin-secure-execution.md)
  (exec, fs/mounts, networking, secrets, MITM CA, the `pi-gondolin.ts` example),
  [`gondolin-custom-images.md`](gondolin-custom-images.md) (Node/Pi guest image),
  [`agent-uses-interface.md`](agent-uses-interface.md) (agent package model,
  tools∩target, open question #6). Code seams: `src/runtime/absurd/runtime.ts`
  (`runJobInTask`, `runUsesStep`, `runShellStep`), `src/runtime/types.ts`
  (`UsesContext`/`UsesHandler`), `src/agent/uses-handler.ts`, `src/agent/pi-runner.ts`,
  `src/targets/types.ts` + `src/targets/gondolin.ts` (`ExecutionTarget`).
- **Pi RPC / print modes:** https://pi.dev/docs/latest/rpc ·
  https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md ·
  https://www.npmjs.com/package/@earendil-works/pi-coding-agent (modes: interactive,
  print/json, rpc, SDK; RPC is JSONL over stdio with `id` correlation).
- **Gondolin networking / security:** https://earendil-works.github.io/gondolin/security/ ·
  https://earendil-works.github.io/gondolin/ (deny-by-default egress, allowlist,
  TLS MITM CA at `/etc/gondolin/mitm/ca.crt`, `createHttpHooks` secrets).
