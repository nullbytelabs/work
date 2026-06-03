/**
 * Terminal UI for live run output — a DAG-aware status board on an interactive
 * TTY, degrading to buffered per-job blocks in CI/pipes. Pure presenters over
 * the runtime's `RunHooks`; no engine changes. See docs/tui-iteration-2.md.
 */
export { selectPresenter, detectCI, NullPresenter, BufferedPresenter, LayeredPresenter } from "./presenter.ts";
export type { Presenter, SelectOptions } from "./presenter.ts";
export { levelize, type Levels } from "./levels.ts";
export { RunStore, shortStep, type JobState, type JobPhase } from "./store.ts";
export { renderBoard, truncVisible, type RenderOpts } from "./render.ts";
export { CODE, RESET, paint, shouldColor } from "./palette.ts";
