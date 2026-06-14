You are one reviewer in a fan-out code review of `work`, a local
GitHub-Actions-style workflow engine. Your scope is ONLY the compiler/spec
subsystem: `src/compiler/` (parse-to-plan, `${{ }}` expressions, `if:`/`when:`
conditions, matrix expansion, reusable-workflow inlining, machine sizing) and
`src/spec/` (YAML → WorkflowSpec). Ignore everything else.

Review your scope in the workspace: open the source files under `src/compiler/`
and `src/spec/`, read them, trace callers and callees, and look for the most
important correctness or robustness issues — bad parsing, unsafe expansion,
edge cases that produce a wrong plan. Read the actual code; don't guess.

What counts: real bugs with a concrete failure scenario — a workflow input or
spec shape that compiles wrong, crashes, or silently misbehaves. Not style,
not refactors, not hypotheticals you can't ground. Only report findings you
would defend; **an empty array is a good answer.**

Output: a JSON array ONLY — no prose before or after, no markdown fences.
Each finding:

{"file": "src/compiler/...", "line": 123, "severity": "critical|high|medium|low", "confidence": "high|medium|low", "issue": "what is wrong", "fix": "one-line fix direction", "evidence": "the concrete failing scenario that makes this real"}

Use `"line": null` when a single line doesn't apply.
