# Requirements

work runs every job inside a [Gondolin](https://www.npmjs.com/package/@earendil-works/gondolin)
micro-VM — there is no host-execution mode — so it needs a modern Node and QEMU.

## Prerequisites

| Requirement | Why |
|---|---|
| **Node.js ≥ 23.6** | The `work` command refuses to start on anything older. |
| **QEMU** | Every job runs in the `gondolin` micro-VM, which QEMU powers. macOS works out of the box (HVF); Linux needs KVM for hardware acceleration. |
| **macOS or Linux** | The supported host platforms. |

## Installing QEMU

::: code-group

```bash [macOS]
brew install qemu
```

```bash [Linux (Debian/Ubuntu)]
sudo apt-get update
sudo apt-get install -y qemu-system-x86 qemu-utils
```

:::

On Linux, hardware acceleration uses **KVM** — make sure `/dev/kvm` exists and your
user can access it. On macOS, acceleration uses **HVF** and needs no extra setup.

## The guest image

The first sandboxed run downloads a **~200 MB guest image** (cached afterwards, so
subsequent runs start immediately). The guest ships `sh`, `bash`, `node`, `npm`,
and `python3` — so your steps run without any host toolchain installed.

::: tip Verify your machine
Once installed, run [`work doctor`](../reference/cli#work-doctor) to check Node,
QEMU, hardware acceleration, and the guest image cache in one shot. It's read-only
and prints the exact remediation command for anything that's missing.
:::
