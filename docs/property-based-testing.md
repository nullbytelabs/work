# Property-based testing

A living record of why we're introducing **property-based testing** (PBT) with
[fast-check](https://fast-check.dev), where it pays off in this codebase, how to
write properties that actually earn their keep, and what we learn as we go.

This doc is three things at once:

1. a **knowledge guide** — the patterns, the fast-check mechanics, the quality bar;
2. a **concern inventory** — the ranked surfaces worth testing, with the specific
   properties to assert and the current coverage gaps;
3. a **findings log** — an append-only record of bugs found, properties that
   surprised us, and dead ends. Real PBT value shows up here over time.

Status: **established.** Branch `pbt`. fast-check `4.8.0` is a devDependency. All five
inventory targets are landed (23 properties, all mutation-checked); target #1 found a
real path-safety bug on day one. See the [progress tracker](#progress-tracker) and
[findings log](#findings-log).

---

## Why PBT, and why here

`src/compiler/` and `src/spec/` are almost entirely **pure functions with crisp
invariants**: a YAML spec goes in, an `ExecutionPlan` comes out, and the transforms
along the way (matrix fan-out, expression parsing, condition evaluation, input
coercion, topological sort) have properties that must hold for *every* input, not
just the half-dozen we thought to write down. That is exactly the shape PBT is for.

Our current tests are example-based `node:test` files: a human picked some inputs
and asserted the outputs. They're good, but they only cover the cases we imagined.
Combinatorial logic (matrix include/exclude) and parsers (expression access paths)
are precisely where hand-picked examples are weakest and a generator is strongest.

### Anthropic's own framing (lead with this)

Anthropic published a directly on-point treatment in January 2026 —
[*Property-Based Testing with Claude*](https://red.anthropic.com/2026/property-based-testing/)
(Maaz, DeVoe, Hatfield-Dodds, Carlini; backed by arXiv
[2510.09907](https://arxiv.org/abs/2510.09907), NeurIPS 2025). Zac Hatfield-Dodds
leads Anthropic's assurance team and maintains Hypothesis (the reference Python PBT
framework), so this is a house view, not a drive-by.

The points that shape how we work here:

- **Properties are a higher-altitude spec.** Instead of `sort([1,3,2]) == [1,2,3]`,
  you assert "the definition of a sorted list" — `result[i] <= result[i+1]` for all
  adjacent pairs. The post: PBT "frees developers from thinking of every edge case
  and allows them to operate at a higher level of abstraction."
- **LLMs are good at *inferring* properties** "from context (the name of the
  function, the docstring, how it is called by other functions)." Drafting the
  property catalog below is a task Claude is genuinely suited to — but see the
  quality bar.
- **The mandatory self-check:** after a property passes, ask
  **"is the test testing anything worthwhile, or is it simply trivial?"** The post's
  cautionary tale is an agent that wrapped a test in a try-catch that swallowed
  failures — a test that *cannot fail*. When the wrapper came off, the test failed
  and exposed a real bug. We treat "can this property actually fail?" as a gate.

This sits inside Anthropic's broader verification-loop doctrine from the
[Claude Code best practices](https://code.claude.com/docs/en/best-practices):
give the loop "something that produces a pass or fail," **show evidence rather than
asserting success**, and keep **writer ≠ grader** ("have one Claude write tests,
then another write code to pass them"). PBT is a strong fit: an independent property
is a harder thing to overfit than an example the implementer hand-picked. And the
reward-hacking failure mode Anthropic documents elsewhere — an agent calling
`sys.exit(0)` so "it appear[s] that all tests have passed"
([emergent misalignment](https://www.anthropic.com/research/emergent-misalignment-reward-hacking))
— is exactly what a real, minimal, shrinking counterexample resists.

### The anti-tautology throughline

The one trap that kills PBT value: **using one implementation to test another.**
Scott Wlaschin's framing —
[don't test `add` with `+`](https://fsharpforfunandprofit.com/posts/property-based-testing/);
assert "properties that are true for *any* correct implementation" — is the general
statement of Anthropic's "is it trivial?". A property that re-derives the output the
same way the code does will pass on broken code. Every property below is checked
against this: *would a plausible wrong implementation still satisfy it?* If not, it's
worth writing.

---

## Pattern vocabulary

Anthropic doesn't publish a named-pattern catalog; the canonical one is Wlaschin's
[seven patterns](https://fsharpforfunandprofit.com/posts/property-based-testing-2/),
plus metamorphic relations for the no-oracle case. Mapped to fast-check:

| Pattern | Shape | fast-check |
|---|---|---|
| **Round-trip / inverse** | `decode(encode(x)) == x` | `fc.property(gen, x => eq(dec(enc(x)), x))` |
| **Invariant** | a fact true of every output (sortedness, length preserved, path-safety) | predicate asserts the fact directly |
| **Metamorphic** | relate outputs of *related* inputs when there's no per-input oracle (`f(x2)` vs `f(x)`) | generate `x`, derive `x2`, relate results |
| **Idempotence** | `f(f(x)) == f(x)` | one gen, compare one vs two applications |
| **Commutativity / order-independence** | `X then Y == Y then X` | generate two ops, apply both orders |
| **Oracle / reference** | compare to a trusted (brute-force) implementation | predicate compares against the slow-but-obvious version |
| **Hard to prove, easy to verify** | don't recompute the answer, *check* it | verify the result's structure |
| **Model-based / stateful** | sequences of ops keep a model and the real system in sync | `fc.commands` + `fc.modelRun` |

**Metamorphic** deserves a callout: it's a *partial oracle* for when you can't say
what the right output is, only how it must change. The classic is `sin(π − x) == sin x`
([Hillel Wayne](https://www.hillelwayne.com/post/metamorphic-testing/)). We use it
for matrix exclude (adding an exclude entry can only shrink the result) where the
absolute output is awkward to predict but the *relation* is dead simple.

---

## fast-check in this repo

Reference distilled from the official docs (fast-check **v4.8.0**, current as of
June 2026). Full notes in the [mechanics appendix](#appendix-fast-check-mechanics).

**Dependency:** `fast-check` as a `devDependency`. It's runner-agnostic — no
`@fast-check/*` connector needed; we drive it straight from `node:test`. Ships its
own types; works under native TS type-stripping (it's published JS + `.d.ts`).

**The `node:test` idiom** — call `fc.assert` inside an ordinary `test()` body; a
failing property throws, which fails the test:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { expandMatrix } from '../src/compiler/matrix.ts'; // explicit .ts per repo convention

test('expandMatrix: no include/exclude ⇒ |cells| = product of axis lengths', () => {
  fc.assert(
    fc.property(matrixAxes(), (axes) => {
      const product = Object.values(axes).reduce((n, vs) => n * vs.length, 1);
      assert.equal(expandMatrix({ axes }).length, product);
    }),
  );
});
```

Async uses `fc.asyncProperty` and **must** `await fc.assert(...)` (forgetting the
await lets a rejection escape and the test passes spuriously).

**Naming / placement:** `test/<area>.property.test.ts`, alongside the existing
`test/<area>.test.ts`. Keeps PBT visibly separate from example tests and lets us run
just the properties when iterating. Driven by `test/examples.test.ts`'s same runner
flags; no harness changes.

**Reproducibility (the CI rule):** a failure prints a `{ seed, path }` you paste back
as the second arg to `fc.assert` to replay the exact minimal counterexample. By
default each run reseeds from `Date.now()`, so a latent bug can surface on a
*different* input each CI run — that's a feature (more coverage over time), but it
means "passed once" ≠ "proven." When a property finds a bug, we pin the case via the
`examples` option as a permanent regression seed:

```ts
fc.assert(fc.property(gen, pred), { examples: [[/* the minimal counterexample */]] });
```

Keep generators and predicates **deterministic given the seed** — no `Date.now()`,
`Math.random()`, or I/O inside them (mirrors the repo's existing workflow-script
rule). Shrinking is the payoff: don't break it (see appendix — avoid `.filter`,
never throw in `.map`, never mutate predicate inputs).

---

## Concern inventory

Ranked by reward-to-effort. Each entry: the target, why it benefits, the concrete
properties to assert, current coverage, and the anti-tautology note. File:line
references are against the tree at authoring time and may drift.

### 1. Matrix fan-out — `src/compiler/matrix.ts` ← entry point

**Why first.** Self-contained pure module (`expandMatrix`, `cellId`, `cellLabel`),
combinatorial (where examples are weakest), and its invariants span *five* pattern
styles — so it becomes the team's reference for how to write properties. The
include-extends-vs-appends interaction (`matrix.ts:60`) is a known footgun inherited
from GHA semantics and is currently only happy-path tested (`compiler.test.ts`).

**Properties:**

- *Counting (invariant):* with no include/exclude, `|expandMatrix(axes)|` equals the
  product of axis lengths.
- *Monotonicity (metamorphic):* adding an `exclude` entry can only **reduce or
  preserve** the cell count — never grow it. (Partial oracle: we don't predict the
  exact set, only the direction.)
- *No-overwrite (invariant):* neither exclude nor include ever mutates an axis value;
  `include` only *adds* keys to a matching cell.
- *Path-safety (invariant):* `cellId(cell)` always matches `/^[A-Za-z0-9._-]+$/` for
  *arbitrary scalar* matrix values — the sanitizer at `matrix.ts:82` is fed
  adversarial unicode/slashes/dots. This is the genuinely valuable version of the
  "names/ids" instinct.
- *Determinism / injectivity:* same cell + axis order ⇒ identical `cellId`; distinct
  cells ⇒ distinct ids.

**Generators:** `fc.dictionary(fc.string(), fc.array(scalar, { minLength: 1 }))` for
axes, where `scalar = fc.oneof(fc.string(), fc.integer(), fc.boolean())`. Exclude/
include derived from generated axes via `.chain` (generate axes, then partial cells
*into* them).

**Anti-tautology:** path-safety and monotonicity can't be satisfied by re-running the
same product logic — they're structural facts about the output, not a recomputation.

### 2. Expression access-path parser — `src/compiler/expr.ts` (the showcase)

**Why.** `parseAccessPath` (`expr.ts:217`) + `walkPath` (`expr.ts:269`) is a real
parser with the textbook PBT win available: a **round-trip with a planted oracle**.
Bracket/quote escaping (`'a''b'`, `["key"]`) is exactly the edge surface no one
writes by hand. Currently only exercised indirectly via `inputs.test.ts`.

**The showcase property (round-trip):** plant a value at a random path in a random
JSON object → serialize that path to access-path syntax → `parseAccessPath` →
`walkPath` → assert you recover the planted value. Generator: `fc.jsonValue()` for
the object, `.chain` to pick a real path into it.

**Supporting properties:** `walkPath` never throws on arbitrary segments (missing ⇒
`undefined`); `parseAccessPath` rejects unbalanced brackets / mismatched quotes
rather than mis-parsing; first segment is always the root identifier.

**Anti-tautology:** the oracle is the *planted* value, established independently of
the parser — the parser can't fake agreement with a value it never saw.

**Heavier generator** (needs a JSON-value-to-path serializer), so it's the *second*
file, not the first.

### 3. Typed input coercion — `src/compiler/inputs.ts`

**Why.** Type validation + constraint checking (`options`/`pattern`) + default
application, all pure (`resolveInputs`, `validateType`, `validateConstraints`).
Already has decent example coverage (`inputs.test.ts`, 206 lines), so PBT extends
rather than founds.

**Properties:** strict typing rejects coercible-looking values (string `"36"` for a
`number` input fails; `NaN`/`Infinity` rejected); a declared input never provided and
not required gets its type-default deterministically; `pattern`/`options` validate
**only** present inputs; an unknown provided key always errors. Metamorphic:
re-running `resolveInputs` on its own output is idempotent.

### 4. Condition evaluation — `src/compiler/condition.ts` ← landed (was deferred)

**Why it waited, and how it landed.** Richest logic (tokenizer + recursive-descent
parser + evaluator, 408 lines), so it was deliberately not the entry point — done
last, once the pattern was worn in. We considered an **oracle** (a tiny reference
evaluator over a restricted grammar) but rejected it: a hand-written mirror risks
copying the engine's own quirks, so a shared bug would pass. Instead the 9 properties
are **algebraic laws any correct boolean engine must satisfy** — implementation-
independent and impossible to satisfy tautologically: literal truthiness (a small
leaf oracle), double-negation `!!e == e`, `==` commutativity, `!=` is `!(==)`, De
Morgan, `&&`/`||` commutativity, identity/domination (`x&&true=x`, `x||false=x`,
`x&&false=false`, `x||true=true`), totality (well-formed ⇒ boolean, no throw), and
the reject-don't-pass safety contract (unsupported `<`, unknown context root, lone
`&`, unbalanced parens, trailing tokens, empty ⇒ `ConditionError`). A `fc.letrec`
generator emits fully-parenthesized well-formed expressions over literals and safe
`inputs.*` refs.

### 5. Topological sort — `src/compiler/compile.ts:212` (`topoSort`)

**Why.** Kahn's algorithm with alphabetical tie-breaking. Clean invariants:
output is a **permutation** of the input job set; for every edge `u→v`, `u` precedes
`v`; determinism (same DAG ⇒ same order); a cyclic input throws and names the cycle.
Generator: build a guaranteed-acyclic DAG by generating a node order then only adding
forward edges (a standard trick that keeps the generator total and shrinkable).

**Anti-tautology:** "every dependency precedes its dependent" is a property of *any*
correct topo sort, independent of how this one orders ties.

### Why not identifier/`runs-on` validation

The original instinct (workflow/job/step names + step ids) is the **weakest** PBT
target: those validators are essentially single regexes (`assertValidJobKey`
`/^[A-Za-z_][A-Za-z0-9_-]*$/` at `src/spec/parse.ts:502`; `parseRunsOn` variant
`/^[a-z0-9]+(?:-[a-z0-9]+)*$/` at `src/compiler/runs-on.ts:20`). PBT against a regex
validator tends to be **tautological** — you re-encode the regex in the generator, so
the test asserts the regex equals itself. The valuable, non-tautological property
hiding in that instinct is *path-safety* ("any accepted id is safe as a path segment,
never escapes its directory") and *grammar-consistency* ("any accepted id parses as a
single root segment in the expression grammar") — and `cellId` in target #1 already
exercises the path-safety version on a richer input space. So the instinct was
pointing at a real property; matrix is just the better place to assert it.

---

## Quality bar (the gate)

Before a property lands, it must pass these — this is the operational form of
Anthropic's "is it testing anything worthwhile?":

1. **Can it fail?** Temporarily break the implementation (or assert the negation) and
   confirm the property catches it with a shrunk counterexample. A property that
   never goes red is a try-catch-swallow in disguise.
2. **Is it independent?** Would a *plausible wrong* implementation still pass? If the
   predicate recomputes the output the way the code does, it's tautological — rewrite
   it as a structural fact or an independent oracle.
3. **Does it shrink?** A failure must report a *minimal* counterexample. If shrinking
   is broken (filtered/over-constrained generators, mutated inputs), fix the generator
   before trusting the property.
4. **Is it evidence?** Per the verification-loop doctrine: a found bug gets pinned as
   an `examples` regression case and recorded in the findings log below — show the
   counterexample, don't just assert the fix.

Where practical, apply **writer ≠ grader**: have one pass draft the property from the
function's contract (name/types/docstring) *without* reading the implementation, so
the property describes intended behavior rather than mirroring the code.

---

## Progress tracker

| # | Target | File | Status | Properties landed | Bugs found |
|---|---|---|---|---|---|
| — | Add `fast-check` devDependency | `package.json` | ☑ done (`4.8.0`, exact) | — | — |
| 1 | Matrix fan-out | `src/compiler/matrix.ts` | ☑ done | 5 / 5 | 1 (F-1) |
| 2 | Expression access-path | `src/compiler/expr.ts` | ☑ done | 4 / 4 | 0 (F-3) |
| 3 | Typed input coercion | `src/compiler/inputs.ts` | ☑ done | 5 / 5 | 0 (F-4) |
| 4 | Condition evaluation | `src/compiler/condition.ts` | ☑ done | 9 / 9 | 0 (F-6) |
| 5 | Topological sort | `src/compiler/compile.ts` | ☑ done | 4 / 4 | 0 (F-5) |

Legend: ☐ todo · ◐ in progress · ☑ done · deferred.

Target #1 lives in `test/matrix.property.test.ts` (P1 counting, P2 exclude
monotonicity, P3 include no-overwrite, P4 cellId path-safety, P5 cellId
order-independence). All five were **mutation-checked**: each goes red on a
non-equivalent mutant (slice the product, grow on exclude, prepend appended cells,
drop the extras `.sort()`), so none is a trivially-passing test.

---

## Findings log

Append-only. One entry per discovery: the property, the minimal counterexample, the
verdict (real bug / spec gap / generator artifact), and the fix or regression pin.
This section is the point of the whole exercise — it's where we find out whether
there was gold in the hill.

### F-1 — `cellId` leaked unsanitized keys into the path-safe leg id (real bug, fixed)

- **Property:** P4 — `cellId(cell, order)` matches `/^[A-Za-z0-9._-]*$/` for any cell.
- **Counterexample (shrunk 6×):** `cellId({ " ": "" }, [])` → `" -"` — a space, not
  path-safe. fast-check seed `-586601068`.
- **Root cause:** `matrix.ts:87` ran the cell *value* through `safe()` but
  interpolated the *key* raw (`` `${k}-${safe(v)}` ``). Matrix axis names and
  `include`/`exclude` keys are **unvalidated** at parse time (`parseMatrixCell`,
  `src/spec/parse.ts:147` — any string key is accepted), so an axis named `os/arch`
  (or a typo like `../x`) would inject a path separator into the leg id. That id is
  documented as path-safe and is used to build `<base>::<cell>` job ids
  (`compile.ts:188`, `plan.ts:41`) — the violated contract.
- **Verdict:** real bug. Latent because real-world axis names happen to be tidy, but
  the path-safety invariant was false for the whole unvalidated key space.
- **Fix:** sanitize the key with the same `safe()` as the value
  (`matrix.ts:87`). Collisions remain disambiguated downstream by the `seen`/`-n`
  loop (`compile.ts:189`), so no new collision risk. Fix at the point that *promises*
  path-safety, not a parse-time key whitelist (which would be a larger, separate
  question of "what is a legal axis name").
- **Regression pin:** the counterexample is now an `examples` case on P4.
- **Takeaway:** the "names/ids" instinct that kicked this off was pointing at a real
  property after all — just one tier deeper (sanitization completeness) than a regex
  validator, and on `cellId` rather than the name validators.

### F-2 — the line-60 "never overwrite an axis value" guard is an equivalent mutant

- **Observation (mutation testing, not a bug):** removing the
  `if (!axisNames.includes(k))` guard at `matrix.ts:60` does **not** make P3 fail.
- **Why:** `include` only writes a key it *matched* on, and matching requires
  `eqVal(cell[a], inc[a])`, so re-writing an axis key always writes back the value it
  already had — an unobservable no-op. The guard is defensive clarity, not behavior.
- **Takeaway:** a property staying green under a mutation isn't automatically a weak
  property — the mutant may be *equivalent*. P3 was separately confirmed falsifiable
  by a non-equivalent mutant (prepend appended cells, which shifts product indices).
  Worth remembering when we mutation-check future targets: distinguish "property too
  weak" from "mutant changes nothing."

### F-3 — `expr.ts` access-path round-trip: no bug, parser is a clean inverse

- **Target #2** (`test/expr-path.property.test.ts`): 4 properties — P1 the showcase
  round-trip (`parseAccessPath ∘ serialize == identity`, plus an oracle: walk a
  value planted at the path and recover it), P2 `walkPath` totality (never throws),
  P3 malformed-input rejection, P4 missing-semantics (walking past a scalar leaf →
  `undefined`). All green; `parseAccessPath`/`walkPath` round-trip cleanly over the
  grammar's representable subset. A "no bug found" result is still signal — the
  parser is robust, and we now have a regression net over its inverse-ness.
- **Representable subset (documented in the test):** the serializer always quotes
  bracketed keys with `"`, so the only keys it can't express are those containing a
  literal `"` (the grammar has no escape) and `__proto__` (excluded to avoid JS's
  own-vs-prototype `[]` getter semantics — a separate concern). Everything else —
  empty keys, spaces, unicode, `]`, `'`, dotted identifiers, indices — round-trips.
- **Equivalent-mutant learning (cf. F-2):** dropping `walkPath`'s non-object guard
  (`return undefined`) falsified P2 (a `null` intermediate then throws on indexing)
  but **not** P4 — because P4's leaf is a *non-null* scalar and JS autoboxing makes
  `(5)["k"] === undefined`, so the "missing" outcome coincides with the bug. P4 is
  only falsified by a mutant that returns a *non-undefined* value (`return cur`),
  counterexample `walk({a:0}, [a, ""]) → 0`. Lesson: when the correct output is
  `undefined`, guard against mutants that *also* yield `undefined` for the wrong
  reason — pick a mutant that returns a distinguishable value.

### F-4 — `inputs.ts` typed resolution: no bug, strict-typing contract holds

- **Target #3** (`test/inputs.property.test.ts`): 5 properties — P1 output
  shape/typing invariant (result keys == declared keys; every value matches its
  declared type, whether from the body, a default, or a sentinel), P2 unknown-key
  rejection, P3 strict no-coercion (a wrong-typed value throws — `"36"` is never a
  number), P4 idempotence (resolution is a fixed point), P5 the `if (present)` gate
  (an absent optional with a sentinel-hostile constraint resolves to the sentinel,
  not a throw). All green; `resolveInputs` upholds its strict-typing contract.
- **All 5 mutation-checked, no equivalent-mutant surprises:** bad sentinel type,
  ignore-unknown-keys, coerce-numbers, append-on-string (non-idempotent), and
  drop-the-present-gate each falsified exactly the matching property.
- **Generator note:** scenarios are normalized to always resolve — a required input
  with no default is force-provided — so P1/P4 test the resolution logic, not the
  required-without-value throw (which P-side error paths cover). Constraints
  (options/pattern) are kept out of the P4 idempotence scenario on purpose: feeding
  a resolved sentinel back makes it "present", which *would* then be constraint-
  checked — a real asymmetry, isolated to P5 rather than allowed to muddy P4.

### F-5 — `topoSort` DAG invariants: no bug; replay-stability holds

- **Target #5** (`test/toposort.property.test.ts`): 4 properties — P1 the order is a
  permutation of the job ids, P2 every `need` precedes its dependent, P3 the result
  is independent of job insertion order (the replay-stability the algorithm exists
  for), P4 cyclic graphs throw and name the cycle. All green.
- **Generator:** acyclicity is made *structural*, not filtered — fix the node list
  as a linear order and let each node `need` only earlier nodes. Cyclic cases use a
  ring (self-loop for n=1). No `.filter` on the arbitrary, so shrinking stays sharp.
- **Exported `topoSort` for testing** (`compile.ts`) — it was private, used only by
  `compile`. This matches the repo's existing habit of exporting pure helpers
  (`expandMatrix`, `parseAccessPath`, `closingBracket`) for unit coverage; no
  behavior change.
- **Mutation note (P3):** the determinism property only falsifies when *insertion
  order actually leaks*. Reversing the tie-break (e.g. `.sort().reverse()`
  everywhere) stays order-independent, so P3 would not catch it — P3 asserts
  *stability*, not the specific alphabetical choice. The mutant that does falsify it
  removes both the initial `ids` sort and the ready-queue sort so insertion order
  reaches `ready.shift()`. (If we ever want to pin the *alphabetical* tie-break
  specifically, that's a separate, stronger property worth adding.)

### F-6 — condition engine: no bug; algebraic laws hold across the grammar

- **Target #4** (`test/condition.property.test.ts`): 9 properties (listed in the
  inventory entry above). All green; the `if:`/`when:` engine obeys the boolean
  algebra it should.
- **Why laws, not an oracle:** a reference evaluator would re-encode `truthy`/
  `looseEq`/`numeric` and could replicate a bug in the engine, so it could not catch
  it. Metamorphic laws (commutativity, De Morgan, double-negation, identity) are true
  for *any* correct engine regardless of implementation — the non-tautological choice.
- **Mutation-checked across the engine:** invert number truthiness (→ P1), make
  `looseEq` asymmetric (→ P3), make `!=` return `==` (→ P4), make `!` return a
  constant (→ P2), make `&&` behave like `||` (→ P7), accept trailing tokens (→ P9)
  — each caught by the matching law. (Note: dropping *both* negations in `!` is an
  equivalent mutant for P2 — `!!e` collapses back to identity — so P2's mutant has to
  break the negation count *asymmetrically*, e.g. `! → true`. Same family as F-2/F-3.)

---

## Where this leaves us

All five inventory targets landed (23 properties), each a self-contained,
mutation-checked commit. The one real bug (F-1) was found on day one by the first
target. The "no bug" targets (#2–#5) still bought regression nets — over the parser's
inverse-ness, the input contract's strictness, the sort's replay-stability, and the
condition engine's boolean algebra — plus reusable learnings about *checking*
properties (equivalent mutants, autoboxing-`undefined`, stability-vs-choice,
oracle-vs-law). Next candidates if PBT keeps paying off: matrix `${{ }}` resolution
(`compile.ts:matrixLegs`), reusable-workflow id namespacing (`reusable.ts`), and a
stateful `fc.commands` model of the runtime's durable step memoization.

---

## Security track

PBT is unusually good at security invariants: a security property is a "must hold
for *every* input, especially adversarial ones" claim, and fuzzing adversarial
strings/JSON is exactly what generators do. This track captures the highest-leverage
security surfaces, grounded in how the boundary actually works (see
`docs/egress-data-path.md`, `docs/gondolin-secure-execution.md`, `src/web/server.ts`).

**Threat-model note — `serve` will eventually bind `0.0.0.0`.** Today `work serve`
is loopback-hardened: `listen(port, "127.0.0.1")` (`server.ts:974`), a Host-header
allowlist (`:259`, anti-DNS-rebinding), and a CSRF token on mutating UI POSTs
(`:290`). The **webhook delivery path** is the one surface already built for hostile
networks (HMAC-SHA256 / bearer, `timingSafeEqual`, fail-closed, generic 404 — no hook
enumeration; `authorizeHook`, `:566`). Binding `0.0.0.0` is a stated future goal, and
it dissolves the loopback assumption — see the [pre-`0.0.0.0` readiness](#pre-0000-readiness)
checklist. That goal *re-rates* the items below: an attacker-reachable webhook makes
the event-payload surface (S-1) load-bearing.

### S-1 — inherited-property leakage in context resolution (confirmed gap) ← doing first

**Invariant:** resolving `${{ event.<path> }}` / `if: event.<path>` returns **only own
data from the payload** — never an inherited builtin (`constructor`, `__proto__`,
`toString`, `hasOwnProperty`, …). Walking a JSON value never yields a function or a
prototype object.

**Gap (confirmed):** `walkPath` (`expr.ts:269`) does raw `cur[seg.name]`, which walks
the prototype chain. The guarded roots — `inputs` (`expr.ts:100`), `matrix`
(`expr.ts:117`), `needs`/`steps` (`:128`,`:150`) — gate every access with
`Object.prototype.hasOwnProperty.call`. But **`event`** resolution (`expr.ts:167`) and
**all** condition roots (`condition.ts:353`) flow through unguarded `walkPath`. So
`event.constructor` → a function, `event.toString` → a function, `event.anything`
falls through to `Object.prototype`. `event` is the attacker-controlled webhook
surface (`server.ts:762` `JSON.parse`, returned as-is). It's a prototype-*read* gadget
(no write/pollution site was found — JSON.parse's `__proto__` key is an own property,
not a prototype mutation), but it can flip an `if:` gate truthy or inject a function's
source into a `run:` string, and it's the seam where a future write-path becomes
pollution.

**Fix:** make `walkPath` own-property-only (`Object.hasOwn` guard on key access) —
idiomatic here (`compile.ts:369` already notes "`in` walks the prototype"). This
hardens `event` in interpolation *and* every root in conditions, in one place,
matching the existing guarded roots.

**Properties:** (P1) `walkPath` over any JSON value agrees with an own-only reference
walk for any path drawn from a builtin-key-rich pool; (P2) `walkPath` over a JSON value
never returns a function; (P3) at the surface, `evaluateCondition`/`interpolate` resolve
builtin keys on a non-owning event to falsy/`""`. Status: see [tracker](#security-tracker).

### S-2 — path confinement on the job-id → filesystem sink (durable guarantee)

**Invariant:** for *any* workflow (plain, matrix, reusable, and compositions), the
computed `job.id` stays a single confined segment — `path.join(workRoot, job.id)`
never escapes `workRoot` (no `..`, no separators, never `.`/empty). The sink is real:
`runtime.ts:613` does `join(ctx.workRoot, job.id)`, and matrix `<base>::<cell>` /
reusable `<callId>__<jobId>` ids **bypass** the parse-time `assertValidJobKey`
(`parse.ts:506`). This is the security invariant behind the `cellId` bug (F-1); a
property over the full id pipeline (`cellId` → `::` → namespacing → `-n` disambiguation)
asserted at the sink locks the whole class. Likely green post-F-1 — a regression net on
a path-traversal sink — but stresses untested compositions (an id that collapses to
`.`/`..`/empty would be a fix).

### S-3 — egress allowlist ↔ secret-scope consistency, and locking the matcher contract

**Invariant:** the host a credential is scoped to is exactly the host that's allowlisted
and exactly what a guest request canonicalizes to. Our derivation —
`hostOf(baseUrl)` / `modelHostOf` feeding both the allowlist set and the secret's
`hosts` (`egress/datasource.ts`, `agent/egress.ts:75`) — must not diverge, or a token
is injected for an unintended host (leak) or a host is reachable without its token.
The matcher itself (`matchHostname` in `node_modules/@earendil-works/gondolin`) is
vendor code and already `^…$`-anchored, so we don't re-test their regex — we
**characterize and lock the contract we depend on** ("`hostOf(baseUrl)` matches that
exact host and nothing else; no suffix/trailing-dot/IDN/port escape"), so a gondolin
auto-bump that loosened matching turns the property red instead of silently widening
egress. Generators vary case/ports/trailing-dots/IPv6/IDN. Mostly fail-closed today, so
this primarily codifies the credential-scoping guarantee against seam bugs and
dependency drift.

### Pre-`0.0.0.0` readiness

Before `serve` may bind a non-loopback address, these must land (PBT-shaped marked ⚙):

- ⚙ **Bind-gating (fail-closed):** never bind non-loopback unless explicitly opted in
  *and* auth is configured — property: `bindAddress ≠ 127.0.0.1 ⇒ authConfigured`.
  The guardrail that makes shipping this incrementally safe.
- ⚙ **Webhook-auth hardening:** fuzz `authorizeHook` (`server.ts:566`) — truncated/
  oversized signatures, type-confusion (array/object headers), missing-header→deny,
  constant-time across all reject paths, and **body read+HMAC'd before auth** (size cap
  to avoid a pre-auth DoS).
- ⚙ **Body-size / connection limits:** remote-reachable `JSON.parse` + PGLite
  single-writer are DoS surfaces.
- **Host-header / rebinding rework:** the `{127.0.0.1:port, localhost:port}` allowlist
  403s every remote client — redesign without losing rebinding protection (design,
  then property-test the resulting policy).
- **Real UI/API authN (not PBT, the long pole):** a CSRF token is anti-CSRF, *not*
  authentication (it's embedded in the served page). The management surface needs
  genuine auth before exposure.

### Security tracker

| # | Surface | Invariant | Status | Bug? |
|---|---|---|---|---|
| S-1 | `event`→`walkPath` inherited-property leak | resolution returns own payload data only | ◐ in progress | yes — fixing |
| S-2 | job-id → filesystem confinement | computed id stays confined under `workRoot` | ☐ todo | — |
| S-3 | egress allowlist ↔ secret-scope + matcher contract | credential scoped to exactly the allowlisted host | ☐ todo | — |
| R | pre-`0.0.0.0` readiness (bind-gate, webhook-auth, limits, authN) | see checklist | ☐ todo | — |

---

## Appendix: fast-check mechanics

Condensed from the official docs (fast-check.dev) at **v4.8.0**. Cite the live docs
for anything load-bearing; APIs drift.

**Properties & runners.** `fc.property(...arbitraries, predicate)` (sync) /
`fc.asyncProperty` (async); run via `fc.assert(property, params?)`. Predicate fails by
throwing or returning `false`; passes on `true`/`undefined`. `await` async asserts.
Never mutate predicate inputs (breaks shrinking + counterexample display).

**Key arbitraries.** Numbers: `fc.integer({min,max})`, `fc.nat`, `fc.double({noNaN,
noDefaultInfinity})` (generates `NaN`/`±∞`/`-0` by default — constrain for finite).
`fc.boolean` (shrinks to `false`). **Strings (v4 change):** one `fc.string({ unit })`
— `unit: 'grapheme-ascii'` (default), `'binary'` (any code points), `'grapheme'`
(full unicode); old `fc.char`/`fc.asciiString`/`fc.unicodeString` are gone.
Collections: `fc.array`, `fc.uniqueArray` (prefer `selector` over `comparator`),
`fc.tuple`, `fc.record(model, { requiredKeys })`, `fc.dictionary(k, v)`. Choice:
`fc.constantFrom(...)` (shrinks to first), `fc.oneof(...)` (shrinks within chosen),
`fc.option(arb, { nil })`. JSON: `fc.json()` (string) / `fc.jsonValue()` (parsed
value). Recursion: `fc.letrec((tie) => ...)` with `depthSize`/`maxDepth` to terminate.

**Combinators & dependent data.** `.map` (1:1 transform — never throw inside it),
`.chain` (flat-map: generate a value, then an arbitrary *depending* on it — the
pattern for "object then a valid path into it"; note `.chain` shrinks less well than
`.map`, so prefer `.map` when possible). `fc.pre(cond)` inside a predicate skips a
run. Prefer constraint *options* (`{min, maxLength, ...}`) over `.filter`/`fc.pre` —
filtering wastes runs and degrades shrinking.

**Shrinking.** Every arbitrary pairs a generator with a shrinker; on failure
fast-check converges to a minimal counterexample (numbers→0, strings→'', arrays
shrink length + elements, `constantFrom`→first). Keep it working: no `.filter` where
a constraint exists, no throwing in `.map`, no mutating inputs, prefer `.map` over
`.chain`. To bound *time* use `endOnFailure`/`interruptAfterTimeLimit`, **not**
`noShrink`.

**Reproducibility.** `fc.assert(prop, { numRuns=100, seed, path, examples, endOnFailure,
timeout })`. Failure prints `{ seed, path }` → paste back to replay the exact minimal
case; drop `path` to re-shrink from the seed. `examples: [[args], ...]` runs explicit
regression tuples before random ones each run — our mechanism for pinning found bugs.
`fc.configureGlobal({...})` (via a setup module loaded with `node --import`) shares
`numRuns`/`seed` across files. `fc.statistics(arb, classifier)` measures what a
generator actually produces (watch for bias toward small/edge values — by design).

**Model-based.** `fc.commands` + `fc.modelRun`/`fc.asyncModelRun` for sequences of
operations against a model + real system (`Command.check`/`run`/`toString`). Replay
needs `{ replayPath }` on `fc.commands` in addition to `{ seed, path }`. Useful later
for stateful surfaces (the runtime's DAG walk, journaled step memoization) — not the
pure-compiler entry points.

---

## References

**Anthropic**
- [Property-Based Testing with Claude](https://red.anthropic.com/2026/property-based-testing/) (Jan 2026) · paper [arXiv 2510.09907](https://arxiv.org/abs/2510.09907)
- [Claude Code best practices](https://code.claude.com/docs/en/best-practices) — verification loop, writer ≠ grader, evidence over assertion
- [Emergent misalignment & reward hacking](https://www.anthropic.com/research/emergent-misalignment-reward-hacking) (Nov 2025) — why tests must resist gaming

**Canonical PBT**
- Claessen & Hughes, [QuickCheck](https://www.cs.tufts.edu/~nr/cs257/archive/john-hughes/quick.pdf) (ICFP 2000) — the founding philosophy
- Wlaschin, [Choosing properties](https://fsharpforfunandprofit.com/posts/property-based-testing-2/) (the seven patterns) · [The Enterprise Developer from Hell](https://fsharpforfunandprofit.com/posts/property-based-testing/) (anti-tautology)
- Wayne, [Metamorphic Testing](https://www.hillelwayne.com/post/metamorphic-testing/) · [Test oracle](https://en.wikipedia.org/wiki/Test_oracle)

**fast-check**
- [Docs](https://fast-check.dev/docs/) · [Properties](https://fast-check.dev/docs/core-blocks/properties/) · [node:test setup](https://fast-check.dev/docs/tutorials/setting-up-your-test-environment/property-based-testing-with-nodejs-test-runner/) · [Model-based](https://fast-check.dev/docs/advanced/model-based-testing/) · [v3→v4 migration](https://fast-check.dev/docs/migration/from-3.x-to-4.x/)
