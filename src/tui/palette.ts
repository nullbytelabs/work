/**
 * Shared ANSI palette + colour-decision helper. The run board (`render.ts`) and
 * the `doctor` checklist both draw glyphs/colour from here so their styling can't
 * drift. Pure strings + a single env/TTY policy — no I/O.
 */

const ESC = "\x1b[";

/** SGR reset sequence. */
export const RESET = `${ESC}0m`;

/** The colour codes used across the TUI. Keep this the single source of truth. */
export const CODE = {
  dim: `${ESC}2m`,
  bold: `${ESC}1m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  cyan: `${ESC}36m`,
  gray: `${ESC}90m`,
};

/**
 * Decide whether to emit colour, honouring the de-facto conventions the rest of
 * the CLI didn't handle before: `NO_COLOR` (any non-empty value) disables it,
 * `FORCE_COLOR` forces it on, otherwise fall back to the caller's TTY signal.
 * Precedence: FORCE_COLOR > NO_COLOR > isTTY.
 */
export function shouldColor(isTTY: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env["FORCE_COLOR"] !== undefined && env["FORCE_COLOR"] !== "" && env["FORCE_COLOR"] !== "0") return true;
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return false;
  return isTTY;
}

/** Wrap `s` in `code` (and a reset) when `on`; otherwise return it unchanged. */
export function paint(on: boolean, code: string, s: string): string {
  return on ? `${code}${s}${RESET}` : s;
}
