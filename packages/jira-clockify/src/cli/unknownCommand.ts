/**
 * The one line jcf prints for a command it does not have, instead of the whole help followed by the
 * error at the bottom.
 *
 * effect/cli prints a command's full help before its "Unknown subcommand" error and offers no hook to
 * skip it, so the arguments are checked against the command tree first. Only what is certainly a
 * command name is judged; anything after a command's own flag is left to effect/cli.
 *
 * @module
 */

/** The part of an effect/cli command this check reads. */
export interface CommandTree {
  readonly name: string
  readonly unlisted: boolean
  readonly subcommands: ReadonlyArray<{ readonly commands: ReadonlyArray<CommandTree> }>
}

/** effect/cli's global flags that take a value, so the value is not mistaken for a command. */
const valueFlags: ReadonlyArray<string> = ["--completions", "--log-level"]

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

/** The names at the smallest distance from `word`, within two edits. */
const nearest = (word: string, names: ReadonlyArray<string>): ReadonlyArray<string> => {
  const scored = names.map((name) => ({ name, score: distance(name, word) })).filter(({ score }) => score <= 2)
  const best = Math.min(...scored.map(({ score }) => score))
  return scored.filter(({ score }) => score === best).map(({ name }) => name)
}

const unknownLine = (path: ReadonlyArray<string>, word: string, command: CommandTree): string => {
  const prefix = path.join(" ")
  const nested = path.length === 1 ? nestedCommands.get(word) : undefined
  const close = nearest(
    word,
    command.subcommands.flatMap((group) => group.commands).filter((child) => !child.unlisted).map((child) => child.name)
  )
  const hint = nested !== undefined
    ? ` Did you mean ${nested.join(" or ")}?`
    : close.length > 0
    ? ` Did you mean ${close.map((name) => `${prefix} ${name}`).join(" or ")}?`
    : ""
  return `${prefix}: unknown command "${word}".${hint} Run ${prefix} --help for the commands.`
}

/**
 * The error line for `args` run against `root`, or `undefined` when every command name in them is
 * real (or the first one is preceded by a command's own flag, which effect/cli judges itself).
 */
export const unknownCommandLine = (args: ReadonlyArray<string>, root: CommandTree): string | undefined => {
  const path = [root.name]
  let command = root
  for (let index = 0; index < args.length; index++) {
    const word = args[index] ?? ""
    if (word.startsWith("-")) {
      if (valueFlags.includes(word)) {
        index++
        continue
      }
      if (word.startsWith("--log-level=") || word.startsWith("--completions=")) continue
      return undefined
    }
    const children = command.subcommands.flatMap((group) => group.commands)
    if (children.length === 0) return undefined
    const child = children.find((candidate) => candidate.name === word)
    if (child === undefined) return unknownLine(path, word, command)
    path.push(child.name)
    command = child
  }
  return undefined
}
