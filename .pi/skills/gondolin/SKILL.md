---
name: gondolin
description: Gondolin micro-VM sandbox concepts and TypeScript SDK (@earendil-works/gondolin) usage — VM lifecycle, exec, VFS mounts, deny-by-default networking, placeholder secret injection, checkpoints, custom images, and how this repo's GondolinTarget wires it. Use when writing or debugging sandboxed job execution, egress/secrets policy, or anything touching the gondolin SDK.
---

# Gondolin & the TypeScript SDK

Gondolin runs untrusted (typically agent-generated) code inside a **real Linux
micro-VM** (Alpine guest, QEMU by default; experimental libkrun backend), while
the VM's entire **I/O surface — network and filesystem — is mediated by
host-side TypeScript you control**. Sub-second boots; designed to be spun up
per task and thrown away.

This is **not** containers, namespaces, or gVisor: it's a hardware-virtualized
guest kernel. Absent a VMM escape, the guest cannot touch the host kernel,
memory, or filesystem. The guest is treated as adversarial; the host control
plane is the single policy-enforcement point.

We use the **TypeScript SDK exclusively** (`@earendil-works/gondolin`, pinned
`^0.12.0` here; Node >= 23.6, QEMU installed, macOS/Linux only). The CLI
(`gondolin bash|list|attach`) is for manual poking; engine code never shells
out to it except `gondolin build` for images.

Docs: https://earendil-works.github.io/gondolin/ — key pages: `/sdk-vm/`
(exec, fs, lifecycle), `/sdk-network/`, `/secrets/`, `/sdk-storage/`, `/vfs/`,
`/custom-images/`, `/security/`, `/limitations/`.

## Core SDK (verified against installed 0.12.0)

### Create → exec → close

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create({
  memory: "2G",              // qemu syntax, default "1G"  (top-level, NOT sandbox.*)
  cpus: 2,                   // default 2
  env: { CI: "true" },       // NON-secret env only — guest-readable!
  sessionLabel: "job-1234",  // shown in `gondolin list`
  // sandbox: { imagePath: "work:base" },  // custom image selector or asset dir
  // rootfs: { mode: "cow" | "readonly" | "memory", size: "2G" },
  // autoStart: false  → call vm.start() yourself
});

const r = await vm.exec("echo hello; exit 7");
r.exitCode; r.ok; r.stdout; r.stderr;   // non-zero exit does NOT throw
r.json<T>(); r.lines(); r.stdoutBuffer; // helpers / binary

await vm.close();   // REQUIRED — an unclosed VM leaves a QEMU process running
```

`vm.exec` has two forms:

- **String** — runs via login shell (`/bin/sh -lc`): use for pipes, `$VARS`,
  globbing.
- **Array** (`["/bin/cat", path]`) — direct exec, **no `$PATH` search**: the
  command must be an absolute path.

Exec options: `cwd`, `env`, `signal` (AbortSignal), `stdin`, `pty`,
`stdout`/`stderr` (`"pipe" | "inherit"`, default buffered), `encoding`,
`buffer: false`, `windowBytes` (256 KiB default backpressure window).

**Streaming caveat:** with `stdout: "pipe"` Gondolin does **not** also buffer
into the final `ExecResult` — accumulate chunks yourself if you need both:

```ts
const proc = vm.exec(cmd, { stdout: "pipe", stderr: "pipe" });
for await (const { stream, text } of proc.output()) { /* live chunks */ }
const result = await proc;   // exitCode etc.; stdout/stderr will be empty here
```

### Guest filesystem — `vm.fs`

`readFile`, `writeFile` (string/Buffer/stream), `mkdir({recursive})`,
`listDir`, `stat`, `rename`, `access`, `deleteFile`, `readFileStream` —
host-side ops against the running guest, no mount needed.

### Mounts — VFS providers

```ts
import { VM, RealFSProvider, MemoryProvider } from "@earendil-works/gondolin";
const vm = await VM.create({
  vfs: { mounts: {
    "/workspace": new RealFSProvider("/host/job-dir"),  // live, read-write
    "/scratch":   new MemoryProvider(),                  // throwaway
  }},
});
```

Also available: `ReadonlyProvider`, `ShadowProvider` (hide paths like `.env`
from the guest). Mount keys are absolute POSIX guest paths.

## Networking: deny-by-default mediation

The host implements a userspace network stack; each outbound TCP flow is
classified **HTTP / TLS / SSH or dropped**. UDP is blocked except DNS. TLS is
inspected via a controlled MITM — the local CA sits at
`/etc/gondolin/mitm/ca.crt` in-guest (point `NODE_EXTRA_CA_CERTS` etc. at it
for in-guest TLS clients).

```ts
import { createHttpHooks } from "@earendil-works/gondolin";
const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.github.com", "*.npmjs.org"],  // wildcards ok
  // allowedInternalHosts: [...],   // hosts allowed to resolve to private IPs
  // onRequest / onResponse hooks; isRequestAllowed / isIpAllowed
  secrets: { /* see below */ },
});
const vm = await VM.create({ httpHooks, env });  // BOTH, or secrets break
```

- `allowedHosts: undefined` allows all hosts; `[]` denies all.
- `blockInternalRanges` defaults true — private/metadata IPs are blocked even
  for allowlisted names (DNS-rebinding protection); relax per-host with
  `allowedInternalHosts`.
- Redirects resolve host-side — a redirect can't escape the allowlist.
- Raw TCP to specific upstreams: `tcp: { hosts: { "db.internal": "127.0.0.1:5432" } }`
  (bypasses HTTP hooks **and** secret substitution).
- Outbound SSH (git): `ssh: { allowedHosts, agent | credentials }` —
  host-proxied, key never enters the guest.
- **Not supported:** HTTP/2, HTTP/3, QUIC, generic UDP, `HTTP CONNECT`.
  WebSockets work via HTTP/1.1 Upgrade, then become opaque tunnels.

## Secrets: placeholders, never real values in-guest

The guest only ever sees a random placeholder (`GONDOLIN_SECRET_<random>`) in
its env; the host swaps the real value into **outbound HTTP headers**, and only
for that secret's allowlisted hosts:

```ts
const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.github.com"],
  secrets: {
    GITHUB_TOKEN: { hosts: ["api.github.com"], value: process.env.GITHUB_TOKEN! },
  },
});
// in-guest: curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user
```

Substituted: plain header values, `Authorization: Basic` (decoded → replaced →
re-encoded). Query strings only with `replaceSecretsInQuery: true`. **Never**
request bodies or URL paths. Rules:

- Never pass real secrets via `VM.create({ env })` or bake them into images.
- Never mount host secret files (`~/.aws`, `.env`) into the guest.
- An allowlisted host is a trusted egress destination — the guest can upload
  anything it can read to it.
- Hooks may run after substitution: don't log request headers from
  `onRequest`/`onResponse`.

## Persistence & checkpoints

Treat VMs as **disposable**. What survives:

| Location | Survives `vm.close()`? | In checkpoints? |
|---|---|---|
| rootfs (`/`, cow qcow2 overlay) | no | yes |
| `/root`, `/tmp`, `/var/log`, … (tmpfs) | no | no |
| VFS mounts (`/workspace`) | yes (host-backed) | no |

Persist results by writing to a mount or reading out via `vm.fs` **before**
closing. `vm.checkpoint(path)` / `checkpoint.resume()` are **disk-only** qcow2
snapshots — no RAM/process state, so they're a warm-start cache (pre-installed
tools), not pause/resume of a live job.

## Gotchas (the ones that actually bite)

1. **Always `close()` in a `finally`** — otherwise QEMU leaks.
2. **One command at a time per VM** — a long-running exec blocks further execs;
   parallelism = more VMs (boots are sub-second).
3. **Non-zero exit does not throw** — check `r.ok`/`r.exitCode`.
4. **Pipe mode doesn't buffer** — accumulate streamed output yourself.
5. **Array-form exec needs absolute paths** — no `$PATH` lookup.
6. The default Alpine image is minimal — toolchains require a **custom image**
   (`gondolin build`, Alpine-only builder); no runtime `apk add` persistence.
7. No resource governance beyond `cpus`/`memory` sizing — a guest can still
   spin CPU; use exec `signal` + timeouts.
8. First-ever run downloads guest assets (~200 MB) to
   `~/.cache/gondolin/images/`.

## How this repo uses Gondolin

Gondolin is the **only** execution target — every job runs in its own VM
(`runs-on: gondolin` or a custom `work:<image>`); host execution was removed.
Read before changing target behavior:

- `src/targets/gondolin.ts` — `GondolinTarget`: lazy `import()` of the
  *optional* dependency inside `provision()` (engine stays importable without
  it); job workdir mounted via `RealFSProvider` at `/workspace`; steps run as
  `/bin/sh -lc` (`buildExecArgs`); sizing from the compiler's machine catalog
  (`memory`/`cpus` top-level); streamed output re-accumulated per the pipe
  caveat; `dispose()` nulls then closes.
- **Mediation is conditional**: `createHttpHooks` is installed *only* when the
  job has secrets/datasources/internal hosts to mediate. A job with none gets
  **no hooks and therefore open outbound network** — that's how a plain
  `run: npm install` reaches the registry. The hooks scope *injected secrets*
  to their hosts; they are not a general egress sandbox for trusted steps.
- Model keys for agent steps are injected via this header-swap, so the key
  never enters the guest even though the agent (Pi) runs in-guest —
  `docs/pi-in-gondolin.md`, `src/agent/guest-pi-runner.ts`.
- Custom images: `work:<variant>` build-configs in `src/images/`, built lazily
  through `gondolin build` into the tagged store, booted via
  `sandbox: { imagePath: "work:<variant>" }` — `docs/gondolin-custom-images.md`.
- Tests never boot VMs — they inject a `HostTarget` double via `makeTarget`
  (`src/targets/factory.ts`).
- Full verified research (architecture, security model, backends, limits):
  `docs/gondolin-secure-execution.md`.
