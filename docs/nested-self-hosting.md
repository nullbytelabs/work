# Nested self-hosting: running the e2e suite inside work

## What and why

The repository dogfoods its own pipelines (`work run ci` → `checks` → `test` →
`review`). For a long time the `test` pipeline could only run the **non-VM**
`test:unit` tier in-guest, because the real-VM e2e tier needs QEMU and a guest
image — and "QEMU inside a QEMU guest" sounded like it needed nested hardware
virtualization that isn't generally available.

It turns out it doesn't. `work run test` now runs the **entire** suite — including
the real-VM e2e tier — **self-hosted**: the outer job boots a `work:nested` guest,
and `npm test` inside it boots the e2e examples as **nested gondolin micro-VMs**.
`work` tests its own VM layer with `work`, on one machine, no external CI.

## How it works

**TCG fallback, no nested-virt required.** gondolin's accelerator selection
(`selectAccel` in the SDK) picks KVM/HVF when available and otherwise falls back to
TCG (software emulation). Inside a gondolin guest there is no `/dev/kvm`, so the
*inner* VMs select TCG automatically. No engine change, no nested-hardware
requirement — TCG is slow but runs anywhere. (On a host whose hardware + hypervisor
expose nested virt the inner VMs could be accelerated, but we don't rely on it.)

**The runner image.** `work:nested`
(`.workflows/images/nested/build-config.json`) is just `work:base` plus two stock
Alpine packages: `qemu-system-aarch64` and `qemu-img`. Nothing machine-specific is
baked in; it builds identically on any host of the same arch. An earlier iteration
baked the guest image into the runner from a hardcoded host path — a premature
optimization that made the image non-portable; it was removed. The inner VMs simply
download `alpine-base` once over the job's (open, by-design) egress and reuse it for
the run (the cache lives in the outer guest).

**The workflow.** `.workflows/test.yaml` runs on `work:nested` with a roomy outer
`machine:` (≈ 64 GB), and runs `npm test` with `WORK_SKIP_VM=""` (so the VM tier
runs) and `WORK_NESTED=1` (see below). `continue-on-error` keeps the job green so
the result still flows to `review`, mirroring `checks`.

## Trade-offs and known limits

- **Resource floor.** The outer VM must hold the peak of several concurrent inner
  VMs (each defaulting to 8 GB), hence ≈ 64 GB. Leaner hosts can shrink the outer
  `machine:` and override the inner examples to smaller sizes, trading inner
  parallelism for footprint.
- **Speed.** TCG inner VMs are ~10× slower than accelerated, but the suite still
  completes in a few minutes because each inner job is small.
- **Mediated-egress test skips nested.** `egress-e2e` binds an on-box "model host"
  on a non-loopback IP and relies on the host-side stack dialing back to it. Nested,
  the inner and outer VMs share gondolin's `192.168.127.0/24` guest subnet, so that
  address (the outer guest's own `.3`) means "myself" to the inner guest and the
  request never escapes. The two assertions that need the dial-back skip when
  `WORK_NESTED=1`; the core property (*the real key never enters the guest*) still
  runs nested, and the full contract stays verified on bare metal (host + GitHub
  Actions). The real fix is upstream: gondolin's `QemuNetworkBackend` hardcodes the
  guest subnet and doesn't expose `vmIP`/`gatewayIP` via `VM.create`, so there is no
  host-side way to give the inner VMs a distinct subnet today.

## Relationship to GitHub Actions

Unchanged and independent. `.github/workflows/ci.yml` runs `npm test` directly on
the runner (with `/dev/kvm` enabled via a udev rule) — it does **not** go through
`work run`, so the nested dogfood path doesn't affect the hard CI gate. Nested
self-hosting is a demonstration that the engine can run its own full suite without
external CI, not a replacement for that gate.
