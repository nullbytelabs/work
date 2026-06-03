# Installation

pi-workflows ships as the npm package [`@nullbytelabs/work`](https://www.npmjs.com/package/@nullbytelabs/work).
There's no clone and no build step.

::: warning Before you start
You still need **Node ≥ 23.6** and **QEMU** on your machine — see
[Requirements](./requirements). Installing the package doesn't install those.
:::

## With npx (no install)

Run it once without installing anything; npm fetches it on first use:

```bash
npx @nullbytelabs/work --help
```

## Global install

Put the `work` command on your `PATH` for good:

```bash
npm i -g @nullbytelabs/work
work --help
```

This gives you the `work` command and its alias `workflow` (both point at the same
engine). Throughout these docs we use `work`.

## From source (development)

To hack on the engine itself, clone the repo and use the dev launcher, which runs
the TypeScript directly — no build:

```bash
git clone https://github.com/nullbytelabs/pi-workflows
cd pi-workflows
npm install
./pi-workflows --help
```

## Verify your setup

Confirm your machine can actually run sandboxed jobs:

```bash
work doctor
```

It checks Node, the Gondolin SDK, QEMU, hardware acceleration, and whether the
guest image is cached — printing the exact fix for anything that fails. See the
[`doctor` reference](../reference/cli#work-doctor) for the full check list.

Next: write and run your first workflow in the [Quickstart](./quickstart).
