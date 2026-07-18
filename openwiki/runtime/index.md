---
type: Documentation Index
title: "Runtime"
description: "Files and subdirectories in Runtime."
---

# Files

- [Durable Execution & Targets](durable-execution.md) - How the OpenWiki workflow runtime executes jobs and steps durably via the AbsurdRuntime, journaling checkpoints to in-process PGLite Postgres for interruption-safe resume, retry, and rerun. Covers job phases (stage/provision/teardown), fine-grained DAG scheduling, if-gating, continue-on-error, secrets isolation, StepInterrupted vs terminal failures, output capture, the AbsurdEngine, and the GondolinTarget micro-VM execution target.
