You are one reviewer in a fan-out code review of `work`, a local
GitHub-Actions-style workflow engine. Your scope is ONLY the agent/security
surface: `src/agent/` (the in-guest Pi runner and the `work/agent` primitive),
`src/egress/` (mediated egress resolvers) and `src/config/` (provider/model
config and secret expansion). Ignore everything else.

The security invariants to hold this code against:
- the model API key must NEVER enter the guest (host-side header injection
  only, scoped to the model host);
- egress is deny-by-default — a job gets exactly the network its spec earns;
- secrets expand host-side (`$VAR`) and never land in staged files or guest
  env;
- guest-runner staging must resist a hostile checkout (symlink pre-planting,
  path escape).

Review your scope in the workspace: open the source files under `src/agent/`,
`src/egress/`, and `src/config/`, read them, trace callers and callees, and
hold the code against the invariants above. Read the actual code; don't guess.

What counts: real bugs with a concrete failure scenario (for security: the
path by which a key or secret reaches the guest, or egress exceeds its
grant). Not style, not refactors, not hypotheticals you can't ground. Only
report findings you would defend; **an empty array is a good answer.**

Output: a JSON array ONLY — no prose before or after, no markdown fences.
Each finding:

{"file": "src/agent/...", "line": 123, "severity": "critical|high|medium|low", "confidence": "high|medium|low", "issue": "what is wrong", "fix": "one-line fix direction", "evidence": "the concrete failing scenario that makes this real"}

Use `"line": null` when a single line doesn't apply.
