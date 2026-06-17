# Custom images

Every job runs in a Gondolin micro-VM. **`runs-on`** picks which guest image boots
inside it — the stock guest, the bundled `work:base`, or a custom image you define.
Reach for a richer image when your jobs need tools the stock guest doesn't ship.

## `work:base` vs the stock guest

- **`work:base`** — a bundled image that adds **git** and **jq** on top of the
  stock guest, and **the default when you omit `runs-on`**. It's built on first use
  (then cached), so a checkout or a `jq` filter works out of the box.
- **`gondolin`** — the stock guest, and nothing more. It ships `sh`/`bash`,
  `node`/`npm`, `python3`, `curl`, and `ca-certificates`, and boots immediately
  (nothing to build) — pin it explicitly when those tools are enough and you want
  the leanest image.

```yaml
jobs:
  build:
    runs-on: work:base
    steps:
      - run: git --version && npm test
```

## Defining your own image

When you need more — a compiler, a CLI, a system library — define your own image:
drop a Gondolin **build-config** at `.workflows/images/<name>/build-config.json`,
then reference it as `runs-on: work:<name>`.

```
my-project/
  .workflows/
    images/
      tools/
        build-config.json     # → runs-on: work:tools
```

A build-config is Gondolin's own format. List the Alpine packages your jobs need
under `rootfsPackages`; leave `arch` out so the engine builds for the host
architecture:

```json
// .workflows/images/tools/build-config.json
{
  "distro": "alpine",
  "alpine": {
    "version": "3.23.0",
    "kernelPackage": "linux-virt",
    "kernelImage": "vmlinuz-virt",
    "rootfsPackages": ["linux-virt", "rng-tools", "bash", "ca-certificates", "e2fsprogs", "git", "ripgrep", "go"],
    "krunfwVersion": "v5.2.1"
  },
  "rootfs": { "label": "gondolin-root" }
}
```

```yaml
jobs:
  build:
    runs-on: work:tools
    steps:
      - run: rg --version && go version
```

A user image under `.workflows/images/<name>/` **overrides** a bundled one of the
same name, so you can extend or replace `work:base` for your project. See Gondolin's
[custom-images documentation](https://earendil-works.github.io/gondolin/custom-images/)
for the full build-config field list.

### Example: a runner that boots nested VMs

The project dogfoods this feature to run its **own e2e suite self-hosted**:
`work:nested` is just `work:base` plus QEMU, so a job on it can boot *nested*
gondolin micro-VMs (no `/dev/kvm` inside a guest, so they run under TCG software
emulation automatically). The whole image is two extra packages:

```json
// .workflows/images/nested/build-config.json
{
  "distro": "alpine",
  "alpine": {
    "version": "3.23.0",
    "kernelPackage": "linux-virt",
    "kernelImage": "vmlinuz-virt",
    "rootfsPackages": ["…the work:base packages…", "qemu-system-aarch64", "qemu-img"]
  },
  "rootfs": { "label": "gondolin-root" }
}
```

See [Dogfooding → test](../examples/dogfooding#test-the-suite-runs-itself-nested)
for how it runs the full test suite inside nested VMs.

## Built on first use

A `work:<image>` is **built the first time a job uses it** on a given machine, then
reused — Gondolin builds the image and keeps it in its local image store. So:

- The first run that needs the image takes a few minutes and needs **network** to
  fetch its packages.
- Every run after that boots the already-built image instantly.
- Building is per-machine and per-architecture — CI builds its own copy on first use.

::: tip Image and size are independent
`runs-on` chooses the *image*; [`machine`](./writing-workflows#machine-sizing-the-vm)
chooses the VM's CPU and memory. Any image runs on any machine size.
:::
