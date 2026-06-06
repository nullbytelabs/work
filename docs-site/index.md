---
layout: home

hero:
  name: "pi-workflows"
  text: "Sandboxed workflows with agents built in"
  tagline: Define a workflow in YAML and run it on your own machine — every job isolated in a secure micro-VM, execution durable and crash-resumable, and any step able to hand off to a real AI agent working inside the sandbox.
  image:
    src: /logo.svg
    alt: pi-workflows
  actions:
    - theme: brand
      text: Get started
      link: /guide/introduction
    - theme: alt
      text: Quickstart
      link: /guide/quickstart
    - theme: alt
      text: View on GitHub
      link: https://github.com/nullbytelabs/pi-workflows

features:
  - icon: 🧩
    title: Any workflow
    details: Build-and-test, data processing, scheduled automation, deploys — anything you'd otherwise script. A small YAML surface of jobs, steps, dependencies, matrices, and conditionals.
    linkText: Writing a workflow
    link: /guide/writing-workflows
  - icon: 🔒
    title: Isolated micro-VMs
    details: Every job runs in its own Gondolin micro-VM with mediated egress, sized per job with machine types (small to xlarge, or custom cpus/memory). There is no host-execution mode — your steps never touch the host directly.
    linkText: How it works
    link: /guide/how-it-works
  - icon: ♻️
    title: Durable by default
    details: A workflow compiles to a graph of durable tasks journaled to an in-process Postgres. Jobs run in parallel as their dependencies clear.
    linkText: How it works
    link: /guide/how-it-works
  - icon: 🤖
    title: Agents as steps
    details: Strap a real AI agent to any step. It runs inside the job's sandbox, rooted at the checkout with its full toolset — reading, editing, and deciding — while your API key never enters the guest.
    linkText: Agent steps
    link: /guide/agent-steps
  - icon: 🖥️
    title: Local web console
    details: "`work --web` opens a loopback browser UI to run workflows from a form, watch them stream live, browse durable history, and receive authenticated webhook triggers — no extra dependencies, nothing leaves your machine."
    linkText: Web console
    link: /guide/web-ui
---
