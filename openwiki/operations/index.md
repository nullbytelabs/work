---
type: Documentation Index
title: "Operations"
description: "Files and subdirectories in Operations."
---

# Files

- [CLI Tools — Doctor, Graph, Scaffold, Init, TUI](cli-tools.md) - Reference for the supporting `work` CLI tools — `work doctor` preflight checks, `work graph` DAG export, `work create` scaffolding generators, project init, and the terminal UI (TUI). Covers flags, exit codes, output formats, and source locations.
- [Configuration (`work.json`)](config.md) - Reference for the `work.json` project configuration file — providers, models, secrets, webhooks, and observability. Documents the full WorkConfig schema and how it feeds the agent egress resolver, webhook receiver, scheduler, and telemetry bootstrap.
- [Serving, Triggers & Observability](serve-and-triggers.md) - Guide to `work serve` — the long-lived local host providing a browser console, authenticated webhook receiver, and cron scheduler. Covers the web server security posture (CSRF, DNS-rebinding, body caps), API routes, RunManager, triggers, and observability.
