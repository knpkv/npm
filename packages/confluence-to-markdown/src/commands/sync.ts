/**
 * Sync commands (pull, push, status) for Confluence CLI.
 */
import { Command, Options } from "@effect/cli"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { GitService } from "../GitService.js"
import { SyncEngine } from "../SyncEngine.js"

// === Pull command ===
const forceOption = Options.boolean("force").pipe(
  Options.withAlias("f"),
  Options.withDescription("Overwrite local changes")
)

const replayHistoryOption = Options.boolean("replay-history").pipe(
  Options.withDescription("Replay version history as individual git commits")
)

export const pullCommand = Command.make(
  "pull",
  { force: forceOption, replayHistory: replayHistoryOption },
  ({ force, replayHistory }) =>
    Effect.gen(function*() {
      const engine = yield* SyncEngine
      yield* Console.log("Pulling pages from Confluence...")
      const onProgress = (current: number, total: number, message: string) => {
        process.stdout.write(`\r  Replaying history: ${current}/${total} - ${message}`)
      }
      const result = yield* engine.pull({
        force,
        replayHistory,
        ...(replayHistory ? { onProgress } : {})
      })
      if (replayHistory) {
        process.stdout.write("\r" + " ".repeat(80) + "\r")
      }
      yield* Console.log(`Pulled ${result.pulled} pages`)
      if (result.commits > 0) {
        yield* Console.log(`Created ${result.commits} git commits`)
      }
      if (result.errors.length > 0) {
        yield* Console.error("Errors:", result.errors.join("\n"))
      }
    })
).pipe(Command.withDescription("Download pages from Confluence to local markdown"))

// === Push command ===
const dryRunOption = Options.boolean("dry-run").pipe(
  Options.withAlias("n"),
  Options.withDescription("Show changes without applying")
)

const messageOption = Options.text("message").pipe(
  Options.withAlias("m"),
  Options.withDescription("Revision comment message"),
  Options.optional
)

export const pushCommand = Command.make(
  "push",
  { dryRun: dryRunOption, message: messageOption },
  ({ dryRun, message }) =>
    Effect.gen(function*() {
      const engine = yield* SyncEngine
      const git = yield* GitService

      // Check for uncommitted changes
      const gitStatus = yield* git.status()
      if (gitStatus.hasChanges) {
        yield* Console.log("Uncommitted changes detected. Run 'confluence commit' first.")
        return
      }

      yield* Console.log(dryRun ? "Dry run - showing changes..." : "Pushing changes to Confluence...")
      const pushOptions = Option.isSome(message)
        ? { dryRun, message: message.value }
        : { dryRun }
      const result = yield* engine.push(pushOptions)
      if (result.pushed === 0 && result.created === 0 && result.deleted === 0) {
        yield* Console.log("Nothing to push")
      } else {
        yield* Console.log(`Pushed: ${result.pushed}, Created: ${result.created}, Deleted: ${result.deleted}`)
      }
      if (result.errors.length > 0) {
        yield* Console.error("Errors:", result.errors.join("\n"))
      }
    })
).pipe(Command.withDescription("Upload local markdown changes to Confluence"))

// === Status command ===
export const statusCommand = Command.make("status", {}, () =>
  Effect.gen(function*() {
    const engine = yield* SyncEngine
    const git = yield* GitService

    // Show git status
    const gitInit = yield* git.isInitialized()
    if (gitInit) {
      const gitStatus = yield* git.status()
      const commitCount = yield* git.log({ n: 1 }).pipe(
        Effect.map((commits) => commits.length > 0 ? "has commits" : "no commits"),
        Effect.catchAll(() => Effect.succeed("unknown"))
      )
      yield* Console.log(`Git: initialized (${commitCount})`)
      if (gitStatus.hasChanges) {
        const staged = gitStatus.entries.filter((e) => e.staged).length
        const unstaged = gitStatus.entries.filter((e) => !e.staged).length
        yield* Console.log(`  Changes: ${staged} staged, ${unstaged} unstaged`)
      }
      if (gitStatus.hasConflicts) {
        yield* Console.log(`  Conflicts: ${gitStatus.conflictedFiles.length} files`)
      }
    } else {
      yield* Console.log("Git: not initialized (run 'confluence git init')")
    }

    const result = yield* engine.status()
    yield* Console.log(`
Sync Status:
  Synced:          ${result.synced}
  Local Modified:  ${result.localModified}
  Remote Modified: ${result.remoteModified}
  Conflicts:       ${result.conflicts}
  Local Only:      ${result.localOnly}
  Remote Only:     ${result.remoteOnly}
`)
    if (result.files.length > 0 && result.synced < result.files.length) {
      yield* Console.log("Changed files:")
      for (const file of result.files) {
        if (file._tag !== "Synced" && file._tag !== "RemoteOnly") {
          yield* Console.log(`  [${file._tag}] ${file.path}`)
        } else if (file._tag === "RemoteOnly") {
          yield* Console.log(`  [${file._tag}] ${file.page.title}`)
        }
      }
    }
  })).pipe(Command.withDescription("Show sync status"))
