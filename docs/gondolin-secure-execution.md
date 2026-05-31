# Gondolin as a Secure Execution Environment

Research notes for the durable workflow engine's `runs-on: gondolin` execution
target. All claims are drawn from the upstream repo and docs (URLs at the
bottom). Anything not directly stated in the sources is flagged
**UNVERIFIED — needs confirmation**.

> Repo summary: `earendil-works/gondolin` — "Experimental Linux microvm setup
> with a TypeScript Control Plane as Agent Sandbox." Apache-2.0. ~1.1k stars,
> latest release **v0.8.1 (May 5, 2026)**, 16 releases, actively developed.
> Languages: TypeScript 75.7%, JavaScript 11.8%, Zig 10.0%.

---

## 1. What Gondolin actually is

Gondolin runs untrusted code (typically AI-agent-generated) inside a **real
Linux micro-VM** running locally on your Mac or Linux machine, while keeping the
VM's **network and filesystem I/O surface mediated by host-side TypeScript code
you control**.

The headline framing from the docs:

> "Untrusted code runs in a real Linux VM, but the VM's *I/O surface area*
> (network + persistence) is mediated by host code you control."

### Isolation model

- **Primary isolation boundary: a hardware-virtualized VM.**
  - **Default backend: QEMU.** This is the default VM engine and the primary
    isolation boundary. The QEMU invocation is intentionally minimal:
    `-nodefaults`, `-no-reboot`, `-nographic`, virtio devices only
    (virtio-serial, virtio-net, virtio-blk, virtio-rng), rootfs attached as a
    copy-on-write qcow2 overlay.
  - **Optional/experimental backend: `libkrun` ("krun").** Uses
    Hypervisor.framework on macOS (the runner is ad-hoc signed with the
    `com.apple.security.hypervisor` entitlement). Selected via
    `sandbox.vmm = "krun"`, `--vmm krun`, or `GONDOLIN_VMM=krun`. Feature parity
    with QEMU is incomplete.
- **This is NOT gVisor, NOT plain containers, NOT namespaces.** It is a genuine
  guest kernel inside a VMM. The security doc states explicitly: "absent a QEMU
  escape, guest processes cannot directly access the host kernel, host memory,
  or host filesystem." A QEMU escape is treated as a full host compromise.
- **Guest OS / runtime:** a minimal **Alpine Linux** userspace (kernel +
  initramfs/rootfs). The image builder currently only supports Alpine. The
  guest is "conventional Linux userspace," so it runs arbitrary binaries,
  interpreters, shell, etc. — not tied to any one language runtime.

### Architecture (host control plane + guest)

Gondolin is a small system, not a single binary:

- **Host (the "control plane", TypeScript / Node.js):** the
  `@earendil-works/gondolin` library + CLI. Manages VM lifecycle, provides
  `vm.exec(...)`, implements the programmable VFS providers, and implements the
  programmable network policy (HTTP/TLS mediation, SSH egress proxy, mapped TCP).
  Key host components named in docs: `SandboxController` (spawns/manages QEMU),
  `SandboxServer` (virtio-serial control plane + VFS RPC + network backend),
  `QemuNetworkBackend` (userspace Ethernet/IP/TCP stack), `FsRpcService`.
- **Guest (Zig + init scripts):** small daemons —
  - `sandboxd` — receives exec requests over virtio-serial and spawns processes
  - `sandboxfs` — FUSE daemon proxying filesystem ops to host providers via RPC
  - `sandboxssh` — loopback-only host↔guest TCP forwarder for SSH access
  - `sandboxingress` — loopback-only forwarder for inbound HTTP (ingress)
  - `/init` — mounts tmpfs, brings up networking, starts the above
- **Control plane vs data plane:** structured RPC over **virtio-serial** carries
  exec + filesystem RPC (this is why no SSH is needed for normal operation). The
  data plane is "normal" Linux interfaces (`eth0`, FUSE paths) whose I/O is
  intercepted/served by the host.

The host is the single policy enforcement point for both networking and
persistence. The guest is treated as adversarial.

---

## 2. The SDK

### Language & install

- **SDK language: TypeScript / Node.js.** Package: `@earendil-works/gondolin`.
- Install: `npm install @earendil-works/gondolin`
- **Node.js >= 23.6 required.**
- The guest internals are Zig; the host krun runner build also touches Rust/Zig,
  but **as an SDK consumer you only write TypeScript.** CONFIRMED 2026-05-31: the
  only published package is the TypeScript `@earendil-works/gondolin` (the repo is
  TypeScript 75.7% / JavaScript 11.8% / Zig 10.0%, with no Python/Rust SDK package
  in the org). Treat TypeScript as the sole SDK surface.

### Core API surface (verified from docs)

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create();                 // async factory; autoStart: true by default
const result = await vm.exec("uname -a");     // ExecResult
await vm.close();                             // tear down (kills the VMM process)
```

Key entry points (all from `@earendil-works/gondolin`):

| Symbol | Purpose |
| --- | --- |
| `VM.create(options?)` | Async factory; resolves guest assets, boots VM (unless `autoStart: false`) |
| `vm.start()` | Explicit boot (when created with `autoStart: false`) |
| `vm.exec(cmd, options?)` | Run a command; returns an `ExecProcess` (promise + stream) |
| `vm.shell()` | Convenience interactive PTY+stdin wrapper around `exec` |
| `vm.fs` | Filesystem ops against the running guest (`readFile`, `writeFile`, `mkdir`, `listDir`, `stat`, `rename`, `access`, `deleteFile`, streaming variants) |
| `vm.close()` | Tear down the VM (required, or QEMU keeps running) |
| `vm.id` | Stable session UUID |
| `vm.getHostPid()` | Host PID of the VMM runner process (or `null`) |
| `vm.checkpoint(absPath)` / `checkpoint.resume()` | Disk-only qcow2 checkpoints |
| `vm.enableIngress(opts)` / `vm.setIngressRoutes()` | Expose guest HTTP servers to host |
| `vm.enableSsh()` | Start guest sshd + host forwarder (host→guest) |
| `createHttpHooks(opts)` | Build network allowlist/secret/hook policy |
| `MemoryProvider`, `RealFSProvider`, `ReadonlyProvider`, `ShadowProvider` | VFS providers |
| `listSessions()`, `findSession()`, `gcSessions()`, `connectToSession()` | Session registry / attach helpers |
| `hasGuestAssets()`, `ensureGuestAssets()`, `getAssetDirectory()` | Guest image asset management |

> **Signature note:** Option object field names below are verified from doc
> examples. Exact TypeScript type names (e.g. `ExecOptions`, `VMCreateOptions`)
> are inferred from prose and code samples; the precise exported type names are
> **UNVERIFIED** beyond what the docs name explicitly (`ExecResult`,
> `ExecProcess`, `IngressRequestBlockedError`, `VmCheckpoint`).

### `vm.exec()` — the workhorse

Two forms:

- `vm.exec("string")` → runs via login shell, equivalent to
  `vm.exec(["/bin/sh", "-lc", "string"])`. Use this for pipes, `$VARS`, globbing.
- `vm.exec([cmd, ...argv])` → executes `cmd` directly. **Does NOT search
  `$PATH`**, so `cmd` must be an absolute path.

It returns an `ExecProcess` that is both **promise-like** (`await` → `ExecResult`)
and **stream-like** (async-iterable for stdout when piped).

`ExecResult` fields (verified):

- `exitCode: number` — non-zero exit codes do **not** throw; the result is
  always returned
- `signal?: number` — termination signal if reported by the guest
- `ok: boolean` — shorthand for `exitCode === 0`
- `stdout: string` / `stderr: string` — decoded (default `utf-8`)
- `stdoutBuffer: Buffer` / `stderrBuffer: Buffer` — for binary output
- helpers: `result.json<T>()`, `result.lines()`

`ExecOptions` fields seen in docs: `cwd`, `env` (Record<string,string>),
`signal` (AbortSignal), `stdout`/`stderr` (`"pipe"` | `"inherit"` | writable),
`stdin` (boolean), `pty` (boolean), `encoding`, `buffer` (boolean),
`windowBytes` (backpressure window, default 256 KiB).

---

## 3. Code snippets

### 3a. Create a sandbox

```ts
import { VM } from "@earendil-works/gondolin";

// Simplest: boots immediately, default Alpine image (alpine-base:latest)
const vm = await VM.create();

// Or configure before boot:
const vm2 = await VM.create({
  autoStart: false,
  sessionLabel: "ci-job-1234",            // shown in `gondolin list`
  rootfs: { mode: "cow" },                // "readonly" | "memory" | "cow" (default)
  // sandbox: { imagePath: "./my-assets" } // custom guest image dir
});
await vm2.start();
```

### 3b. Run a command and capture stdout/stderr/exit code

```ts
// Buffered (most common) — captures everything
const r = await vm.exec("echo hello; echo oops >&2; exit 7");
console.log(r.exitCode); // 7
console.log(r.ok);       // false
console.log(r.stdout);   // "hello\n"
console.log(r.stderr);   // "oops\n"

// Direct exec (no shell, absolute path required)
const r2 = await vm.exec(["/bin/uname", "-a"]);
```

### 3c. Stream output live

```ts
// stdout only (default async iteration yields stdout string chunks)
const proc = vm.exec("for i in 1 2 3; do echo $i; sleep 1; done", {
  stdout: "pipe",
});
for await (const chunk of proc) {
  process.stdout.write(chunk);
}
const done = await proc;
console.log("exit:", done.exitCode);

// Both streams, labeled
for await (const { stream, text } of vm
  .exec("echo out; echo err >&2", { stdout: "pipe", stderr: "pipe" })
  .output()) {
  process.stdout.write(`[${stream}] ${text}`);
}
```

> Important: when `stdout/stderr` are `"pipe"`, Gondolin does **not** also buffer
> them into the final `ExecResult`. Capture them yourself if you need both.

### 3d. Inject a workspace (files), env vars, and secrets

**Files (workspace):** mount host-side providers via `vfs.mounts`. Keys are
absolute POSIX guest paths.

```ts
import {
  VM,
  RealFSProvider,
  MemoryProvider,
  ReadonlyProvider,
  ShadowProvider,
  createShadowPathPredicate,
} from "@earendil-works/gondolin";

const vm = await VM.create({
  vfs: {
    mounts: {
      // Live host repo, read-write, but hide secrets and host node_modules
      "/workspace": new ShadowProvider(new RealFSProvider("/host/repo"), {
        shouldShadow: createShadowPathPredicate(["/.env", "/.npmrc"]),
        writeMode: "deny",
      }),
      // disposable scratch space
      "/scratch": new MemoryProvider(),
      // read-only config/fixtures
      "/config": new ReadonlyProvider(new RealFSProvider("/host/config")),
    },
  },
});
```

You can also push/pull files directly via `vm.fs` without a mount:

```ts
await vm.fs.mkdir("/work", { recursive: true });
await vm.fs.writeFile("/work/input.json", JSON.stringify(payload));
const out = await vm.fs.readFile("/work/result.txt", { encoding: "utf-8" });
```

**Plain (non-secret) env vars:** pass `env` to `VM.create` and/or per-exec.

```ts
const vm = await VM.create({ env: { CI: "true", NODE_ENV: "test" } });
await vm.exec("printenv NODE_ENV");
await vm.exec(["/bin/sh", "-lc", "echo $FOO"], { env: { FOO: "bar" } });
```

> **Security rule from the docs:** do NOT pass real secrets in `VM.env` — they
> become readable inside the guest. Use the secret-injection mechanism below.

**Secrets (never exposed to guest):** the guest only ever sees a *placeholder*
env var; the host substitutes the real value into outbound HTTP headers only for
allowlisted destination hosts.

```ts
import { VM, createHttpHooks } from "@earendil-works/gondolin";

const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.github.com"],
  secrets: {
    GITHUB_TOKEN: {
      hosts: ["api.github.com"],
      value: process.env.GITHUB_TOKEN!,
    },
  },
});

const vm = await VM.create({ httpHooks, env }); // `env` carries the placeholders

const r = await vm.exec(`
  curl -sS -f \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    https://api.github.com/user
`);
```

The guest's `$GITHUB_TOKEN` is a placeholder string (default form
`GONDOLIN_SECRET_<random>`). The host swaps in the real token only when the
request goes to `api.github.com`. Substitution covers headers including
`Authorization: Basic …` (decoded, replaced, re-encoded). URL query
substitution is opt-in only (`replaceSecretsInQuery: true`). Bodies are NOT
substituted.

### 3e. Tear down

```ts
await vm.close(); // REQUIRED — otherwise the QEMU/krun process keeps running
```

If you opened ingress/ssh, close those first:

```ts
await ingress.close();
await access.close();
await vm.close();
```

---

## 4. Lifecycle, persistence, networking, limits, secrets

### Provisioning / boot time

- Docs state **VMs boot in under a second** ("cold starts are fast"). Guidance
  is to spin up per task/turn and tear down — don't keep idle VMs (a parked
  QEMU process still holds memory).
- First-ever run downloads guest assets (kernel/initramfs/rootfs, **~200MB+**)
  via `builtin-image-registry.json`, cached at `~/.cache/gondolin/images/`.
  Subsequent runs reuse the cache.

### Persistence model (treat VMs as disposable)

| Location | Backing | Survives `vm.close()`? | In disk checkpoints? |
| --- | --- | --- | --- |
| Most of `/` (rootfs) | qcow2 overlay | No | Yes |
| `/root`, `/tmp`, `/run`, `/var/log`, `/var/tmp`, `/var/cache` | tmpfs | No | No |
| VFS mounts (e.g. `/workspace`) | Host provider | Yes (provider-dependent) | No |

- Rootfs modes: `readonly` | `memory` (throwaway) | `cow` (default qcow2 overlay,
  checkpointable).
- **Disk checkpoints** (`vm.checkpoint(absPath)` → `.qcow2`, then
  `checkpoint.resume()`) capture root-disk state only — **no RAM/process state**.
  Full VM save/restore is NOT supported. Resume needs matching kernel/rootfs
  assets and a `buildId` in the manifest.
- To persist results: write to a VFS mount, or `vm.exec`/`vm.fs` the data out
  before closing.

### Networking controls

Default posture: **non-HTTP/TLS TCP is dropped; UDP is blocked except DNS.** The
host implements its own userspace network stack and classifies each outbound TCP
flow as HTTP / TLS / SSH (or denies it). `HTTP CONNECT` is explicitly denied.

- **HTTP/TLS (default mediated path):** host replays via `fetch` (undici). For
  TLS it does a controlled MITM (injects a local CA at
  `/etc/gondolin/mitm/ca.crt`) to inspect the request. Supports hostname
  allowlists (`*` wildcards), `onRequest`/`onResponse` hooks, IP policy
  (`isIpAllowed`), internal-range blocking (`blockInternalRanges: true` by
  default — blocks 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, metadata,
  etc.), DNS-rebinding protection, and host-resolved redirects.
- **SSH egress (opt-in):** `ssh: { allowedHosts, agent | credentials,
  knownHostsFile }`. Host-proxied, exec-only (no interactive shells, no sftp).
  Useful for git-over-SSH. Private key never enters guest.
- **Mapped TCP (opt-in):** `tcp: { hosts: { "h:port": "upstream:port" } }` for
  e.g. local Postgres. Raw tunnel, bypasses HTTP hooks and secret substitution.
  Requires `dns.mode: "synthetic"` + `syntheticHostMapping: "per-host"`.
- **DNS modes:** `synthetic` (default, no upstream DNS), `trusted` (forward to
  trusted resolvers only; IPv4-only), `open` (forward UDP/53 to target).
- **Ingress (host→guest):** `vm.enableIngress()` exposes a guest HTTP server on a
  host loopback port, with routing + request/response hooks.
- **Not supported:** HTTP/2, HTTP/3, QUIC, WebRTC, generic UDP. WebSockets work
  via HTTP/1.1 Upgrade but become opaque tunnels after `101`.

### Resource limits

- **No full resource governance / DoS isolation.** Docs are explicit: the guest
  can still burn CPU and allocate memory inside the VM. There are buffer caps
  (HTTP header/body limits, virtio queue caps, `MAX_RPC_DATA = 60 KiB` for VFS
  RPC payloads, default 256 KiB exec streaming window).
- **CONFIRMED 2026-05-31 (via [docs/backends.md](https://github.com/earendil-works/gondolin/blob/main/docs/backends.md)):** `VM.create` *does* expose explicit sizing knobs under `sandbox`/`rootfs`, supported on **both** backends:
  - `sandbox.cpus` — high-level CPU count (qemu ✓, krun ✓).
  - `sandbox.memory` — RAM (qemu ✓, krun ✓; krun parses it and passes MiB to libkrun).
  - `rootfs.size` — ensures the writable root disk is at least the requested size before boot and runs `resize2fs` in the guest (requires `resize2fs` in the image).
  - `sandbox.rootDiskPath` / `rootDiskFormat` / `rootDiskReadOnly` — supported on both.
  The qemu-only knobs `machineType`, `accel`, `cpu`, `qemuPath` exist but are **rejected when `vmm=krun`**. So vCPU/RAM/disk caps *are* available; only the low-level qemu tuning is qemu-specific.

### Secrets handling (summary)

Real secret values **never enter the guest**. Placeholders go in as env vars;
the host substitutes them into outbound HTTP headers for allowlisted hosts only.
Caveats: an allowed host that echoes headers back can still exfiltrate; bodies
and (by default) query params are not substituted; use high-entropy placeholders.

### Host / platform requirements

- **macOS and Linux only. No Windows.** ARM64 (Apple Silicon, Linux aarch64) is
  the most tested path; Linux x86_64 is smoke-tested for the krun runner in CI.
- Node.js >= 23.6.
- QEMU installed:
  - macOS: `brew install qemu`
  - Debian/Ubuntu: `sudo apt install qemu-system-arm` (aarch64). For x86_64 the
    required binary is `qemu-system-x86_64` (Debian/Ubuntu package `qemu-system-x86`).
    Confirmed 2026-05-31: [backends.md](https://github.com/earendil-works/gondolin/blob/main/docs/backends.md)
    states "Guest architecture must match the selected QEMU binary
    (`qemu-system-aarch64` vs `qemu-system-x86_64`)".
- Optional krun backend: `make krun-runner` (needs Rust toolchain w/ edition2024,
  Zig 0.16.0, and several `-dev` libs on Linux). Published npm package also ships
  platform-specific optional runner packages (`darwin-arm64`, `linux-x64`).

### CLI (for completeness)

```
npx @earendil-works/gondolin bash          # interactive sandbox shell
npx @earendil-works/gondolin list          # list running sessions
npx @earendil-works/gondolin attach <id>   # attach a shell to a running VM
npx @earendil-works/gondolin snapshot <id> # checkpoint (stops the session)
npx @earendil-works/gondolin bash --resume <snapshot-id-or-path>
```

---

## 5. Hosting the Pi agent runtime inside a sandbox

Gondolin ships a first-party example, `host/examples/pi-gondolin.ts`, that is a
**Pi coding-agent extension** (`@earendil-works/pi-coding-agent`). Relevance to
our engine: it is the canonical pattern for running an agent's tool calls inside
a Gondolin VM, which maps closely onto our `runs-on: gondolin` idea.

What it does:

- On `session_start`, creates one VM and mounts the directory `pi` was started in
  read-write at `/workspace` via `new RealFSProvider(localCwd)`.
- Overrides Pi's built-in `read` / `write` / `edit` / `bash` tools so they
  execute inside the VM instead of on the host. Each override builds the tool
  with custom `operations` backed by `vm.exec(...)`:
  - reads: `vm.exec(["/bin/cat", guestPath])`, returns `r.stdoutBuffer`
  - writes: base64-roundtrip into the guest to avoid quoting issues
  - bash: `vm.exec(["/bin/bash", "-lc", command], { cwd, env, stdout: "pipe",
    stderr: "pipe" })`, streaming chunks back through `proc.output()`, with
    AbortController-based timeout/cancellation
- Rewrites the system-prompt CWD line so the model "sees" `/workspace`.
- On `session_shutdown`, calls `vm.close()`.

Takeaways for our engine:
- A long-running agent maps to **one VM per task/session**, with `vm.exec` as the
  per-tool/per-step execution primitive.
- Host path → guest path translation and a single mounted `/workspace` is the
  clean pattern.
- **UNVERIFIED:** whether the full Pi runtime *binary* itself runs inside the VM,
  or whether (as in this example) Pi runs on the host and only its tool I/O is
  redirected into the VM. The example clearly does the latter (host-side Pi,
  VM-side tools). Running the entire agent process inside the guest would require
  a custom image with the runtime installed (default Alpine image is minimal;
  adding packages requires building a custom image).

---

## 6. Proposed `ExecutionTarget` abstraction (engine integration)

This is a design sketch for switching on `runs-on:` between a Gondolin sandbox
and local execution. It is engine code (not part of Gondolin) — adapt freely.

```ts
// execution-target.ts

export interface FileInput {
  /** absolute POSIX path inside the execution environment */
  path: string;
  content: string | Buffer;
}

export interface RunOptions {
  /** working directory inside the target (POSIX) */
  cwd?: string;
  /** non-secret environment variables */
  env?: Record<string, string>;
  /** abort/cancel */
  signal?: AbortSignal;
  /** wall-clock timeout in ms */
  timeoutMs?: number;
  /** optional live output callback (stdout+stderr interleaved-ish) */
  onOutput?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  ok: boolean;
}

/**
 * One job's isolated execution environment. The engine provisions a target,
 * stages the workspace, runs one or more step commands, collects artifacts,
 * then disposes it.
 */
export interface ExecutionTarget {
  /** Provision/boot the environment. */
  provision(): Promise<void>;
  /** Stage workspace files / env before steps run. */
  stageWorkspace(files: FileInput[]): Promise<void>;
  /** Run a single step command, capturing output + exit code. */
  run(command: string, opts?: RunOptions): Promise<RunResult>;
  /** Read a file back out (e.g. to persist build artifacts). */
  readFile(path: string): Promise<Buffer>;
  /** Tear everything down. Must be idempotent / always-safe to call. */
  dispose(): Promise<void>;
}
```

### Gondolin implementation

```ts
import {
  VM,
  RealFSProvider,
  MemoryProvider,
  createHttpHooks,
} from "@earendil-works/gondolin";
import type {
  ExecutionTarget,
  FileInput,
  RunOptions,
  RunResult,
} from "./execution-target";

export interface GondolinTargetConfig {
  /** host dir to mount read-write at /workspace, or undefined for in-memory */
  hostWorkspaceDir?: string;
  allowedHosts?: string[];
  secrets?: Record<string, { hosts: string[]; value: string }>;
  env?: Record<string, string>;
}

const GUEST_WORKSPACE = "/workspace";

export class GondolinTarget implements ExecutionTarget {
  private vm: VM | null = null;
  constructor(private cfg: GondolinTargetConfig = {}) {}

  async provision(): Promise<void> {
    const { httpHooks, env: secretEnv } = createHttpHooks({
      allowedHosts: this.cfg.allowedHosts ?? [],
      secrets: this.cfg.secrets ?? {},
    });

    this.vm = await VM.create({
      httpHooks,
      env: { ...secretEnv, ...(this.cfg.env ?? {}) },
      vfs: {
        mounts: {
          [GUEST_WORKSPACE]: this.cfg.hostWorkspaceDir
            ? new RealFSProvider(this.cfg.hostWorkspaceDir)
            : new MemoryProvider(),
        },
      },
    });
  }

  async stageWorkspace(files: FileInput[]): Promise<void> {
    if (!this.vm) throw new Error("not provisioned");
    for (const f of files) {
      await this.vm.fs.mkdir(posixDirname(f.path), { recursive: true });
      await this.vm.fs.writeFile(f.path, f.content);
    }
  }

  async run(command: string, opts: RunOptions = {}): Promise<RunResult> {
    if (!this.vm) throw new Error("not provisioned");

    // String form runs via /bin/sh -lc; use array+env for explicit control.
    const proc = this.vm.exec(["/bin/bash", "-lc", command], {
      cwd: opts.cwd ?? GUEST_WORKSPACE,
      env: opts.env,
      signal: opts.signal,
      stdout: opts.onOutput ? "pipe" : undefined,
      stderr: opts.onOutput ? "pipe" : undefined,
    });

    if (opts.onOutput) {
      for await (const { stream, text } of proc.output()) {
        opts.onOutput({ stream, text });
      }
    }
    const r = await proc; // ExecResult; non-zero exit does NOT throw
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, ok: r.ok };
  }

  async readFile(path: string): Promise<Buffer> {
    if (!this.vm) throw new Error("not provisioned");
    return this.vm.fs.readFile(path); // Buffer by default
  }

  async dispose(): Promise<void> {
    if (this.vm) {
      await this.vm.close();
      this.vm = null;
    }
  }
}

function posixDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}
```

> Note on timeout: the `RunOptions.timeoutMs` is best implemented with an
> `AbortController` (as the Pi example does), since Gondolin's `exec` takes a
> `signal`. Caveat from the docs: aborting currently rejects the local promise
> but does **not** yet guarantee the guest process is killed —
> **UNVERIFIED** whether close-then-recreate is needed to truly stop a runaway.

### Local implementation (less secure)

```ts
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ExecutionTarget,
  FileInput,
  RunOptions,
  RunResult,
} from "./execution-target";

export class LocalTarget implements ExecutionTarget {
  constructor(private workdir: string) {}

  async provision(): Promise<void> {
    await mkdir(this.workdir, { recursive: true });
  }

  async stageWorkspace(files: FileInput[]): Promise<void> {
    for (const f of files) {
      const abs = path.resolve(this.workdir, "." + f.path);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, f.content);
    }
  }

  run(command: string, opts: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("/bin/bash", ["-lc", command], {
        cwd: opts.cwd ?? this.workdir,
        env: { ...process.env, ...opts.env },
        signal: opts.signal,
      });
      let stdout = "";
      let stderr = "";
      const timer = opts.timeoutMs
        ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs)
        : undefined;
      child.stdout.on("data", (b) => {
        const t = b.toString();
        stdout += t;
        opts.onOutput?.({ stream: "stdout", text: t });
      });
      child.stderr.on("data", (b) => {
        const t = b.toString();
        stderr += t;
        opts.onOutput?.({ stream: "stderr", text: t });
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        const exitCode = code ?? -1;
        resolve({ exitCode, stdout, stderr, ok: exitCode === 0 });
      });
    });
  }

  readFile(p: string): Promise<Buffer> {
    return readFile(path.resolve(this.workdir, "." + p));
  }

  async dispose(): Promise<void> {
    /* local: nothing to tear down (optionally rm -rf the workdir) */
  }
}
```

### Engine selection on `runs-on`

```ts
function makeTarget(runsOn: string, job: JobSpec): ExecutionTarget {
  switch (runsOn) {
    case "gondolin": // default, secure
      return new GondolinTarget({
        hostWorkspaceDir: job.workspaceDir,
        allowedHosts: job.network?.allowedHosts,
        secrets: job.secrets,
        env: job.env,
      });
    case "local": // explicit opt-out, less secure
      return new LocalTarget(job.workspaceDir);
    default:
      throw new Error(`unknown runs-on: ${runsOn}`);
  }
}

// usage
const target = makeTarget(job.runsOn ?? "gondolin", job);
await target.provision();
try {
  await target.stageWorkspace(job.inputs);
  for (const step of job.steps) {
    const res = await target.run(step.command, {
      env: step.env,
      timeoutMs: step.timeoutMs,
      onOutput: (c) => logSink.write(c),
    });
    if (!res.ok && !step.continueOnError) break;
  }
} finally {
  await target.dispose(); // always tear down
}
```

### Integration notes / gotchas for the engine

- **Always `dispose()` (close the VM)** in a `finally` — an unclosed VM leaves a
  QEMU process running.
- **One command at a time per VM:** a long-running `vm.exec` (e.g. a server)
  blocks further exec requests on that VM. For matrix/parallel steps, use
  separate VMs (cheap: sub-second boot) — this aligns well with one VM per job.
- **Durability:** treat the rootfs as ephemeral. Persist step artifacts to a
  `RealFSProvider`-mounted dir or read them out via `vm.fs` before `dispose()`.
  This matters for a durable workflow engine that may replay/resume.
- **Checkpoints as a warm-start optimization:** `vm.checkpoint()` (disk-only)
  could cache a "tools installed" base image to skip repeated `apk add` — but
  it does NOT restore RAM/process state, so it's a base-image cache, not a
  pause/resume of a live job. **UNVERIFIED** fit for our durability/replay model.
- **Custom images:** the default Alpine image is minimal. Language runtimes /
  compilers require building a custom image (`gondolin build`, Alpine-only) and
  pointing `sandbox.imagePath` at it. For `runs-on: gondolin` to be useful for
  arbitrary CI steps, the engine likely needs a curated base image per
  language/toolchain — analogous to GitHub Actions runner images. **See
  [`gondolin-custom-images.md`](gondolin-custom-images.md)** for the verified
  build-config format, the CI build/cache approach, and a proposed
  `runs-on: gondolin:<variant>` design.
- **Secrets must flow through `createHttpHooks`,** not `env`, to keep the "secret
  never in guest" guarantee. The engine's secret store should map to the
  `secrets: { NAME: { hosts, value } }` shape with explicit per-secret host
  allowlists.
- **Network is deny-by-default.** Steps that need to reach package registries,
  git hosts, etc. must declare allowed hosts (e.g. `*.github.com`,
  registry hosts). HTTP/2/3, QUIC, generic UDP won't work — relevant if a step
  uses tooling that depends on them.

---

## Sources

- Repo (README, file tree, release/metadata):
  https://github.com/earendil-works/gondolin
- Pi extension example (raw):
  https://github.com/earendil-works/gondolin/blob/main/host/examples/pi-gondolin.ts
- Host package README (raw):
  https://github.com/earendil-works/gondolin/blob/main/host/README.md
- SDK overview: https://earendil-works.github.io/gondolin/sdk/
- SDK VM Control (exec, fs, lifecycle): https://earendil-works.github.io/gondolin/sdk-vm/
- SDK Network Access: https://earendil-works.github.io/gondolin/sdk-network/
- SDK Storage / Snapshots / images / rootfs modes: https://earendil-works.github.io/gondolin/sdk-storage/
- VFS Providers: https://earendil-works.github.io/gondolin/vfs/
- Architecture Overview: https://earendil-works.github.io/gondolin/architecture/
- Security Design: https://earendil-works.github.io/gondolin/security/
- Workloads & Lifecycle (boot time, persistence table): https://earendil-works.github.io/gondolin/workloads/
- Limitations: https://earendil-works.github.io/gondolin/limitations/
- VM Backends (QEMU vs krun): https://github.com/earendil-works/gondolin/blob/main/docs/backends.md (fetched & reviewed 2026-05-31). Key points: `qemu` is the default with broader feature support; `krun` is experimental (libkrun, host-arch-only, needs libkrunfw-compatible kernel + manifest krun boot assets). Shared sizing knobs `sandbox.cpus` / `sandbox.memory` / `rootfs.size` work on both; `machineType`/`accel`/`cpu`/`qemuPath` are qemu-only and rejected under krun. `rootfs.mode="memory"` is true snapshot mode on qemu but a temp on-disk qcow2 overlay (not RAM-backed) on krun. Cross-backend checkpoint resume needs `manifest.assets.krunKernel`.
