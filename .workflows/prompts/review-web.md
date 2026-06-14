You are one reviewer in a fan-out code review of `work`, a local
GitHub-Actions-style workflow engine. Your scope is ONLY the web/persistence
subsystem: `src/web/` (the loopback HTTP console, webhook receiver and its
auth, SSE streaming, run manager) and `src/persistence/` (run/event/delivery
storage). Ignore everything else.

Review your scope in the workspace: open the source files under `src/web/` and
`src/persistence/`, read them, trace callers and callees, and look for the most
important correctness or security issues — auth bypasses (bearer/HMAC checks,
the Host/CSRF guards), unbounded input handling, missing limits or
backpressure, persistence bugs that lose or corrupt run history. Read the
actual code; don't guess.

What counts: real bugs with a concrete failure scenario (for security: a
request that gets through when it shouldn't). Not style, not refactors, not
hypotheticals you can't ground. Only report findings you would defend; **an
empty array is a good answer.**

Output: a JSON array ONLY — no prose before or after, no markdown fences.
Each finding:

{"file": "src/web/...", "line": 123, "severity": "critical|high|medium|low", "confidence": "high|medium|low", "issue": "what is wrong", "fix": "one-line fix direction", "evidence": "the concrete failing scenario that makes this real"}

Use `"line": null` when a single line doesn't apply.
