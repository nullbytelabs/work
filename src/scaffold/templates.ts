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
 *   - config.json     → CODEGEN — JSON is comment-free and strictly parsed, so
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
export const CONFIG_FILENAME = "pi-workflows.config.json";

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
    runs-on: gondolin # the secure micro-VM (the default and only target)
    steps:
      - name: greet
        run: |
          echo "$GREETING from {{name}}"
`;

const AGENT_WORKFLOW_YAML = `# {{name}}
# description: run an AI agent step inside the sandbox, then use its output
# usage: work run {{name}} --config ${CONFIG_FILENAME}
#
# The agent package lives in ${WORKFLOWS_DIR}/agents/{{name}}/ (uses: agent/{{name}}).
# An agent step needs a model — see ${CONFIG_FILENAME} (fill in a real $API_KEY).
---
name: {{name}}

jobs:
  {{name}}:
    runs-on: gondolin
    outputs:
      result: \${{ steps.agent.outputs.summary }}
    steps:
      - id: agent
        name: run the {{name}} agent
        uses: agent/{{name}}

      - name: show result
        env:
          RESULT: \${{ steps.agent.outputs.summary }}
        run: |
          echo "result -> $RESULT"
`;

const AGENT_MANIFEST_YAML = `# Agent package manifest for \`uses: agent/{{name}}\` — supplied by THIS project,
# not the engine (the action.yml analog). See docs/agent-uses-interface.md.
# Today's runner uses instructions + task + inputs/outputs; skills/extensions are future.
name: {{name}}
description: <one line describing what this agent does>

# Declare inputs here to thread step outputs in via the step's \`with:\`; bind them
# into task.md with {{ input_name }} placeholders. Omit when the agent just reads
# the workspace.

outputs:
  summary:
    description: The agent's final message.
`;

const AGENT_INSTRUCTIONS_MD = `You are a helpful agent operating inside a sandboxed workspace. Read the project files in your working directory and complete the task. Output only the result — no preamble, labels, or quotes.
`;

const AGENT_TASK_MD = `Describe the task for the {{name}} agent here. The agent runs in the job's
workspace (the checkout) and can read the files directly.
`;

/** The starter project config (codegen). Mirrors pi-workflows.config.example.json. */
const STARTER_CONFIG = {
  providers: {
    fireworks: {
      baseUrl: "https://api.fireworks.ai/inference/v1",
      apiKey: "$FIREWORKS_API_KEY",
    },
  },
  models: {
    kimi: {
      provider: "fireworks",
      model: "accounts/fireworks/models/kimi-k2p6",
      maxTokens: 2048,
      temperature: 0,
    },
  },
  defaultModel: "kimi",
};

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

  // agent-action: workflow + agent package + starter config.
  files.set(workflowPath(name), render(AGENT_WORKFLOW_YAML, name));
  const agentDir = `${WORKFLOWS_DIR}/agents/${name}`;
  files.set(`${agentDir}/agent.yaml`, render(AGENT_MANIFEST_YAML, name));
  files.set(`${agentDir}/instructions.md`, render(AGENT_INSTRUCTIONS_MD, name));
  files.set(`${agentDir}/task.md`, render(AGENT_TASK_MD, name));
  const cfg = starterConfigFile();
  files.set(cfg.path, cfg.contents);
  return files;
}

/**
 * The starter project config (codegen). `init` always writes this; the writer
 * preserves an existing one (it may hold real creds). Mirrors the
 * `pi-workflows.config.example.json` shape — `apiKey` is an `$ENV` ref, never a
 * literal secret.
 */
export function starterConfigFile(): { path: string; contents: string } {
  return { path: CONFIG_FILENAME, contents: JSON.stringify(STARTER_CONFIG, null, 2) + "\n" };
}

// A skill for the developer's OWN coding agent (Claude Code / Amp) — files on
// disk that teach *their* assistant to author and drive the `work` CLI. This is
// unrelated to the engine's in-gondolin agent steps (two different "agents").
// A single SKILL.md works in both editors; the `description` drives auto-discovery.
const SKILL_MD = `---
name: work-workflows
description: Author and run GitHub-Actions-style workflows with the \`work\` CLI in this repo. Use when asked to write, run, inspect, or debug a workflow, a .workflows/*.yaml file, or an \`agent/\` step.
---

# Authoring \`work\` workflows

This repo uses the **work** CLI to run GitHub-Actions-style workflows locally —
each job isolated in a gondolin micro-VM, with optional AI agent steps.

## Layout
- Workflows live in \`${WORKFLOWS_DIR}/<file>.yaml\`; you run one by its declared
  \`name:\` (not its filename).
- Agent packages live in \`${WORKFLOWS_DIR}/agents/<name>/\` and are referenced as
  \`uses: agent/<name>\`.
- Provider/model config for agent steps is \`${CONFIG_FILENAME}\` (\`$ENV\` refs for keys).

## Spec shape
\`\`\`yaml
name: <unique name>          # how you invoke it: work run <name>
env: { KEY: value }          # optional workflow-level env
jobs:
  <job-id>:
    runs-on: gondolin        # the only target (the default)
    needs: [<other-job>]     # optional dependencies
    strategy:
      matrix: { k: [a, b] }  # optional fan-out
    steps:
      - name: <label>
        run: echo hi         # a shell step (run XOR uses)
      - id: review
        uses: agent/<name>   # an agent step
\`\`\`
A step has \`run\` **or** \`uses\`, never both. Typed \`inputs\` are validated at compile time.

## Commands
- \`work create <name>\` — scaffold a new workflow (\`--template hello-world|agent-action\`).
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
