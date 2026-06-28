/**
 * Scaffold templates, embedded as TS string constants.
 *
 * Why embedded (not loose files read at runtime): the published package ships
 * only `files: ["bin","dist","README.md"]` and runs as a single esbuild bundle,
 * so a `__dirname/../templates/*.yaml` read would fail once published. Inlining
 * lets esbuild bundle the templates for free and sidesteps that whole bug class.
 *
 * Split by file type (see docs/init-doctor-scaffolding-research.md §3):
 *   - YAML / markdown → TEMPLATES — the teaching header comments *are* the value,
 *     and `yaml.stringify` would drop them.
 *   - work.json       → CODEGEN — JSON is comment-free and strictly parsed, so
 *     `JSON.stringify` is exact-by-construction.
 *
 * `scaffoldFiles()` is pure: it returns the intended file map and touches no FS,
 * so it's unit-testable and the writer owns all the skip/force/dry-run policy.
 */
import { WORKFLOWS_DIR } from "../project.ts";

export const TEMPLATES = ["hello-world", "agent-action"] as const;
export type TemplateName = (typeof TEMPLATES)[number];

export function isTemplateName(s: string): s is TemplateName {
  return (TEMPLATES as readonly string[]).includes(s);
}

/** Project config filename — the project layer, found with zero flags. */
export const CONFIG_FILENAME = "work.json";

/**
 * Substitute `{{name}}` (exact token, no surrounding spaces) for the slug. The
 * no-space form deliberately avoids the agent runner's own `{{ input }}` task
 * placeholders, which carry spaces — so an agent `task.md` template passes
 * through untouched.
 */
function render(template: string, name: string): string {
  return template.replaceAll("{{name}}", name);
}

const HELLO_WORLD_YAML = `# {{name}}
# description: <what this workflow does>
# usage: work run {{name}}
---
name: {{name}}

env:
  GREETING: "hello"

jobs:
  {{name}}:
    runs-on: work:base # the secure micro-VM, our capable base image (the default)
    steps:
      - name: greet
        run: |
          echo "$GREETING from {{name}}"
`;

const AGENT_WORKFLOW_YAML = `# {{name}}
# description: run an AI agent step inside the sandbox, then use its output
# usage: work run {{name}} --config ${CONFIG_FILENAME}
#
# The agent lives in a composite action at ${WORKFLOWS_DIR}/actions/{{name}}/
# (uses: action/{{name}}) that wraps the built-in work/agent primitive.
# An agent step needs a model — see ${CONFIG_FILENAME} (fill in a real $API_KEY).
---
name: {{name}}

jobs:
  {{name}}:
    runs-on: work:base
    outputs:
      result: \${{ steps.agent.outputs.summary }}
    steps:
      - id: agent
        name: run the {{name}} action
        uses: action/{{name}}

      - name: show result
        env:
          RESULT: \${{ steps.agent.outputs.summary }}
        run: |
          echo "result -> $RESULT"
`;

const ACTION_MANIFEST_YAML = `# Composite action for \`uses: action/{{name}}\` — supplied by THIS project, not the
# engine (the action.yml analog). It wraps the built-in \`work/agent\` primitive with
# a file-backed prompt, and maps the agent's final message to a declared output.
name: {{name}}
description: <one line describing what this agent does>

# Declare inputs here to accept values from the step's \`with:\` and reference them
# in the steps below as \${{ inputs.<name> }}.

outputs:
  summary:
    description: The agent's final message.
    value: \${{ steps.run.outputs.output }}

runs:
  using: composite
  steps:
    - id: run
      uses: work/agent
      with:
        promptFile: ${WORKFLOWS_DIR}/actions/{{name}}/prompt.md
`;

// The single prompt the action feeds to work/agent. The role lives in the prompt
// itself — there is no separate system-prompt input.
const AGENT_PROMPT_MD = `You are a helpful agent operating inside a sandboxed workspace. Read the project
files in your working directory and complete the task below. Output only the
result — no preamble, labels, or quotes.

Task: describe the task for the {{name}} agent here. The agent runs in the job's
workspace (the checkout) and can read the files directly.
`;

/**
 * The starter project config — a vendor-neutral JSONC skeleton, not a working
 * setup. The engine has no business presuming a provider, a model, or tuning
 * numbers on your behalf, so every value here is a placeholder to fill in. JSONC
 * (comments + trailing commas) is accepted by the loader, so the file documents
 * its own shape. An agent step won't run until you replace the placeholders and
 * export the API key env var.
 */
const STARTER_CONFIG_JSONC = `{
  // work.json — providers + models for agent steps (\`uses: work/agent\`).
  // JSONC: comments and trailing commas are allowed. Replace every <placeholder>;
  // nothing below is a default the engine chose for you.

  // An OpenAI-compatible endpoint. The API key is injected host-side and never
  // enters the sandbox, so keep it as a $ENV reference, not a literal secret.
  "providers": {
    "<provider>": {
      "baseUrl": "https://your-endpoint.example/v1",
      "apiKey": "$YOUR_API_KEY"
    }
  },

  // Give a model a short alias, point it at a provider above, and use the
  // provider-native model id. Agent steps select one with \`model: <alias>\`.
  // Optional per-model knobs: "maxTokens", "temperature".
  "models": {
    "<model>": {
      "provider": "<provider>",
      "model": "provider/native-model-id"
    }
  },

  // Alias used when an agent step doesn't set \`model:\` in its \`with:\`.
  "defaultModel": "<model>"
}
`;

export interface ScaffoldOptions {
  /** The already-slugged workflow name (use `slug()` upstream). */
  name: string;
  template: TemplateName;
}

/** Relative POSIX path to the workflow file for a given slug. */
export function workflowPath(name: string): string {
  return `${WORKFLOWS_DIR}/${name}.yaml`;
}

/**
 * Insert a top-level block (e.g. an `on:` trigger) right after a generated
 * workflow's `name:` line. Operates on our OWN freshly-rendered template text —
 * not user-authored YAML — so the `name:` line is always present and at the top;
 * the caller re-validates the result through the real compiler before writing.
 */
export function injectAfterName(yamlText: string, block: string): string {
  if (!/^name: .+$/m.test(yamlText)) {
    throw new Error("internal: generated workflow has no `name:` line to anchor injection");
  }
  return yamlText.replace(/^(name: .+)$/m, `$1\n${block}`);
}

/**
 * The files a `create` would write, keyed by path relative to the project root.
 * Pure: no FS access, no clobber decisions — the writer applies those. The agent
 * template additionally emits its package and a starter config (an agent step is
 * useless without a model).
 */
export function scaffoldFiles(opts: ScaffoldOptions): Map<string, string> {
  const { name, template } = opts;
  const files = new Map<string, string>();

  if (template === "hello-world") {
    files.set(workflowPath(name), render(HELLO_WORLD_YAML, name));
    return files;
  }

  // agent-action: workflow + composite action (wrapping work/agent) + starter config.
  files.set(workflowPath(name), render(AGENT_WORKFLOW_YAML, name));
  const actionDir = `${WORKFLOWS_DIR}/actions/${name}`;
  files.set(`${actionDir}/action.yaml`, render(ACTION_MANIFEST_YAML, name));
  files.set(`${actionDir}/prompt.md`, render(AGENT_PROMPT_MD, name));
  const cfg = starterConfigFile();
  files.set(cfg.path, cfg.contents);
  return files;
}

/**
 * The starter project config: the commented JSONC placeholder skeleton. The
 * agent-action scaffold and `init --global` write it; the writer preserves an
 * existing `work.json` (it may hold real creds). `apiKey` is a `$ENV` ref, never
 * a literal secret.
 */
export function starterConfigFile(): { path: string; contents: string } {
  return { path: CONFIG_FILENAME, contents: STARTER_CONFIG_JSONC };
}

// A skill for the developer's OWN coding agent (Claude Code / Amp) — files on
// disk that teach *their* assistant to author and drive the `work` CLI. This is
// unrelated to the engine's in-gondolin agent steps (two different "agents").
// A single SKILL.md works in both editors; the `description` drives auto-discovery.
const SKILL_MD = `---
name: work-workflows
description: Author and run GitHub-Actions-style workflows with the \`work\` CLI in this repo. Use when asked to write, run, inspect, or debug a workflow, a .workflows/*.yaml file, an agent step, or an action.
---

# Authoring \`work\` workflows

This repo uses the **work** CLI to run GitHub-Actions-style workflows locally —
each job isolated in a gondolin micro-VM, with optional AI agent steps.

## Layout
- Workflows live in \`${WORKFLOWS_DIR}/<file>.yaml\`; you run one by its declared
  \`name:\` (not its filename).
- A step \`uses:\` is one of: \`work/agent\` (the built-in agent primitive, prompted
  via \`with:\`), \`action/<name>\` (a project action under
  \`${WORKFLOWS_DIR}/actions/<name>/\` — JavaScript or composite), or a built-in
  \`work/checkout\` / \`work/install-node\`.
- Provider/model config for agent steps is \`${CONFIG_FILENAME}\` (\`$ENV\` refs for keys).

## Spec shape
\`\`\`yaml
name: <unique name>          # how you invoke it: work run <name>
env: { KEY: value }          # optional workflow-level env
jobs:
  <job-id>:
    runs-on: work:base       # the micro-VM guest image (the default; gondolin = stock)
    needs: [<other-job>]     # optional dependencies
    strategy:
      matrix: { k: [a, b] }  # optional fan-out
    steps:
      - name: <label>
        run: echo hi         # a shell step (run XOR uses)
      - id: review
        uses: work/agent     # an agent step (prompt via with:)
        with: { prompt: "Review the checkout and summarize risks." }
\`\`\`
A step has \`run\` **or** \`uses\`, never both. Typed \`inputs\` are validated at compile time.

## Commands
- \`work create workflow <name>\` — scaffold a new workflow (\`--template hello-world|agent-action\`; add \`--webhook\` to make it webhook-triggered).
- \`work run <name>\` — run the workflow whose \`name:\` matches.
- \`work <file>.yaml\` — run an ad-hoc file directly.
- \`work graph <name>\` — print the job DAG (\`--format mermaid|dot|json|ascii\`).
- \`work doctor\` — check this machine can run gondolin workflows.
`;

/**
 * Files written by `init --include-skill`: the same SKILL.md at both editors'
 * project-scope locations. Claude Code reads `.claude/skills/`; Amp reads its
 * first-class `.agents/skills/` (and also `.claude/skills/` for compatibility),
 * so writing both covers either assistant.
 */
export function skillFiles(): Map<string, string> {
  const files = new Map<string, string>();
  files.set(".claude/skills/work-workflows/SKILL.md", SKILL_MD);
  files.set(".agents/skills/work-workflows/SKILL.md", SKILL_MD);
  return files;
}
