# Gondolin Custom Images — Research + Design Sketch

Research for giving jobs real toolchains (node, go, python, a devops kit, …) via
**custom guest images**, instead of the no-frills Alpine default. The design (§6)
splits the namespace: `runs-on: gondolin` stays the raw upstream sandbox, while
images **we** curate live under a `work:` namespace (`work:base`, `work:node-25`,
`work:devops`, …). Verified against the Gondolin docs and the `earendil-works/gondolin`
repo (source + its own CI). Items that couldn't be confirmed are flagged `UNVERIFIED`.

> **Gondolin version:** `@earendil-works/gondolin@0.12.0` (Apache-2.0, Node ≥ 23.6,
> CLI bin `gondolin`, Alpine 3.23.0 default). Pre-1.0, so treat the API surface as
> stabilizing rather than frozen. **Re-verified 2026-06-07** against the *installed*
> package — still 0.12.0, so the SDK facts below hold, and `VMOptions.sandbox.imagePath`
> (§3) is confirmed from the shipped type declarations, not just the published docs.

> **Status:** design sketch — **not implemented**. The engine work in §6 is unbuilt;
> this doc records the capability and a concrete, current plan. The "current engine
> state" callout in §6 lists the exact integration points (with file refs) and flags
> the two that today **reject** a `work:<variant>` value (our image namespace).

---

## TL;DR

- A custom image is defined by a **single declarative JSON build-config** (not a
  Dockerfile): pick Alpine packages (`alpine.rootfsPackages`) and optional
  post-build shell steps (`postBuild.commands`). `nodejs`, `npm`, `python3`,
  `uv` are all valid Alpine packages (and are in Gondolin's default config).
- You build it with `gondolin build --config <file> --output <dir> [--arch …]`.
  The output is a **plain asset directory** (`manifest.json`, kernel,
  `initramfs.cpio.lz4`, `rootfs.ext4`, krun assets).
- You boot it with `VM.create({ sandbox: { imagePath: "<dir>" } })` (or the
  `GONDOLIN_GUEST_DIR` env var) — which is the single hook our `GondolinTarget`
  needs to gain.
- **The build is a host-side rootfs assembly — it does NOT boot a QEMU VM, needs
  no `/dev/kvm`, and needs no root** unless the image uses `postBuild.commands`
  (which `chroot` and so need root or `container.force`). Gondolin's own CI
  builds x86_64 images on stock `ubuntu-latest`, so building ours in GitHub
  Actions is well-trodden.

---

## 1. How a custom image is defined (the build-config)

A custom image is one JSON file (conventionally `build-config.json`; any path,
passed via `--config`). Scaffold a starter with `gondolin build --init-config`.
The default config the docs show — note it already bundles node + python:

```json
{
  "arch": "aarch64",
  "distro": "alpine",
  "env": { "FOO": "bar" },
  "alpine": {
    "version": "3.23.0",
    "kernelPackage": "linux-virt",
    "kernelImage": "vmlinuz-virt",
    "rootfsPackages": [
      "linux-virt", "rng-tools", "bash", "ca-certificates", "curl",
      "e2fsprogs", "nodejs", "npm", "uv", "python3", "openssh"
    ],
    "initramfsPackages": [],
    "krunfwVersion": "v5.2.1"
  },
  "rootfs": { "label": "gondolin-root" },
  "postBuild": {
    "copy": [{ "src": "./dist/my-tool.tar.gz", "dest": "/tmp/my-tool.tar.gz" }],
    "commands": ["pip3 install llm llm-anthropic"]
  }
}
```

Key fields (verified):

| Field | Type | Notes |
|---|---|---|
| `arch` | `"aarch64" \| "x86_64"` | Target arch (or `--arch`). |
| `distro` | `"alpine"` | Only Alpine supported. |
| `env` | object \| string[] | Baked into the guest init **before** `sandboxd` starts. *Not for secrets.* |
| `alpine.rootfsPackages` | string[] | The apk packages — this is where `nodejs`/`python3`/etc. go. From Alpine `main`+`community`. |
| `alpine.version` / `mirror` / `kernelPackage` | string | Defaults: `3.23.0`, official CDN, `linux-virt`. |
| `rootfs.label` / `sizeMb` | string / number | Size auto-calculated (`dirSize*1.2 + 64MB`) if omitted. |
| `postBuild.copy[]` | `{src,dest}[]` | `src` relative to the config file; `dest` an absolute guest path. |
| `postBuild.commands` | string[] | Run in order via `/bin/sh -lc` **inside a chroot** (→ needs root, see §4). |
| `oci.image` | string | Escape hatch: use an OCI image (e.g. `debian:bookworm-slim`) as the rootfs base (needs Docker/Podman; `rootfsPackages` ignored; rootfs must have `/bin/sh`). |
| `runtimeDefaults.rootfsMode` | `"readonly"\|"memory"\|"cow"` | Baked into `manifest.json`. |

Two ways to add tooling: **apk packages** (`rootfsPackages`) for anything in
Alpine, and **`postBuild.commands`** for the rest (`pip install …`, `npm i -g …`).
Alpine-only unless you use the `oci` base.

## 2. Building an image

CLI (the `gondolin` bin; `npx @earendil-works/gondolin build …` if not global).
There is **no SDK builder function** — building is the CLI's job; the SDK only
*consumes* assets.

```bash
gondolin build --init-config > build-config.json          # scaffold
gondolin build --config build-config.json --output ./out  # build (native arch)
gondolin build --arch x86_64 --config build-config.json --output ./x64-out
gondolin build --verify ./out                             # sanity-check assets
```

Output is a directory:

```
out/
  manifest.json        # build config + SHA-256 checksums + deterministic buildId
  vmlinuz-virt         # kernel (qemu)
  initramfs.cpio.lz4
  rootfs.ext4
  krun-kernel          # krun assets
  krun-empty-initrd
```

`manifest.json`'s `buildId` is derived from content checksums — i.e. **builds are
deterministic/content-addressed**, which is what makes CI caching safe (§5).

## 3. Booting from a custom image (the runtime hook)

The single option our `GondolinTarget` needs — point `sandbox.imagePath` at the
asset directory (it reads `manifest.json`):

```ts
const vm = await VM.create({ sandbox: { imagePath: "./out" } });
```

**Verified** against the installed 0.12.0 type declarations:
`VM.create(options?: VMOptions)`, where `VMOptions.sandbox?: SandboxServerOptions`
and `SandboxServerOptions.imagePath?: ImagePath` — and `imagePath` can be *either*
a directory of guest assets *or* an object of explicit asset paths
(`vm/types.d.ts`, `sandbox/server-options.d.ts`). Note `memory`/`cpus`/`vfs`/
`httpHooks` are **top-level** `VMOptions` keys, while `imagePath` is **nested under
`sandbox`** — so this is a new key alongside the flat options our `provision()`
already builds, not a change to the existing ones.

CLI equivalent: `GONDOLIN_GUEST_DIR=./out gondolin bash`.

Gondolin also supports name:tag selection via a downloadable registry
(`GONDOLIN_DEFAULT_IMAGE` + `GONDOLIN_IMAGE_REGISTRY_URL`), but **we don't use
it** — we explicitly do not want a shareable image registry. Our images are
**built locally on the host architecture** and referenced directly by
`imagePath` (see §6).

## 4. Build prerequisites (the important part for CI)

The build is a **host-side userspace assembly**, confirmed from source
(`host/src/alpine/*`, `host/src/build/native.ts`):

- apk install = download `APKINDEX` + `.apk` files over HTTP and **extract the
  tarballs into a target dir** (no `apk` binary, no chroot).
- `rootfs.ext4` built via `mke2fs -t ext4 -d <sourceDir>` — populates the FS
  from a directory in **userspace, no loop device, no `mount`, no root**.
- initramfs via `cpio` + `lz4`.
- **No `qemu-system` is spawned during a build** (grep of the build path is
  empty). QEMU is only for *running/testing* the resulting image.

Host tools needed (per docs): **`cpio`, `lz4`, `e2fsprogs`** (and **Docker/Podman
only** if using an `oci` base). `sudo apt install lz4 cpio e2fsprogs`. Network
egress to the Alpine mirror (APKINDEX/.apk), GitHub Releases (`libkrunfw-<arch>.tgz`),
and the Gondolin release host (prebuilt sandbox helper binaries, fetched
automatically — Zig is only for contributors building helpers from source).

**Root is needed only for `postBuild.commands`** (they `chroot` + `mount -t proc`):

> Native Linux builds need root privileges for chroot (or use `container.force=true`)

So: a **package-list-only** image (node/python via `rootfsPackages`) builds with
**no root**. An image with `pip install …` needs `sudo` or `container.force=true`
(Docker is preinstalled on hosted runners).

**Arch:** building **x86_64 on an x86_64 host is native and supported**;
`postBuild.commands` require runtime arch == target arch (they execute guest
binaries in the chroot). Apple-Silicon dev builds `aarch64`; x86_64 CI builds
`x86_64`. Image asset dirs are therefore **arch-specific** — build per host arch,
don't commit prebuilt images.

## 5. Building in GitHub Actions — feasible (Gondolin does it)

Gondolin's own `.github/workflows/image-release.yml` and `ci.yml` build images on
`ubuntu-latest` (matrix of `aarch64` + `x86_64`), `tar -czf` the output, and
`upload-artifact`; downstream jobs download + extract and boot them. No hard
blockers for us:

| Requirement | ubuntu-latest | Blocker? |
|---|---|---|
| `lz4`/`cpio`/`e2fsprogs` | `sudo apt-get install -y` (passwordless) | No |
| Network egress | Yes | No |
| Userspace rootfs build (`mke2fs -d`, tar extract) | Normal user | No |
| `/dev/kvm` | **Not needed to build** (only to run) | No |
| Loop devices / `losetup` | **Not used** | No |
| Root for `postBuild.commands` | `sudo`, or `container.force=true` (Docker preinstalled) | Opt-in only |
| Zig 0.16.0 | Not needed (prebuilt helpers downloaded) | No |

**CI build-caching options** (we are *not* distributing images — just avoiding
rebuilds within the project's own CI):

1. **`actions/cache` keyed on `hash(images/**/build-config.json)`** — safe because
   the `buildId` is content-addressed; unchanged configs skip the (cheap) rebuild
   across runs. Simplest; build in the same job that consumes the images.
2. **upload-artifact → download-artifact** between jobs in one run (what Gondolin
   CI does): build each image, upload, download in the test job, point
   `GONDOLIN_GUEST_DIR`/`imagePath` at it. Use if build and test are separate jobs.

Build time/size: `UNVERIFIED` (no documented number) — but it's download-bound
(apk fetch) + one `mke2fs`/`cpio` pass, no VM boot, so expect ~1–2 min on a
hosted runner. Default rootfs size auto-calculated.

---

## 6. Proposed design for pi-workflows

### Two namespaces: `gondolin` (stock) vs `work:*` (ours)

The `runs-on` target name encodes **who maintains the image**, which keeps "raw
upstream sandbox" and "an image we curate" cleanly separated:

```
# the completely untouched upstream gondolin guest — no custom build, just download
runs-on: gondolin

# images WE maintain (the `work` namespace) — built from images/<variant>/build-config.json
runs-on: work:base           # our more-capable base (git, curl, jq, ca-certs, … over stock)
runs-on: work:node-25        # work:base + Node 25 + npm
runs-on: work:go-1.26        # work:base + Go 1.26 toolchain
runs-on: work:python-3.13    # work:base + python3 + uv + pip
runs-on: work:devops         # work:base + kubectl, helm, awscli, gcloud, terraform, docker-cli, jq …
runs-on: work:rust           # work:base + rustup/cargo + build-base
```

- **`gondolin`** → the stock upstream image (today's behavior, no `imagePath`). The
  escape hatch — "give me exactly what gondolin ships, nothing of ours."
- **`work:<variant>`** → an image from our registry, booted via `sandbox.imagePath`.
  `work:base` is the blessed, more-capable base; every other `work:*` is `work:base`
  plus a toolchain or role bundle.

Since Pi already runs in-guest on the *stock* image, there's no `work:pi` —
agent steps work everywhere. The `work` namespace is about **toolchains for
`run:` steps**, not the agent.

**Naming convention** inside the `work:` namespace (the part after `:` is just a
registry key, so this is convention, not parsing rules):

- `<tool>-<version>` — a single pinned toolchain (`node-25`, `go-1.26`,
  `python-3.13`). The name carries the version; the build-config is what pins it.
- a bare role name — a curated preset bundling several tools (`base`, `devops`,
  `rust`, `data`). No version in the name; the build-config is the source of truth.

**`work:base` as the shared floor.** Gondolin builds aren't layered like Docker —
each image is a full rootfs assembled from one config — so "built on `work:base`"
means every `work:*` config **includes the base package set** plus its specialty.
Factor that base set into a shared snippet (a JSON fragment the configs spread in,
or a small generator) so `work:base` stays the single source of truth for the floor.

**Honesty about pinning a version.** Alpine's apk packages track the *distro*
release, so `nodejs`/`go`/`python3` in `rootfsPackages` give you "whatever that
Alpine version ships." A variant named `node-25` therefore pins its version one of
three ways, decided per image in its `build-config.json` — not by the variant name:

1. **Pick the Alpine version** whose `community`/`main` ships that toolchain version
   (`alpine.version`), e.g. an Alpine release carrying Node 25. Cleanest when it lines up.
2. **`postBuild.commands`** that fetch an exact build (`work/install-node`-style musl
   tarball, `rustup toolchain install 1.x`, a pinned Go tarball). Needs root /
   `container.force` at build (§4) but pins precisely.
3. **An `oci.image` base** (`golang:1.26-alpine`, `node:25-alpine`) when an upstream
   image already nails it — `rootfsPackages` is ignored in that mode.

So the catalog is a small set of **maintained, `work:<variant>`→build-config
mappings**; adding `work:go-1.27` later is a new folder + registry entry, not an
engine change.

> **Open decision — the default.** `DEFAULT_RUNS_ON` is `gondolin` (stock) today,
> which needs zero image build. Once image-building is wired into CI and local init,
> we could flip the default to `work:base` so an omitted `runs-on` gets the capable
> floor. Trade-off: a more useful default vs. requiring a built image before the
> first run. Left as `gondolin` until the build path exists; revisit then.

### Image definitions: `images/<variant>/build-config.json`

Mirror the `test/e2e/<name>/` convention — one folder per image:

```
images/
├── _base.json                # shared floor package set, spread into each config below
├── base/
│   └── build-config.json     # work:base — _base.json (git, curl, jq, bash, ca-certs …)
├── node-25/
│   └── build-config.json     # work:node-25 — base + Alpine w/ Node 25, rootfsPackages:[…,nodejs,npm]
├── go-1.26/
│   └── build-config.json     # work:go-1.26 — base + postBuild fetch of the pinned Go 1.26 tarball
├── python-3.13/
│   └── build-config.json     # work:python-3.13 — base + python3 + py3-pip + uv
├── devops/
│   ├── build-config.json     # work:devops — base + kubectl, helm, awscli, gcloud, terraform, docker-cli …
│   └── kubeconfig.tpl         # postBuild.copy source can sit beside the config
└── README.md
```

The folder name maps to the variant after `work:` — `images/node-25/` ↔
`work:node-25` — so it doubles as the registry key. `images/base/` is `work:base`,
and `_base.json` holds the shared floor every config pulls in (so the base set lives
in one place; see "`work:base` as the shared floor" above). (The flat
`images/node-25-build-config.json` form also works — `--config` takes any path — but
a folder per image leaves room for `postBuild.copy` source files to sit next to
their config, and matches the `test/e2e/<name>/` layout.) Built output goes to
`images/<variant>/out/` (gitignored) or a cache dir — never committed (arch-specific,
large).

### Current engine state — the dependents that must change (verified 2026-06-07)

`runs-on` is treated as an **opaque exact-match string** end-to-end today, so two
places **actively reject** any `work:<variant>` value and must learn the
`namespace[:variant]` grammar (`gondolin` = stock, `work:<variant>` = ours) before
anything else works. A third (a warning added after this doc was first written)
should treat a `work:` value as "explicit". The runtime needs **no** change — it
threads `job.runsOn` through verbatim.

| Where | Today | Needs |
|---|---|---|
| `src/compiler/compile.ts` — `validateRunsOn()` | **throws** `unknown runs-on "<x>"` for anything but `gondolin` | also accept `work:<variant>` for a **known** variant; reject unknown variants; keep `gondolin` and the `local`-was-removed message |
| `src/compiler/compile.ts` — `runsOnWarning()` | only an *omitted* `runs-on` warns; explicit `gondolin` is silent | treat an explicit `work:<variant>` as explicit too (no nag) |
| `src/targets/factory.ts` — `makeTarget()` | `switch (runsOn)` exact-match, `default:` **throws** | parse `namespace[:variant]`; `gondolin` → stock (no `imagePath`); `work:<variant>` → resolve to its asset dir and pass `imagePath` in `TargetContext`/config |
| `src/targets/gondolin.ts` — `GondolinTargetConfig` + `provision()` | `createOpts` is flat (`memory`/`cpus`/`vfs`/`env`/`httpHooks`); no image hook | add `imagePath?: string`; when set, add `sandbox: { imagePath }` to `createOpts` (omit → stock upstream image, today's behavior) |
| `src/runtime/absurd/runtime.ts` (~`:297`) | `makeTarget(job.runsOn, { workdir, machine, …network })` | **no change** — `job.runsOn` (incl. the `work:` namespace) already flows straight to the factory |

So the change is additive but **spans the compiler and the target layer**, not just
the factory: the compiler owns *validating* the namespace + variant name; the
factory/target own *resolving* `work:<variant>` to an asset dir and booting it.
`gondolin` stays the stock download (today's path, no `imagePath`).

### Resolution + arch-awareness

- An **image registry/config** maps `work:<variant> → images/<variant>/out` (and
  could let a workflow/repo register more). Resolution should fail fast with a
  `UserFacingError` ("image 'work:node-25' not built — run `npm run build:images`")
  when the asset dir is missing — mirroring the existing optional-dependency /
  missing-QEMU handling in `provision()`. (Note today the factory throws a bare
  `Error` for an unknown `runs-on`; variant-resolution failures should be
  `UserFacingError` so
  `main()` prints them cleanly.)
- The asset dir is **per-arch**, so resolve to the `images/<variant>/out` built for
  the current host arch (CI builds x86_64; local mac builds aarch64). Don't cache
  across arches.

### CI pipeline

Slots into the **existing** `.github/workflows/ci.yml`, which today has two jobs:
`lint-and-typecheck` (lint + typecheck + knip + fan-in) and `test` (full suite incl.
gondolin VMs; installs QEMU, enables KVM, and already **caches the guest image** via
`actions/cache` on `~/.cache/gondolin/images`). Custom images extend this with a
`build-images` job that `test` then `needs:` — building needs no KVM, so it can run
ahead of (or beside) the QEMU work. The image build artifacts join, or extend the
key of, that same gondolin-image cache. (The repo *also* dog-foods its own engine in
`.workflows/ci.yaml` — lint/typecheck/knip as gondolin jobs — but that one can't
build images yet; image-building stays in the GitHub-Actions CI until the engine
itself can drive it.)

A `build-images` job (ubuntu-latest, Node ≥ 23.6 — the repo pins Node 25 in CI):

```yaml
build-images:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v6
    - uses: actions/setup-node@v6
      with: { node-version: "25" }
    - run: sudo apt-get update && sudo apt-get install -y lz4 cpio e2fsprogs
    - run: npm ci
    - run: |
        for img in base node-25 go-1.26 python-3.13 devops; do
          npx @earendil-works/gondolin build \
            --arch x86_64 \
            --config images/$img/build-config.json \
            --output images/$img/out
        done
    - uses: actions/upload-artifact@v4
      with: { name: gondolin-images, path: images/*/out }
```

The existing `test` job gains `build-images` to its `needs:` (becoming
`needs: [lint-and-typecheck, build-images]`), downloads the artifact, and runs the
e2e suite (with `work:node-25`/`work:go-1.26` examples). Add `sudo` to the build
step only if an image uses `postBuild.commands`. Because `buildId` is
content-addressed, the cleanest caching is `actions/cache` keyed on
`hashFiles('images/**/build-config.json')` — folding image builds into the same
cache step the `test` job already uses for `~/.cache/gondolin/images`.

### Local dev — build on the host, on clone/init

Images are **not committed and not distributed** — they're built on each
developer's machine for that machine's architecture. The flow is: clone the repo,
then run an init/build step (not built yet) that compiles each `images/<variant>/`
for the **host arch** (native — no `--arch`, no cross-build, no container):

```bash
npm run build:images   # (future) gondolin build --config images/<variant>/build-config.json --output images/<variant>/out
```

First build downloads apks + krun assets (cached at `~/.cache/gondolin/images/`);
subsequent builds are fast and content-addressed. `images/*/out` is gitignored.
Because output is arch-specific, a Mac (aarch64) and CI (x86_64) each build their
own — never share or commit the built assets.

---

## 7. Open questions / `UNVERIFIED`

- **Build time/size** numbers are undocumented (`UNVERIFIED`); measure on first build.
- **`postBuild.commands` in CI** need root or `container.force=true` — decide per
  image whether to keep images package-only (no root) for simplicity.
- **Per-arch matrix.** If we want the same images usable on Apple-Silicon dev and
  x86_64 CI, the build must run per-arch; the engine must resolve the right
  arch's asset dir. (Cross-building aarch64 on x86_64 "may use a container.")
- **Rootfs mode for ephemeral jobs.** `runtimeDefaults.rootfsMode: "readonly"`
  (or per-VM `cow`/`memory`) suits disposable CI VMs; confirm against our
  one-VM-per-job model.

---

## Sources

- Custom images: https://earendil-works.github.io/gondolin/custom-images/ ·
  https://raw.githubusercontent.com/earendil-works/gondolin/main/docs/custom-images.md
- Storage / image selection / `imagePath` / cache dir:
  https://earendil-works.github.io/gondolin/sdk-storage/ ·
  https://raw.githubusercontent.com/earendil-works/gondolin/main/docs/sdk-storage.md
- Backends (arch, qemu vs krun): https://raw.githubusercontent.com/earendil-works/gondolin/main/docs/backends.md
- Built-in image registry (manifest schema): https://raw.githubusercontent.com/earendil-works/gondolin/main/builtin-image-registry.json
- Build internals + CI (verified from repo source): `host/src/build/native.ts`,
  `host/src/alpine/packages.ts`, `host/src/alpine/utils.ts`, `images/alpine-base.json`,
  `host/examples/llm.json`, `.github/workflows/image-release.yml`,
  `.github/workflows/ci.yml` — https://github.com/earendil-works/gondolin
- SDK / VM: https://earendil-works.github.io/gondolin/sdk/ ·
  https://earendil-works.github.io/gondolin/sdk-vm/
- Package version: https://registry.npmjs.org/@earendil-works/gondolin/latest (0.12.0)
