/**
 * User-space actions — the step-level reuse unit (docs/agent-primitive-and-actions.md).
 *
 * An action is a project-owned directory (`<workflow-dir>/actions/<name>/`) with an
 * `action.yaml` manifest. This iteration ships **JavaScript** actions
 * (`runs.using: node`): arbitrary `index.mjs` run in-guest with the GitHub-faithful
 * `INPUT_*` / `$WORK_OUTPUT` ABI — the home for bespoke logic the engine never
 * sees. Composite actions (`runs.using: composite`) are a later phase.
 *
 * Like agents, actions compose in at the CLI: the durable core dispatches a
 * `uses: action/<name>` step to this handler by scheme and imports none of it.
 */
export { createActionUsesHandler, runAction, type ActionUsesHandlerOptions } from "./uses-handler.ts";
export { loadAction, loadBuiltinAction, parseActionUses, BUILTIN_ACTIONS, type LoadedAction, type ActionOutput, type CompositeStep } from "./load.ts";
export { runGuestNode, type GuestNodeDeps, type GuestNodeRequest, type GuestNodeResult } from "./guest-node.ts";
export { runComposite, type SubUsesDispatch } from "./composite.ts";
