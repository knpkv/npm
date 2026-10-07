/**
 * The one line jcf prints for a command it does not have, instead of the whole help followed by the
 * error at the bottom.
 *
 * @module
 */

/** Where the common second-level commands live, for a first argument that names one of them. */
const nestedCommands = new Map<string, ReadonlyArray<string>>([
  ["status", ["jcf auth status", "jcf timer status"]],
  ["start", ["jcf timer start"]],
  ["stop", ["jcf timer stop"]],
  ["log", ["jcf timer log"]],
  ["list", ["jcf issue list"]],
  ["reconcile", ["jcf sync reconcile"]],
  ["show", ["jcf config show"]],
  ["login", ["jcf auth jira token"]],
  ["week", ["jcf sync reconcile --week", "the week view: jcf-web"]]
])

const distance = (left: string, right: string): number => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row++) {
    let diagonal = previous[0] ?? 0
    previous[0] = row
    for (let column = 1; column <= right.length; column++) {
      const above = previous[column] ?? 0
      previous[column] = Math.min(
        above + 1,
        (previous[column - 1] ?? 0) + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1)
      )
      diagonal = above
    }
  }
  return previous[right.length] ?? 0
}

/**
 * The error line for `args`, or `undefined` when the first argument is one of `topLevelCommands`, a
 * flag, or absent (bare `jcf` opens the terminal UI).
 */
export const unknownCommandLine = (
  args: ReadonlyArray<string>,
  topLevelCommands: ReadonlyArray<string>
): string | undefined => {
  const first = args[0]
  if (first === undefined || first.startsWith("-") || topLevelCommands.includes(first)) return undefined
  const nested = nestedCommands.get(first)
  const close = topLevelCommands.filter((name) => distance(name, first) <= 2)
  const hint = nested !== undefined
    ? ` Did you mean ${nested.join(" or ")}?`
    : close.length > 0
    ? ` Did you mean jcf ${close.join(" or jcf ")}?`
    : ""
  return `jcf: unknown command "${first}".${hint} Run jcf --help for the commands.`
}
