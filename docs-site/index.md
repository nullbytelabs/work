---
layout: home

hero:
  name: "pi-workflows"
  text: "CI on your own machine"
  tagline: GitHub-Actions-style workflows where each job runs in its own secure micro-VM — durable, crash-resumable, and able to hand work to a real AI coding agent inside the sandbox.
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
  - icon: 🧱
    title: Familiar YAML
    details: Jobs, steps, needs, env, inputs, outputs, matrix, conditionals — it mirrors GitHub Actions, so most of it already looks familiar.
    linkText: Writing a workflow
    link: /guide/writing-workflows
  - icon: 🔒
    title: Isolated micro-VMs
    details: Every job runs in its own Gondolin micro-VM with mediated egress. There is no host-execution mode — your steps never touch the host directly.
    linkText: How it works
    link: /guide/how-it-works
  - icon: ♻️
    title: Durable by default
    details: A workflow compiles to a graph of durable tasks journaled to an in-process Postgres. Jobs run in parallel as their dependencies clear.
    linkText: How it works
    link: /guide/how-it-works
  - icon: 🤖
    title: AI agent steps
    details: A step can hand work to a real Pi coding agent running inside the job's sandbox — rooted at the checkout, with your API key never entering the guest.
    linkText: Agent steps
    link: /guide/agent-steps
---
