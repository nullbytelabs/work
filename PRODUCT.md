# Product

## Register

product

## Users

Developers and platform/infra engineers running workflows on their own machines.
Their context: a terminal-first audience that already lives in YAML, CI configs, and
shell. They reach for this when they want CI/Actions-style structure — jobs, a `needs`
DAG, matrix fan-out, durable resumable runs — but locally, isolated per-job in a
micro-VM, optionally with an AI agent strapped to a step. The web console (`work --web`)
is where they watch runs execute, inspect the DAG, read per-step output and history, and
fire webhook-triggered runs. The job to be done: *understand and trust what a workflow is
doing as it runs* — see the shape, the progress, the failures, the outputs — without
leaving their own machine.

## Product Purpose

A local, secure workflow engine: GitHub-Actions-style YAML workflows where each job runs
isolated in a gondolin micro-VM with durable, crash-resumable execution and optional AI
agent steps. The UI's job is observability and control over runs — render the DAG
faithfully, stream step output live, surface state (running / succeeded / skipped /
failed) at a glance, and keep durable history legible. Success looks like: a developer
glances at the console and instantly knows what ran, what's running, what broke, and why —
with the same precision they'd expect from the engine underneath.

## Brand Personality

Technical and precise. Engineered, trustworthy, legible-under-density. The interface
should read like a well-built systems tool — confident in its information design, honest
about state, never decorative for its own sake. Three words: **precise, trustworthy,
unfussy.** It earns trust the way the engine does (isolation, durability) — by being
exact and never hiding what's happening.

## Anti-references

- **Generic AI-startup look** — no purple gradients, glassmorphism, glowing orbs, or the
  default "AI app" aesthetic. The agent steps are a feature, not the brand.
- **Flat, generic Bootstrap** — no undifferentiated default-framework UI with no point of
  view. It should look deliberately made, not assembled from component defaults.
- (Implied) not enterprise-CI bloat and not toy/playful — but the two above are the
  explicit lines not to cross.

## Design Principles

- **State is the message.** Every surface answers "what's happening right now" first.
  Run/job/step status is the primary information; chrome is secondary. Faithful state
  beats pretty.
- **Match the engine's precision.** The DAG, ordering, and outputs shown must be exactly
  what the runtime did — no smoothing, no optimistic guesses. Trust is the product.
- **Legible under density.** A real run has many jobs, steps, and lines of output. Earn
  clarity through hierarchy, rhythm, and typography — not by hiding information or padding
  it into oversized cards.
- **Calm by default, loud only on failure.** Success is quiet; failures and the things a
  developer must act on are where contrast and emphasis are spent.
- **Earn every element.** No decoration that doesn't carry information. If it doesn't help
  someone understand or act on a run, it doesn't ship.

## Accessibility & Inclusion

WCAG 2.1 AA. Body text ≥4.5:1 contrast (large text ≥3:1), full keyboard navigation for
the console (run lists, DAG, controls), visible focus states, and a
`prefers-reduced-motion` alternative for any run/status animation. State must never be
conveyed by color alone — pair status color with an icon or label (color-blind safe).
