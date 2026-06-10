# Project Name Change: `pi-workflows` → `work`

The GitHub repo was renamed to **`nullbytelabs/work`** and the npm package is
already `@nullbytelabs/work` (bin: `work`). Every remaining reference to
`pi-workflows` needs to be retired so the source, docs, and distribution surface
tell a single story: **the product is called "work"**.

> **Goal:** zero occurrences of `pi-workflows` in committed source.
> Tests and e2e examples must still pass (`npm test`) after the change.

---

## 1. File renames (critical — build & runtime)

| From | To | Notes |
|---|---|---|
| `bin/pi-workflows.mjs` | `bin/work.mjs` | Bin shim; npm `bin.work` → `"./bin/work.mjs"` |

**Rationale:** The npm `bin` field already maps `work` → `./bin/pi-workflows.mjs`.
After the rename the path matches the name and no one has to wonder about the
mismatch.

---

## 2. Source code — fallback names & hardcoded prefixes

These are the **highest-impact** changes. Wrong fallbacks mean the CLI prints
usage as "pi-workflows" to users who invoked `work`.

| File | Change |
|---|---|
| `src/cli-util.ts` | `prog()` return `"pi-workflows"` → `"work"` |
| `src/cli.ts` | `PI_WF_PROG` fallback `"pi-workflows"` → `"work"` (3 locations) |
| `src/cli.ts` | All `"pi-workflows:"` error/message prefixes → `"work:"` |

---

## 3. Package metadata

| File | Change |
|---|---|
| `package.json` | `repository.url` `"git+https://github.com/nullbytelabs/pi-workflows.git"` → `"git+https://github.com/nullbytelabs/work.git"` |

---

## 4. Web UI (embedded HTML)

| File | Change |
|---|---|
| `src/web/client.ts` | `<title>pi-workflows — local console</title>` → `<title>work — local console</title>` |
| `src/web/client.ts` | `aria-label="pi-workflows home"` → `aria-label="work home"` |
| `src/web/client.ts` | `<b>pi-workflows</b>` → `<b>work</b>` |

---

## 5. Documentation site (`docs-site/`)

### VitePress config
| File | Change |
|---|---|
| `docs-site/.vitepress/config.ts` | `base = "/pi-workflows/"` → `base = "/work/"` |
| `docs-site/.vitepress/config.ts` | `title: "pi-workflows"` → `title: "work"` |
| `docs-site/.vitepress/config.ts` | `og:title` meta `"pi-workflows"` → `"work"` |
| `docs-site/.vitepress/config.ts` | All `github.com/nullbytelabs/pi-workflows` URLs → `github.com/nullbytelabs/work` |
| `docs-site/.vitepress/config.ts` | `github.com/nullbytelabs/pi-workflows/edit/main/...` → `github.com/nullbytelabs/work/edit/main/...` |

### Guide pages (bulk rename references in prose)
Every file below needs `pi-workflows` → `work` in prose:

- `docs-site/guide/introduction.md`
- `docs-site/guide/requirements.md`
- `docs-site/guide/installation.md` — also the clone command & `cd` directory name
- `docs-site/guide/how-it-works.md`
- `docs-site/guide/writing-workflows.md`
- `docs-site/guide/actions.md`
- `docs-site/guide/agent-steps.md`
- `docs-site/guide/builtin-actions.md`
- `docs-site/guide/composite-actions.md`
- `docs-site/guide/project-layout.md`
- `docs-site/guide/quickstart.md`
- `docs-site/guide/reusable-workflows.md`
- `docs-site/guide/web-ui.md`

### Reference pages
- `docs-site/reference/cli.md`
- `docs-site/reference/configuration.md`

### Landing page
- `docs-site/index.md`

### Docs site package
| File | Change |
|---|---|
| `docs-site/package.json` | `name` `"pi-workflows-docs"` → `"work-docs"` |
| `docs-site/package.json` | `description` `"Documentation site for pi-workflows..."` → `"Documentation site for work..."` |

### Examples
- `docs-site/examples/dogfooding.md`

---

## 6. README.md (root)

| Change |
|---|
| Title `# pi-workflows` → `# work` |
| Shields badge URLs → `github.com/nullbytelabs/work/...` |
| Docs link → `nullbytelabs.github.io/work/` |
| Clone command → `github.com/nullbytelabs/work` |
| `cd` directory name → `work` |
| `bin/pi-workflows.mjs` → `bin/work.mjs` |
| Links → `nullbytelabs.github.io/work/...` |

---

## 7. CLI usage comments in e2e workflow files

Every `# usage: ./pi-workflows ...` comment in `test/e2e/*/workflow.yaml`
becomes `# usage: ./work ...` (or `./bin/work.mjs ...` for a pathed invocation):

- `test/e2e/conditional-steps/workflow.yaml`
- `test/e2e/fan-out-fan-in/workflow.yaml`
- `test/e2e/hello-world-gondolin/workflow.yaml`
- `test/e2e/hello-world-needs/workflow.yaml`
- `test/e2e/inline-polyglot/workflow.yaml`
- `test/e2e/input-validation/workflow.yaml`
- `test/e2e/machine-types/workflow.yaml`
- `test/e2e/matrix-build/workflow.yaml`
- `test/e2e/pipeline-steps/workflow.yaml`
- `test/e2e/run-script/workflow.yaml`
- `test/e2e/step-outputs/workflow.yaml`
- `test/e2e/with-inputs/workflow.yaml`

---

## 8. Test files

| File | Change |
|---|---|
| `test/cli-runs.test.ts` | BIN path `bin/pi-workflows.mjs` → `bin/work.mjs` |
| `test/cli-recover.test.ts` | BIN path `bin/pi-workflows.mjs` → `bin/work.mjs` |
| `test/e2e/agent-project/README.md` | All `pi-workflows` → `work` |
| `test/e2e/README.md` | All `./pi-workflows` → `./work` |

---

## 9. Inline source comments (low risk, high clarity)

| File | Change |
|---|---|
| `src/cli.ts` (block comment) | `pi-workflows CLI` → `work CLI` |
| `src/cli.ts` (comment) | `pi-workflows <workflow.yaml>` → `work <workflow.yaml>` |
| `src/cli.ts` (comment) | `pi-workflows [--workspace <dir>] run <name>` → `work ...` |
| `src/project.ts` (JSDoc) | `pi-workflows [--workspace <dir>]` → `work ...` |
| `src/config/index.ts` (JSDoc) | `pi-workflows config` → `work config` |
| `src/run.ts` (comment) | `pi-workflows-*` tmp dir prefix → `work-` |
| `src/graph/emit.ts` (JSDoc) | `pi-workflows graph` → `work graph` |
| `src/graph/index.ts` (JSDoc) | `pi-workflows graph` → `work graph` |

---

## 10. Build script

| File | Change |
|---|---|
| `scripts/build.mjs` | Comment `./pi-workflows` → `./work` |

---

## 11. Research / design docs (`docs/`)

These are historical notes. The low-risk approach is a global
search-and-replace of `pi-workflows` → `work` in all prose mentions.
No code changes — just narrative consistency.

- `docs/agent-primitive-and-actions.md`
- `docs/gondolin-custom-images.md`
- `docs/init-doctor-scaffolding-research.md`
- `docs/pglite-wasm-postgres-database.md`
- `docs/pgmq-message-queues.md`
- `docs/phase-1.md`
- `docs/pi-in-gondolin.md`
- `docs/reusable-workflows.md`
- `docs/secrets-management-and-injection.md`
- `docs/tui-iteration-2.md`
- `docs/tui-research.md`
- `docs/web-ui-research.md`

---

## 12. Agent guest runner

| File | Change |
|---|---|
| `src/agent/guest-runner-script.mjs` | `PROVIDER_NAME = "pi-workflows-custom"` → `"work-custom"` |

---

## 13. Ephemeral / non-source files (skip)

| File | Notes |
|---|---|
| `.claude/settings.local.json` | Editor-local cache; skip |
| `.design-review/04-accessibility.md` | Historical audit; mention in passing only |
| `package-lock.json` | Regenerated by `npm install`; do not hand-edit |

---

## Execution order

1. **File rename:** `bin/pi-workflows.mjs` → `bin/work.mjs`
2. **`package.json`** bin path + repo URL
3. **Source fallbacks:** `src/cli-util.ts` + `src/cli.ts` (all hardcoded `pi-workflows`)
4. **Guest runner:** `src/agent/guest-runner-script.mjs` PROVIDER_NAME
5. **Source comments:** all the inline JSDoc/comment edits above
6. **Web UI:** `src/web/client.ts` title/aria/brand
7. **Tests:** bin paths in test files; e2e workflow comments
8. **Docs site:** VitePress config → guide pages → reference pages → landing → package.json
9. **README.md** (root)
10. **Research docs** in `docs/`
11. **`CLAUDE.md`** (project memory)
12. **`scripts/build.mjs`** comment
13. **Verify:** `npm test` + `npm run typecheck` + `npm run lint`

---

## Before/after quick reference

| Old name | New name |
|---|---|
| Repo | `github.com/nullbytelabs/work` |
| npm package | `@nullbytelabs/work` (already true) |
| CLI command | `work` |
| Bin file | `bin/work.mjs` |
| Error prefix | `work:` |
| Tmp dir prefix | `work-` |
| Web UI title | `work` |
| VitePress base | `/work/` |
| Provider name (agent) | `work-custom` |
