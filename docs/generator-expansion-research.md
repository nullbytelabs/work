# Generators (`work init` / `work create`) — assessment & expansion research

> **Status: research.** A state-of-the-generators assessment as of 2026-06-14,
> fanned in from a parallel code/docs audit. It builds on
> [`init-doctor-scaffolding-research.md`](init-doctor-scaffolding-research.md)
> (the original design record — read that for *why* templates are embedded
> strings, why the config writer never clobbers, the merge-model trap) and
> asks the next question: now that `init`/`create` have shipped, **how useful
> are they, is the docs-site coverage adequate, and what should the generators
> scaffold that they don't yet?** File:line refs reflect the tree at research
> time.

---

> **Update (2026-06-14): items 1–4 shipped, plus a CLI-grammar refactor.** Landed:
> the merge-into-`work.json` writer (`src/scaffold/config-merge.ts`); `create
> image` (arch-agnostic build-config skeleton — `src/scaffold/image.ts`); and
> **webhook pairing** (`src/scaffold/webhook.ts`) — both greenfield (`create
> workflow <name> --webhook [--source <id>]` bakes `on: webhook` into the generated
> file *and* merges the `webhooks.<name>` config half) and retrofit (`create webhook
> <name> --workflow <existing>` merges the config half + prints the opt-in snippet,
> never mutating existing YAML). The `--source` preset table maps a sender to its
> auth mode/header (`alertmanager`→bearer, `grafana`/`github`→hmac).
>
> The CLI grammar was also unified to **`create <noun> <name>`** (`workflow`,
> `image`, `webhook`) — a deliberate **breaking change**: the bare
> `create <name>` form is gone (it errors with a `did you mean create workflow …?`
> hint). This removes the old noun/name ambiguity, so a workflow may again be named
> `image`. Still open: workflow-template variety (§4.3). The
> assessment below is preserved as the rationale record.

## 0. TL;DR

- The generator **machinery is healthy and extensible** — pure
  `Map<path, contents>` builders, real-compiler validation before any write,
  non-clobbering writes, name slugging, collision guards. Adding a template is a
  string constant plus a registry entry.
- The generator **catalog is thin**: two templates (`hello-world`,
  `agent-action`), one provider hardcoded (Fireworks/Kimi), single-job workflows
  only.
- Docs coverage is **accurate but minimal**: a solid CLI-reference section and
  scattered guide tips, **no dedicated page**, no template output shown, and the
  quickstart pivots to hand-authoring after ~9 lines.
- The biggest **unaccounted-for surfaces** a user must hand-author today, ranked
  by payoff: **(1) action packages** (`create action`), **(2) secret / webhook
  config sections** (the user's hypothesis — confirmed strong; there is *no* worked
  `secrets:` example anywhere in the repo), then workflow-template variety and
  custom-image scaffolds.
- One shared prerequisite unlocks the config-side generators: a
  **merge-into-existing-`work.json`** writer (today's writer only does
  whole-file, never-clobber writes).

---

## 1. What ships today

Two commands, dispatched command-first in `src/cli.ts:436-441`:

- **`work init`** (`src/init/index.ts`) — project bootstrap. Writes
  `.workflows/<template>.yaml`, always adds `work.json` if the template didn't
  (`src/init/index.ts:88-91`), and with `--include-skill` drops a developer
  SKILL.md to **both** `.claude/skills/work-workflows/` and
  `.agents/skills/work-workflows/` (`src/scaffold/templates.ts:239-244`).
  `--global` writes the XDG machine-wide config instead
  (`src/init/index.ts:99-121`), idempotently. Flags: `--project`, `--global`,
  `--include-skill`, `--from-template|-t`, `--force|-f`, `--dry-run`
  (`src/init/index.ts:46-80`).
- **`work create <name>`** (`src/scaffold/index.ts`) — scaffold one workflow by
  user-chosen name. Guards declared-`name:` uniqueness across `.workflows/`
  (`src/scaffold/index.ts:102-110`) and filename collision
  (`:112-117`). Flags: `--template|-t`, `--force|-f`, `--dry-run`.

**Templates** (`src/scaffold/templates.ts:20`):

| Template | Files produced | Source |
|---|---|---|
| `hello-world` | `.workflows/<name>.yaml` (one gondolin job, one `run:` echo) | `templates.ts:40-56` |
| `agent-action` | `.workflows/<name>.yaml` + `.workflows/actions/<name>/{action.yaml,prompt.md}` + `work.json` | `templates.ts:58-135` |

Token substitution is a blunt `{{name}}` replace (`templates.ts:36-38`),
deliberately spaceless so it never collides with the agent runner's `{{ input }}`
placeholders.

### Why the machinery is good

Per the original design record, the hard parts are already reused for free:

- **Generated files are compiled with the real compiler before being written** —
  `assertValidWorkflow` runs `parseWorkflow`/`compile` so template drift fails at
  scaffold time, not at the user's first run (`src/scaffold/index.ts:77`,
  `:100`).
- **Pure builder / impure writer split**: `scaffoldFiles()` returns a
  `Map<path, contents>` (`templates.ts:154-171`); `planWrites`/`executeWrites`
  own the skip/force/dry-run policy and never clobber `work.json`
  (`src/scaffold/write.ts:26-42`).
- **Slugging** enforces the action charset `^[a-z0-9][a-z0-9-]*$`
  (`src/scaffold/slug.ts`), so a name is safe as a filename, a declared `name:`,
  and a `uses: action/<name>` ref in one shot.

Adding a generator is genuinely cheap: a new string constant + a `TEMPLATES`
entry, and it inherits validation, write policy, and dry-run.

---

## 2. Usefulness assessment

**Useful, but front-loaded and narrow.** What works well:

- `init` → `work run hello-world` is a real 2-command cold start, idempotent and
  safe to re-run.
- `create --template agent-action` is the *only* place a user sees the full
  agent-over-composite-action shape assembled correctly — it's the best teaching
  artifact in the product.

Where it falls short:

- **One hardcoded provider.** Every generated `work.json` targets
  Fireworks/Kimi with `$FIREWORKS_API_KEY`, and the epilogues hardcode that var
  (`templates.ts:119-135`; `init/index.ts:151`). No flag to pick a provider/model.
- **Single-job only.** No template exercises `needs`, `matrix`, typed `inputs`,
  conditionals, or step outputs — the features that make the engine worth using
  over a shell script.
- **`init` can't name the workflow** — it's always named after the template slug
  (`src/init/index.ts:129`). `work init --from-template agent-action` then
  `work run agent-action`.
- **Drift footgun in the starter config.** `STARTER_CONFIG` uses
  `maxTokens: 2048` and omits the `webhooks` block, while the comment claims it
  "mirrors `work.example.json`" — which uses `32768` and includes webhooks
  (`templates.ts:118,131`). Minor, but it's a claimed-mirror that isn't one.

---

## 3. Docs-site coverage

**Accurate, correctly cross-linked, but minimal — and there is no dedicated
page.**

- **Canonical home:** `docs-site/reference/cli.md` — `### work init`
  (`cli.md:39-71`) and `### work create` (`cli.md:72-97`). Both are thorough and
  match the source, including the idempotency contract and the
  validate-before-write guarantee.
- **Guide tips** cross-link from `quickstart.md:7-19`, `project-layout.md:17-22`,
  `agent-steps.md:49-53,85`, `composite-actions.md:59-60`.
- **Onboarding pivots away fast.** `quickstart.md:7-19` opens with `work init` as
  "the fastest start," then line 21 says "the rest of this page hand-writes the
  YAML" and never returns to the scaffolder. `work init` is **not** mentioned on
  `index.md`, `introduction.md`, or `installation.md`, so a user who stops at
  Installation never learns it exists.

### Doc gaps

- **No "Scaffolding"/"Generators" page** and no sidebar entry for one
  (`docs-site/.vitepress/config.ts:58-107`). Coverage is reference-only +
  incidental tips.
- **Template outputs are never shown.** No page displays the generated
  `hello-world.yaml`, the `agent-action` manifest/prompt, or the starter
  `work.json`. Users can't preview what they'll get.
- **`--include-skill` under-documented** — described as one `SKILL.md`
  (`cli.md:67`); it actually writes two files (Claude Code + Amp).
- **`-t` short flag** for `--from-template` is undocumented.
- **`init --from-template agent-action` filename** (`.workflows/agent-action.yaml`)
  is left implicit; only the `hello-world` filename is shown concretely.

### Existing design doc

[`init-doctor-scaffolding-research.md`](init-doctor-scaffolding-research.md) is
the one `docs/` record on this surface (indexed in `docs/README.md:69-71`). It is
correctly framed as a rationale record ("read it for the rationale, not as a map
of current code"), and several of its specifics have since diverged from shipped
code — it proposed ~11 templates and an agent-*package* shape; the tree ships 2
templates and the composite-*action* shape. **This document supersedes its
catalog/coverage sections; that doc remains the authority on the design
rationale.**

---

## 4. Unaccounted-for use-cases (ranked)

The full hand-authored surface a user touches today: workflow YAML, `work.json`
(providers/models/secrets/webhooks), composite **and** JS action packages,
custom-image `build-config.json`, and (optional) the developer skill. Only two of
these have any generator. The gaps, by payoff:

### 4.1 `create action <name>` — action packages (HIGH)

**Hand-authored today.** An action is `.workflows/actions/<name>/action.yaml`
plus, for JS actions, an `index.mjs` against the `INPUT_<NAME>` /
`$WORK_OUTPUT` ABI (`src/actions/load.ts:91-118`;
`test/e2e/js-action/.workflows/actions/greet/index.mjs`). A user must hand-wire
the `runs.using: node|composite` discriminant, the `inputs:`/`outputs:` grammar,
and output `value:` expressions — the most error-prone ABI in the product.

**Why it helps.** Largest boilerplate surface; the `agent-action` template
already proves the engine can scaffold a (composite) action correctly — this just
generalizes it. Two sub-flavors (`--using node|composite`) mirror the two
existing e2e examples, and the generated `action.yaml` validates through
`loadAction` for the same free safety net.

### 4.2 Secret / webhook config generator (HIGH — the user's hypothesis)

**Hand-authored today, with no example to copy.** Secrets and webhooks live
in `work.json` (`src/config/index.ts:41-96`). A repo-wide search found **no
`secrets:` block anywhere** — not in examples, not in tests. A user learns the
shape only from doc comments: each entry keys a name to either a literal or a
`$VAR` env ref (`$GRAFANA_SERVICE_ACCOUNT_TOKEN`), resolved host-side at run
time and addressed in a workflow as `${{ secrets.NAME }}` (`src/config/index.ts:41-63`).

**Why it helps most per line.** This is security-critical config with real
footguns: a secret value should be a `$VAR` ref, not a committed literal, and the
whitelist is the explicit boundary for what a guest may see. A
correct-by-construction generator (a `$VAR`-ref value never a literal, the right
key casing) is the only worked reference a user would have. The user's hypothesis
is well-founded and is the strongest single gap.

Webhooks are the natural pair: a webhook needs a workflow-side `on: webhook:`
declaration **and** a name-matched `webhooks.<name>` config entry
(`src/spec/types.ts:151`, `config/index.ts:72-85`), cross-validated post-merge.
A generator that emits both halves with matching names is exactly the kind of
two-sided coordination scaffolding is good at.

**The one new piece of infrastructure these need:** `work.json` is JSON and the
current writer only does whole-file, never-clobber writes
(`src/scaffold/write.ts`; `init/index.ts:88`). A secret/webhook generator
must **merge into** an existing `work.json` (read → `parsePartialConfig` → merge →
re-validate via `parseConfig` → write). This is the shared prerequisite for §4.2
and the webhook pairing.

### 4.3 Workflow-template variety (MEDIUM)

`test/e2e/` is already a curated, comment-rich gallery of every spec feature:
`matrix-build`, `fan-out-fan-in`, `input-validation`, `conditional-steps`,
`step-outputs`, `machine-types`, `reusable-basic` (`on: workflow_call`). Promoting
a few to `create --template` is cheap (parameterize an existing body by
`{{name}}`, re-validate for free). Apply the AGENTS.md deletion test: a
`reusable-workflow` template earns its keep (multi-file, the `on: workflow_call`
opt-in is non-obvious — `src/spec/types.ts:170`); a bare `matrix` template is more
marginal since it's copy-from-docs pure YAML with no ABI or footgun.

### 4.4 Custom-image scaffold (LOW–MEDIUM)

A custom `runs-on` target is `.workflows/images/<variant>/build-config.json`
(gondolin build-config, passed through opaquely).
Niche, but the path convention and JSON shape are undiscoverable without an
example; a `create image <name>` skeleton would be a small, high-clarity win for
the users who need it. See [`gondolin-custom-images.md`](gondolin-custom-images.md).

### 4.5 Provider presets (LOW)

Provider/model config is already scaffolded; the only refinement is additional
presets beyond Fireworks/Kimi (e.g. an Anthropic / OpenAI-compatible variant),
selectable via an `init --provider` flag.

---

## 5. Recommendations

1. **Build the merge-into-`work.json` writer first** — it's the unlock for the two
   highest-value config generators and is a contained addition to
   `src/scaffold/write.ts`.
2. **Ship `create action <name>` (`--using node|composite`)** — biggest
   boilerplate/ABI surface, and the pattern is already proven by `agent-action`.
3. **Ship a secret generator** (`create secret <name>` that merges a
   `secrets.<name>` entry via the config-merge writer, with an optional paired
   `webhooks.<name>`) — the strongest correctness payoff and the only worked
   `secrets:` reference in the product. Pairs with
   [`tailnet-incident-response-research.md`](tailnet-incident-response-research.md),
   which is entirely secret + webhook driven.
4. **Add a docs-site "Scaffolding" guide page** with a sidebar entry that shows
   the actual generated output for each template, documents `--include-skill`'s
   dual write, the `-t` alias, and the `init` filename-from-template rule.
5. **Low-cost polish:** fix the `STARTER_CONFIG` "mirrors `work.example.json`"
   drift (`maxTokens`, webhooks block), and promote `reusable-basic` from the e2e
   gallery to a `create --template reusable-workflow`.

---

## 6. Sources

Implementation: `src/scaffold/{index,templates,write,slug}.ts`,
`src/init/index.ts`, `src/cli.ts:436-441`, `src/config/index.ts:41-96`,
`src/actions/load.ts`, `src/agent/egress.ts`, `src/spec/types.ts:151-186`,
`src/doctor/checks.ts`. Docs: `docs-site/reference/cli.md:39-97`,
`docs-site/guide/{quickstart,project-layout,agent-steps,composite-actions}.md`,
`docs-site/.vitepress/config.ts`. Prior record:
[`init-doctor-scaffolding-research.md`](init-doctor-scaffolding-research.md).
</content>
</invoke>
