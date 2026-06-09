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
> subsystem (registry + tag build), the target/runtime/run.ts wiring, and packaging
> (`dist/image-builtin/`). **Not yet:** the `work image build|ls` CLI (build is lazy
> on first use, so it's optional), and flipping `DEFAULT_RUNS_ON`.
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

## 3. Design for pi-workflows

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

### Engine integration points (verified against current code)

`runs-on` is an opaque exact-match string today, so two call-sites **reject**
`work:<variant>` and a third should treat it as explicit. The runtime threads `job.runsOn`
verbatim and already supports a `makeTarget` override + a `resolveJobNetwork` forward.

| Where | Today | Needs |
|---|---|---|
| `src/compiler/compile.ts` — `validateRunsOn()` | throws for anything but `gondolin` | also accept `work:<variant>` (shape only; keep the `local`-removed message) |
| `src/compiler/compile.ts` — `runsOnWarning()` | only an *omitted* `runs-on` warns | treat explicit `work:<variant>` as explicit (no nag) |
| `src/targets/factory.ts` — `makeTarget()` | throwing exact-match `switch` | parse `namespace[:variant]`; `gondolin` → stock; `work:<variant>` → resolve+build → `imagePath` |
| `src/targets/gondolin.ts` — `GondolinTargetConfig` + `provision()` | flat `createOpts`, no image hook | add `resolveImagePath?`; when set, `await` it → add `sandbox: { imagePath }` to `createOpts` |
| `src/runtime/absurd/runtime.ts` (~`:297`) | forwards `runsOn` + network to `makeTarget` | add an optional `resolveImagePath` forward (mirrors `resolveJobNetwork`) |

`run.ts` composes the resolver (workspace → resolve build-config → `gondolin build` →
`imagePath`) and passes it as `resolveImagePath`, the same place it composes the egress
resolvers. Tests keep injecting a `makeTarget` double, so they never build images.

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
- Flipping `DEFAULT_RUNS_ON` to `work:base` (revisit once the build path is proven).

---

## 4. Implementation steps (unstarted)

Ordered; each part is independently testable. File refs are the §3 table.

**A. `work:*` grammar (compiler, no I/O).**
- `src/targets/runs-on.ts` (new) — `parseRunsOn(value): { namespace: "gondolin" | "work";
  variant?: string }` (kebab variant); shared by compiler + factory.
- `src/compiler/compile.ts` — `validateRunsOn` accepts `gondolin` and `work:<variant>`
  (shape only; existence/build is a runtime concern); keep the `local`-removed message.
  `runsOnWarning` treats an explicit `work:<variant>` as explicit (no nag).

**B. `src/images/` subsystem (mirror `src/actions/`).**
- `registry.ts` — `resolveImageConfig(variant, workspaceSource)`: find the build-config,
  **user-space** (`<workspaceSource>/.workflows/images/<variant>/build-config.json`) first,
  then **bundled** (`new URL("./builtin", import.meta.url)/<variant>/`); `UserFacingError`
  + available-list on miss. `listImages(workspaceSource)` for the CLI.
- `build.ts` — `ensureImageBuilt(buildConfigPath, arch): Promise<string>`: the output dir
  is a per-variant/per-arch dir the engine owns; reuse it if it has `manifest.json`, else
  **spawn `gondolin build --config <buildConfigPath> --output <dir> --arch <arch>`** (resolve
  the bin from the installed `@earendil-works/gondolin`; stream output). An in-process
  promise map prevents concurrent jobs double-building. `UserFacingError` if the bin is
  absent. No content-hash/cache abstraction — reuse-if-present, else ask Gondolin.
  (`process.arch`: `arm64→aarch64`, `x64→x86_64`.)
- `builtin/base/build-config.json` — **`work:base`**, package-only (`rootfsPackages`: stock
  defaults + `git`, `jq`, `curl`, `bash`, `ca-certificates`). `index.ts` — barrel.

**C. Boot from the image (target + runtime forward).**
- `src/targets/gondolin.ts` — `GondolinTargetConfig.resolveImagePath?: () => Promise<string
  | undefined>`; `provision()` awaits it and adds `sandbox: { imagePath }` to `createOpts`
  when set (absent → stock).
- `src/targets/factory.ts` — `makeTarget` parses `runs-on`; `work:<variant>` wires
  `resolveImagePath` from a new `TargetContext.resolveImagePath`.
- `src/runtime/absurd/runtime.ts` — add an optional `resolveImagePath` forward into the
  `TargetContext` (mirrors `resolveJobNetwork`).
- `src/run.ts` — compose the resolver (`opts.workspaceSource` + host arch →
  `resolveImageConfig` → `ensureImageBuilt`) and pass it as `resolveImagePath`. Tests keep
  their `makeTarget` double, so they never build.

**D. CLI + packaging.**
- `src/cli.ts` dispatch `work image build [<name>]` / `work image ls` (`src/images/cli.ts`,
  thin wrappers over B). `scripts/build.mjs` — `cp(src/images/builtin → dist/images/builtin)`.
  No doctor build-tool probing — defer to Gondolin.

**E. Dogfood + docs.**
- `test/e2e/work-base-image/` — `runs-on: work:base`, a `run:` step asserting
  `git --version && jq --version`; gate the real build behind `WORK_TEST_IMAGES=1` (network
  + time), like the network-gated examples. Flip this doc's status to "implemented" for
  what ships.

## 5. Verification

Per project memory, verify against a **real run**, not just the suite.

1. `npm run typecheck`, `lint`, `knip` clean.
2. **Unit:** `parseRunsOn`; `validateRunsOn` accepts `work:<variant>` / rejects junk;
   `runsOnWarning` silent for `work:`; registry resolution (user overrides bundled, unknown
   → list); `ensureImageBuilt` reuse-if-present with a faked spawn (no real build in unit).
3. **Real:** `./bin/pi-workflows.mjs image build base` runs `gondolin build` and produces
   the asset dir; `image ls` shows it built. Then a real run of `test/e2e/work-base-image`
   boots `work:base` in-VM and `git --version` / `jq -V` pass.
4. **Regression:** an existing `runs-on: gondolin` e2e still runs unchanged.
5. **Packaging:** `npm run build` → `dist/images/builtin/base/build-config.json` present;
   then `rm -rf dist` (dist shadows src for the shim).
6. Full `npm test` (Node 25 via fnm + QEMU).
