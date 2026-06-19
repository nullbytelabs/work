/**
 * Matrix expansion — turn a `strategy.matrix` into a concrete list of cells.
 *
 * Absurd has no native fan-out primitive (see docs/absurd-durable-workflows.md);
 * the compiler synthesizes it by expanding the matrix here and emitting one
 * independent `PlannedJob` per cell. Each cell is the resolved `${{ matrix.* }}`
 * context for its leg.
 *
 * Semantics follow GitHub Actions:
 *   - the named axes expand to their full cartesian product;
 *   - `exclude` prunes any cell that matches all key/values of an exclude entry;
 *   - `include` extends matching cells with extra keys (without overwriting an
 *     axis value), or appends a standalone cell when it matches nothing.
 *
 * `include`'s full GHA algorithm is subtle; this implements the common,
 * well-behaved subset and is documented as such.
 */
import type { MatrixSpec, MatrixValue } from "../spec/index.ts";

export type MatrixCell = Record<string, MatrixValue>;

function eqVal(a: MatrixValue | undefined, b: MatrixValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return String(a) === String(b);
}

/** Expand a matrix spec into its ordered list of cells. */
export function expandMatrix(matrix: MatrixSpec): MatrixCell[] {
  const axisNames = Object.keys(matrix.axes);

  // Cartesian product of the declared axes (an axis-less matrix starts empty
  // and is defined entirely by `include`).
  let cells: MatrixCell[] = axisNames.length > 0 ? [{}] : [];
  for (const name of axisNames) {
    const values = matrix.axes[name]!;
    const next: MatrixCell[] = [];
    for (const cell of cells) {
      for (const v of values) next.push({ ...cell, [name]: v });
    }
    cells = next;
  }

  // exclude (applied before include, per GHA).
  if (matrix.exclude) {
    cells = cells.filter(
      (cell) =>
        !matrix.exclude!.some((ex) => Object.entries(ex).every(([k, v]) => eqVal(cell[k], v))),
    );
  }

  // include: extend matching cells, else append as a new standalone cell.
  if (matrix.include) {
    for (const inc of matrix.include) {
      const overlapAxes = axisNames.filter((a) => a in inc);
      let matched = false;
      for (const cell of cells) {
        if (overlapAxes.length > 0 && overlapAxes.every((a) => eqVal(cell[a], inc[a]))) {
          for (const [k, v] of Object.entries(inc)) {
            if (!axisNames.includes(k)) cell[k] = v; // never overwrite an axis value
          }
          matched = true;
        }
      }
      if (!matched) cells.push({ ...inc });
    }
  }

  return cells;
}

/** Sanitize a value into a leg-id fragment. The keep set is the intersection of
 *  path-safe AND expression-grammar-safe (`[A-Za-z_][\w-]*`): a leg id becomes a
 *  reusable-call namespace prefix that appears in `${{ needs.<id>.outputs.* }}`
 *  expressions, so a `.` (e.g. a version cell `1.5`) must be replaced — the runtime
 *  `needs.*` resolver's grammar has no `.` and would reject the namespaced id. */
function safe(v: MatrixValue): string {
  return String(v).replace(/[^A-Za-z0-9-]+/g, "-");
}

/**
 * A deterministic, path-safe id suffix for a cell: declared axes first (in
 * declaration order), then any include-only keys alphabetically. Used to build
 * `<base>::<suffix>` job ids that are stable across runs.
 */
export function cellId(cell: MatrixCell, axisOrder: string[]): string {
  const extra = Object.keys(cell)
    .filter((k) => !axisOrder.includes(k))
    .sort();
  const keys = [...axisOrder.filter((a) => a in cell), ...extra];
  // Sanitize keys as well as values: axis/include key names are unvalidated at
  // parse time (src/spec/parse.ts), so a key like `os/arch` would otherwise leak
  // a path separator into the id, breaking the path-safe contract (plan.ts:41).
  return keys.map((k) => `${safe(k)}-${safe(cell[k]!)}`).join("_");
}

/** A human-readable leg label, e.g. `test (node=20, os=ubuntu)`. */
export function cellLabel(baseId: string, cell: MatrixCell, axisOrder: string[]): string {
  const extra = Object.keys(cell)
    .filter((k) => !axisOrder.includes(k))
    .sort();
  const keys = [...axisOrder.filter((a) => a in cell), ...extra];
  if (keys.length === 0) return baseId;
  return `${baseId} (${keys.map((k) => `${k}=${cell[k]}`).join(", ")})`;
}
