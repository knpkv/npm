/**
 * Git shell command helpers.
 *
 * @module
 * @internal
 */
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as EffectString from "effect/String"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { GitError, GitNotInstalledError } from "../GitError.js"

/**
 * Git file status codes from `git status --porcelain`.
 */
export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "ignored"
  | "unmerged"

/**
 * Parsed git status entry.
 */
export interface GitStatusEntry {
  readonly status: GitFileStatus
  readonly path: string
  readonly staged: boolean
}

/**
 * Parsed git log entry.
 */
export interface GitLogEntry {
  readonly hash: string
  readonly author: string
  readonly email: string
  readonly date: Date
  readonly message: string
}

/**
 * Convert PlatformError to GitError or GitNotInstalledError.
 */
const mapPlatformError = (
  error: unknown,
  commandStr: string
): GitError | GitNotInstalledError => {
  if (
    Predicate.isTagged(error, "SystemError")
    && Predicate.hasProperty(error, "reason")
    && error.reason === "NotFound"
  ) {
    const message = Predicate.hasProperty(error, "message") ? String(error.message) : "command not found"
    return new GitNotInstalledError({
      message: `Git not found: ${message}. Please install git.`
    })
  }
  const message = Predicate.isError(error) ? error.message : String(error)
  return new GitError({
    command: commandStr,
    message
  })
}

/**
 * Run a git command in the specified working directory.
 *
 * @param args - Git command arguments
 * @param cwd - Working directory
 * @returns Command output
 *
 * @internal
 */
export const runGit = (
  args: ReadonlyArray<string>,
  cwd: string
): Effect.Effect<string, GitError | GitNotInstalledError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const command = ChildProcess.make("git", ["-C", cwd, ...args])
    const commandStr = `git ${args.join(" ")}`

    const result = yield* spawner.string(command).pipe(
      Effect.mapError((error) => mapPlatformError(error, commandStr))
    )

    return result
  })

/**
 * Run a git command that may fail with exit code 1 (e.g., diff with no changes).
 * Returns empty string on exit code 1.
 *
 * @internal
 */
export const runGitAllowEmpty = (
  args: ReadonlyArray<string>,
  cwd: string
): Effect.Effect<string, GitError | GitNotInstalledError, ChildProcessSpawner.ChildProcessSpawner> =>
  runGit(args, cwd).pipe(
    Effect.catchIf(
      (e): e is GitError => e._tag === "GitError",
      () => Effect.succeed("")
    )
  )

/**
 * Parse git status --porcelain output.
 *
 * @param output - Raw output from `git status --porcelain`
 * @returns Parsed status entries
 *
 * @internal
 */
export const parseGitStatus = (output: string): ReadonlyArray<GitStatusEntry> => {
  if (EffectString.isEmpty(output.trim())) {
    return []
  }

  return output
    .split("\n")
    .filter((line) => line.length >= 3) // Valid lines have XY + space + path
    .map((line) => {
      const indexStatus = line[0] ?? " "
      const workTreeStatus = line[1] ?? " "
      const path = line.slice(3)

      const staged = indexStatus !== " " && indexStatus !== "?"
      const status = parseStatusCode(staged ? indexStatus : workTreeStatus)

      return { status, path, staged }
    })
}

/**
 * Parse a single status code character.
 */
const parseStatusCode = (code: string): GitFileStatus => {
  switch (code) {
    case "M":
      return "modified"
    case "A":
      return "added"
    case "D":
      return "deleted"
    case "R":
      return "renamed"
    case "C":
      return "copied"
    case "?":
      return "untracked"
    case "!":
      return "ignored"
    case "U":
      return "unmerged"
    default:
      return "modified"
  }
}

/**
 * Parse git log output with custom format.
 *
 * Uses format: hash<|>author<|>email<|>date<|>message
 *
 * @param output - Raw output from git log
 * @returns Parsed log entries
 *
 * @internal
 */
export const parseGitLog = (output: string): ReadonlyArray<GitLogEntry> => {
  if (EffectString.isEmpty(output.trim())) {
    return []
  }

  return output
    .trim()
    .split("\n")
    .flatMap((line) => {
      const parts = line.split("<|>")
      if (parts.length < 5) {
        return []
      }

      const hash = parts[0]
      const author = parts[1]
      const email = parts[2]
      const dateStr = parts[3]
      const messageParts = parts.slice(4)

      if (hash === undefined || author === undefined || email === undefined || dateStr === undefined) {
        return []
      }

      const message = messageParts.join("<|>")

      return [{
        hash: hash.trim(),
        author: author.trim(),
        email: email.trim(),
        date: new Date(dateStr.trim()),
        message: message.trim()
      }]
    })
}

/**
 * Git log format string for parseGitLog.
 *
 * @internal
 */
export const GIT_LOG_FORMAT = "%H<|>%an<|>%ae<|>%aI<|>%s"

/**
 * Check if output indicates merge conflicts.
 *
 * @param statusOutput - Output from `git status --porcelain`
 * @returns List of conflicted files
 *
 * @internal
 */
export const getConflictedFiles = (statusOutput: string): ReadonlyArray<string> => {
  const entries = parseGitStatus(statusOutput)
  return entries
    .filter((e) => e.status === "unmerged")
    .map((e) => e.path)
}
