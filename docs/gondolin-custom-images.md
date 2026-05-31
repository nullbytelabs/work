# Gondolin Custom Images — Research + Design Sketch

Research for giving `runs-on: gondolin` real toolchains (node, python, …) via
**custom guest images**, instead of the no-frills Alpine default. Verified
against the Gondolin docs and the `earendil-works/gondolin` repo (source + its
own CI). Items that couldn't be confirmed are flagged `UNVERIFIED`.

> **Gondolin version at time of research:** `@earendil-works/gondolin@0.12.0`
> (Apache-2.0, Node ≥ 23.6, CLI bin `gondolin`, Alpine 3.23.0 default). Pre-1.0,
> so treat the API surface as stabilizing rather than frozen.

> **Status:** design sketch — **not** Phase 1. The engine work below is a
> Phase 2+ enhancement. This doc records the capability and a concrete plan.

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

### `runs-on` variants → images

```
runs-on: gondolin          # base: built-in alpine-base (no custom build, just download)
runs-on: gondolin:base     #   explicit synonym for the above
runs-on: gondolin:node     # custom image with node + npm
runs-on: gondolin:python   # custom image with python3 + uv + pip tooling
```

Parse the `runs-on` string as `target[:variant]`. `gondolin` / `gondolin:base`
→ the stock image (today's behavior, no build needed). `gondolin:<variant>` →
boot from that variant's built asset dir via `sandbox.imagePath`.

### Image definitions: `images/<name>/build-config.json`

Mirror the `test/e2e/<name>/` convention — one folder per image:

```
images/
├── node/
│   └── build-config.json     # rootfsPackages: [ …, nodejs, npm ]
├── python/
│   └── build-config.json     # rootfsPackages: [ …, python3, py3-pip, uv ]
└── README.md
```

(The flat `images/node-build-config.json` form the original idea suggested also
works — `--config` takes any path. A folder per image leaves room for
`postBuild.copy` source files to sit next to their config, and matches the e2e
layout.) Built output goes to `images/<name>/out/` (gitignored) or a cache dir —
never committed (arch-specific, large).

### Engine integration (small, additive)

- `GondolinTargetConfig` gains `imagePath?: string`; `provision()` passes
  `sandbox: { imagePath }` to `VM.create` when set (omit → built-in default).
- The factory resolves `gondolin:<variant>` → the variant's asset dir. An
  **image registry/config** maps variant → `images/<variant>/out` (and could let
  a workflow/repo register more). Resolution should fail fast with a
  `UserFacingError` ("image 'node' not built — run `npm run build:images`") when
  the asset dir is missing, mirroring the existing missing-dependency handling.
- Arch-awareness: the asset dir is per-arch, so resolve to
  `images/<variant>/out` built for the current host arch (CI builds x86_64; local
  mac builds aarch64). Don't cache across arches.

### CI pipeline

A `build-images` job (ubuntu-latest, Node ≥ 23.6):

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
        for img in node python; do
          npx @earendil-works/gondolin build \
            --arch x86_64 \
            --config images/$img/build-config.json \
            --output images/$img/out
        done
    - uses: actions/upload-artifact@v4
      with: { name: gondolin-images, path: images/*/out }
```

The `test` job `needs: [build-images]`, downloads the artifact, and runs the e2e
suite (with `gondolin:node`/`gondolin:python` examples). Add `sudo` to the build
step only if an image uses `postBuild.commands`. Optionally swap upload-artifact
for `actions/cache` keyed on `hashFiles('images/**/build-config.json')`.

### Local dev — build on the host, on clone/init

Images are **not committed and not distributed** — they're built on each
developer's machine for that machine's architecture. The flow is: clone the repo,
then run an init/build step (not built yet) that compiles each `images/<name>/`
for the **host arch** (native — no `--arch`, no cross-build, no container):

```bash
npm run build:images   # (future) gondolin build --config images/<name>/build-config.json --output images/<name>/out
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
