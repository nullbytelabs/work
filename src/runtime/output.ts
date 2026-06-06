/**
 * `$WORK_OUTPUT` parsing — GitHub-Actions `$GITHUB_OUTPUT` semantics, shared by
 * the runtime's `run:` steps and the JS-action handler (which uses the same ABI).
 */

/**
 * Parse a step's `$WORK_OUTPUT` file:
 *   - `key=value` for single-line values, and
 *   - a heredoc block for multi-line values:
 *         key<<DELIMITER
 *         line 1
 *         line 2
 *         DELIMITER
 *     (everything up to the line that exactly equals DELIMITER is the value).
 * A later write to the same key wins.
 */
export function parseOutputFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heredoc = /^([A-Za-z_][\w-]*)<<(\S+)\s*$/.exec(line);
    if (heredoc) {
      const [, key, delimiter] = heredoc as unknown as [string, string, string];
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== delimiter) body.push(lines[i++]!);
      out[key] = body.join("\n");
      continue; // i sits on the delimiter line; the for-loop's i++ steps past it
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return out;
}
