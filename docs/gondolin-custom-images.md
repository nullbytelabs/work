# Gondolin Custom Images — `work:*` design

Give jobs real toolchains (a more-capable base, node, go, a devops kit, …) via
**Gondolin's own custom-image mechanism**. There is exactly one path, and it is
Gondolin's:

1. **Build** — `gondolin build --config <build-config.json> --output <dir>`. Gondolin
   is the only builder; the SDK has no build API. We never assemble a rootfs ourselves
   and never reason about how Gondolin builds it — we shell out to `gondolin build`.
2. **Select** — `VM.create({ sandbox: { imagePath: <dir> } })`. The SDK boots a built
   asset directory by path. This is the single hook our `GondolinTarget` gains.

> **Gondolin version:** `@earendil-works/gondolin@0.12.0` (CLI bin `gondolin`,
> Node ≥ 23.6). Confirmed against the installed package: `VMOptions.sandbox.imagePath`
> exists (`vm/types.d.ts`, `sandbox/server-options.d.ts`); `gondolin build` takes
> `--config`/`--output`/`--arch`. Official docs:
> https://earendil-works.github.io/gondolin/custom-images/

> **Status:** **implemented** for `work:base` — `runs-on: work:base` builds the
> bundled image on first use and boots it (git/jq over the stock guest), proven by
> a real run + the gated `test/e2e/work-base-image/` example (`WORK_TEST_IMAGES=1`).
> Done: the `work:*` grammar (`src/compiler/runs-on.ts`), the `src/images/`
> subsystem (registry + tag build), the target/runtime/run.ts wiring, packaging
> (`dist/image-builtin/`), and flipping `DEFAULT_RUNS_ON` to `work:base` (the
> default when a job omits `runs-on`). **Not yet:** the `work image build|ls` CLI
> (build is lazy on first use, so it's optional).
>
> **Key change vs. the original design:** gondolin 0.12.0 added a **tagged local
> image store**. We `gondolin build --config <cfg> --tag work:<variant>` (no
> `--output` dir to manage) and boot via the image **selector** `imagePath:
> "work:<variant>"`. So `ensureImageTag` just builds-if-absent (checked via
> `gondolin image ls`) and returns the selector — no per-arch output-dir caching of
> our own. Build-configs ship **arch-agnostic** (no `arch` field); the engine
> injects the host arch before `gondolin build` (gondolin requires it). The bundled
> dir is `src/images/image-builtin/` (a name distinct from the actions' `builtin/`,
> since esbuild bundles both `new URL("./…", import.meta.url)` under `dist/`).

---

## 1. The build-config (Gondolin's format)

A custom image is one declarative JSON file (scaffold with `gondolin build --init-config`).
The fields we use:

```json
{
  "arch": "aarch64",
  "distro": "alpine",
  "alpine": {
    "version": "3.23.0",
    "rootfsPackages": ["bash", "ca-certificates", "curl", "git", "jq"]
  }
}
```

- `alpine.rootfsPackages` — apk packages from Alpine `main`+`community`. This is where
  `git`/`jq`/`nodejs`/`python3`/… go.
- `postBuild.commands` / `postBuild.copy` — for anything not in apk (`npm i -g …`,
  fetch a pinned tarball). Optional; `work:base` is package-only.
- `oci.image` — escape hatch to base on an OCI image instead of apk packages.

See Gondolin's docs for the full field list and for any host requirements of
`gondolin build` itself — those are Gondolin's concern, not ours.

## 2. Build → select (the only two commands)

```bash
gondolin build --config build-config.json --output ./out   # build (host arch)
# → ./out/ holds manifest.json + boot assets
```

```ts
const vm = await VM.create({ sandbox: { imagePath: "./out" } });  // boot it
```

CLI equivalent for selection: `GONDOLIN_GUEST_DIR=./out gondolin bash`. Output dirs are
**per-arch** (Apple-Silicon builds aarch64, x86_64 CI builds x86_64); never commit them.

---

## 3. Design for work

### Two namespaces: `gondolin` (stock) vs `work:*` (ours)

The `runs-on` target name encodes who maintains the image:

```
runs-on: gondolin          # the untouched upstream guest — no build, today's behavior
runs-on: work:base         # our more-capable base (git, curl, jq, bash, ca-certs …)
runs-on: work:node-25      # work:base + Node 25 + npm
runs-on: work:devops       # work:base + kubectl, helm, awscli, gcloud, terraform …
```

- **`gondolin`** → stock upstream image, no `imagePath` (the escape hatch).
- **`work:<variant>`** → a build-config we ship/resolve, built via `gondolin build`,
  booted via `imagePath`. `work:base` is the blessed floor; other `work:*` extend it.

Pi already runs in-guest on the stock image, so there is no `work:pi` — the namespace is
about toolchains for `run:` steps, not the agent.

### Where image definitions live

One folder per image, holding a Gondolin build-config:

```
src/images/builtin/base/build-config.json   # work:base — bundled in the package
.workflows/images/<name>/build-config.json  # user-defined → work:<name>
```

Resolution: a `work:<variant>` resolves user-space (`.workflows/images/<variant>/`) first,
then the bundled built-ins — exactly how built-in vs user **actions** resolve today
(`src/actions/load.ts`). `work:base` is dogfood: authored as an ordinary build-config and
built through the same `gondolin build` path a user image is.

### Building & selecting (engine-side, all via Gondolin)

- The engine runs `gondolin build --config <resolved build-config> --output <dir>` to
  produce the asset directory, then constructs the `GondolinTarget` with
  `imagePath: <dir>`. Building is **lazy** (a job using `work:<variant>` triggers the
  build on first use, skipped if the output dir already has a `manifest.json`), plus an
  explicit `work image build [<name>]` to pre-warm and `work image ls` to list.
- The output `<dir>` is a per-variant, per-arch directory the engine owns; we do not
  build our own caching/registry layer on top — if Gondolin's output is present we reuse
  it, otherwise we ask Gondolin to build it.

### Engine integration points (as shipped)

The `work:*` grammar lives in `src/compiler/runs-on.ts` (shared by compiler and
factory); `makeTarget` (`src/targets/factory.ts`) maps `work:<variant>` to a
resolved+built image selector; `GondolinTarget` gains a `resolveImagePath` hook
that adds `sandbox: { imagePath }` at provision time; the runtime forwards it the
same way it forwards `resolveJobNetwork`. `run.ts` composes the resolver
(workspace → resolve build-config → `gondolin build` → selector) in the same
place it composes the egress resolvers. Tests inject a `makeTarget` double, so
they never build images.

### CLI, doctor, packaging

- `work image build [<name>]` / `work image ls` — thin wrappers over the resolver +
  `gondolin build` (dispatched in `src/cli.ts` alongside `doctor`/`create`/`init`).
- `scripts/build.mjs` copies `src/images/builtin` → `dist/images/builtin` so bundled
  build-configs ship (mirrors the built-in-actions copy).
- Doctor: a `gondolin build` smoke/availability check is optional and deferred to
  Gondolin — we don't probe Gondolin's internal build tools.

### Out of scope
- `work:go-*`/`work:python-*`/`work:devops` images (each is just a new build-config, no
  engine change once the mechanism lands).
- Cross-arch builds; any image distribution/registry (we build locally per arch via
  `gondolin build`).

The implementation lives in `src/images/` (registry + lazy tag build, mirroring
`src/actions/`), with the e2e proof in `test/e2e/work-base-image/`
(gated behind `WORK_TEST_IMAGES=1` — real build, network + time).
