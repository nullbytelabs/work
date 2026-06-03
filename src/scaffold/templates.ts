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
  files.set(CONFIG_FILENAME, JSON.stringify(STARTER_CONFIG, null, 2) + "\n");
  return files;
}
