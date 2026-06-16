---
layout: home

hero:
  name: "work"
  text: "Sandboxed workflows with agents built in"
  tagline: Define a workflow in YAML and run it on your own machine — every job isolated in a secure micro-VM, execution durable and crash-resumable, and any step able to hand off to a real AI agent working inside the sandbox.
  image:
    light: /logo.svg
    dark: /logo-dark.svg
    alt: A directed-acyclic-graph of jobs
  actions:
    - theme: brand
      text: Get started
      link: /guide/introduction
    - theme: alt
      text: Quickstart
      link: /guide/quickstart
    - theme: alt
      text: View on GitHub
      link: https://github.com/nullbytelabs/work

features:
  - icon:
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"/><circle cx="12" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><circle cx="20" cy="12" r="2"/><path d="M5.7 10.8 10.3 7.2M5.7 13.2 10.3 16.8M13.7 7.2 18.3 10.8M13.7 16.8 18.3 13.2"/></svg>'
    title: Any workflow
    details: Build-and-test, data processing, scheduled automation, deploys — anything you'd otherwise script. A small YAML surface of jobs, steps, dependencies, matrices, and conditionals.
    linkText: Writing a workflow
    link: /guide/writing-workflows
  - icon:
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/><path d="M11 7h4a2 2 0 0 1 2 2v4"/></svg>'
    title: Compose, don't copy-paste
    details: "A job can call another whole workflow with `uses: workflow/<name>`, so a shared lint or build sequence lives in one file and your pipelines reference it — inlined into one graph at compile time."
    linkText: Reusable workflows
    link: /guide/reusable-workflows
  - icon:
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><rect x="8" y="8" width="8" height="8" rx="1.5"/></svg>'
    title: Isolated micro-VMs
    details: Every job runs in its own Gondolin micro-VM with mediated egress, sized per job with machine types (small to xlarge, or custom cpus/memory). There is no host-execution mode — your steps never touch the host directly.
    linkText: How it works
    link: /guide/how-it-works
  - icon:
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v4h-4"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>'
    title: Durable by default
    details: A workflow compiles to a graph of durable tasks journaled to an in-process Postgres. Jobs run in parallel as their dependencies clear.
    linkText: How it works
    link: /guide/how-it-works
  - icon:
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 8.5l3.2 7 1.3-2.9 2.9-1.3z"/></svg>'
    title: Agents as steps
    details: Strap a real AI agent to any step. It runs inside the job's sandbox, rooted at the checkout with its full toolset — reading, editing, and deciding — while your API key never enters the guest.
    linkText: Agent steps
    link: /guide/agent-steps
  - icon:
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 8.5h18"/><path d="M10 12l4 2.5-4 2.5z"/></svg>'
    title: Local serve host
    details: "`work serve` boots a loopback host — a browser console to run workflows from a form and watch them stream live, plus durable history, an authenticated webhook receiver, and a cron scheduler — no extra dependencies, nothing leaves your machine."
    linkText: The serve host
    link: /guide/web-ui
---
