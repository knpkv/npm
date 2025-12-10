/**
 * Git commands (commit, log, diff) for Confluence CLI.
 */
import { Args, Command, Options } from "@effect/cli"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { ConfluenceConfig } from "../ConfluenceConfig.js"
import { GitService } from "../GitService.js"

// === Commit command ===
const commitMessageOption = Options.text("message").pipe(
  Options.withAlias("m"),
  Options.withDescription("Commit message"),
  Options.optional
)

export const commitCommand = Command.make(
  "commit",
  { message: commitMessageOption },
  ({ message }) =>
    Effect.gen(function*() {
      const git = yield* GitService
      const config = yield* ConfluenceConfig

      // Sync from external docs path to .confluence/ (skips if docsPath is inside .confluence/)
      yield* git.syncFromDocs(config.docsPath, config.trackedPaths)

      yield* git.addAll()
      const msg = Option.isSome(message) ? message.value : "Manual commit"
      const hash = yield* git.commit({ message: msg })
      yield* Console.log(`Committed: ${hash.substring(0, 7)}`)
    })
).pipe(Command.withDescription("Stage and commit current changes"))

// === Log command ===
const logLimitOption = Options.integer("limit").pipe(
  Options.withAlias("n"),
  Options.withDescription("Number of commits to show"),
  Options.withDefault(10)
)

const logOnelineOption = Options.boolean("oneline").pipe(
  Options.withDescription("Show compact one-line format")
)

const logSinceOption = Options.text("since").pipe(
  Options.withDescription("Show commits since date (e.g., '2024-01-01')"),
  Options.optional
)

const logFileArg = Args.text({ name: "file" }).pipe(Args.optional) as Args.Args<Option.Option<string>>

export const logCommand = Command.make(
  "log",
  { limit: logLimitOption, oneline: logOnelineOption, since: logSinceOption, file: logFileArg },
  ({ file, limit, oneline, since }) =>
    Effect.gen(function*() {
      const git = yield* GitService
      const opts = {
        n: limit,
        oneline,
        ...(Option.isSome(since) ? { since: since.value } : {}),
        ...(Option.isSome(file) ? { file: file.value } : {})
      }
      const commits = yield* git.log(opts)
      if (commits.length === 0) {
        yield* Console.log("No commits yet")
      } else if (oneline) {
        for (const commit of commits) {
          yield* Console.log(`${commit.hash.substring(0, 7)} ${commit.message}`)
        }
      } else {
        for (const commit of commits) {
          yield* Console.log(`commit ${commit.hash}`)
          yield* Console.log(`Author: ${commit.author} <${commit.email}>`)
          yield* Console.log(`Date:   ${commit.date.toISOString()}`)
          yield* Console.log(`\n    ${commit.message}\n`)
        }
      }
    })
).pipe(Command.withDescription("Show commit history"))

// === Diff command ===
const diffStagedOption = Options.boolean("staged").pipe(
  Options.withDescription("Show staged changes")
)

const diffCommitOption = Options.text("commit").pipe(
  Options.withDescription("Compare with specific commit"),
  Options.optional
)

const diffFileArg = Args.text({ name: "file" }).pipe(Args.optional) as Args.Args<Option.Option<string>>

export const diffCommand = Command.make(
  "diff",
  { staged: diffStagedOption, commit: diffCommitOption, file: diffFileArg },
  ({ commit, file, staged }) =>
    Effect.gen(function*() {
      const git = yield* GitService
      const opts = {
        staged,
        ...(Option.isSome(commit) ? { commit: commit.value } : {}),
        ...(Option.isSome(file) ? { file: file.value } : {})
      }
      const diff = yield* git.diff(opts)
      if (diff === "") {
        yield* Console.log("No changes")
      } else {
        yield* Console.log(diff)
      }
    })
).pipe(Command.withDescription("Show changes in working directory"))
