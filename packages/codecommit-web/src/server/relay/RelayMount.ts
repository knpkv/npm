/**
 * Relay inside CodeCommit web: the harness, its CodeCommit capabilities, and the one comment path.
 *
 * **Mental model**
 *
 * - **Relay never stops the server.** The store has one owner process. When a second `codecommit web`
 *   starts, or the store can't be opened, the queue and review keep working and every `/api/relay`
 *   route answers `RelayUnavailableError` with the fix.
 * - **Sessions live with the product's data.** `~/.codecommit/relay/sessions.sqlite`, in its own owner-only
 *   directory, which is also where the CLI backends start (they read nothing there; every tool is withheld).
 * - **One gate for comments.** `post_comment` reaches CodeCommit only through {@link RelayFindingPublisher},
 *   so the person's permission rules, the prompt and the audit log apply after Relay's own confirmation.
 *
 * @module
 */
import type { CacheService, ConfigService, ReadClient } from "@knpkv/codecommit-core"
import { Domain, RelayCapabilities } from "@knpkv/codecommit-core"
import { claudeCodeBackend, codexCliBackend, make, register } from "@knpkv/relay"
import type { RegisteredCapability, RelayBackend, RelayHarnessService, WriteReceipt } from "@knpkv/relay"
import { Config, Context, type Crypto, Effect, FileSystem, Layer, Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { RelayUnavailableError } from "../Api.js"
import { RelayFindingPublisher } from "../review/RelayFindingPublisher.js"
import { webCapabilities } from "./RelayWebCapabilities.js"

/** The harness when it started, or why it could not. */
export class RelayMount extends Context.Service<RelayMount, {
  readonly harness: Effect.Effect<RelayHarnessService, RelayUnavailableError>
}>()("@knpkv/codecommit-web/RelayMount") {}

const instructions = [
  "You are Relay, the assistant inside CodeCommit web.",
  "You help the person understand and act on their CodeCommit pull requests, using only the tools listed.",
  "Answer from tool results, and say which pull request each answer is about.",
  "Posting a comment always waits for the person to confirm the exact text; never claim it was posted unless a",
  "tool result says so."
].join("\n")

/** Comments Relay posts go through the server's permission gate and audit log, never the raw review client. */
export const commentPosterLayer = Layer.effect(
  RelayCapabilities.PullRequestCommentPoster,
  Effect.gen(function*() {
    const publisher = yield* RelayFindingPublisher
    return { post: publisher.post }
  })
)

/** The receipt the dock shows once a comment lands: CodeCommit's operation id and the PR in the console. */
const commentReceipt = (output: {
  readonly pullRequest: RelayCapabilities.PullRequestCoordinates
  readonly operationId: string
  readonly summary: string
}): WriteReceipt => ({
  summary: output.summary,
  providerId: output.operationId,
  link: Domain.codecommitConsoleUrl(
    output.pullRequest.region,
    output.pullRequest.repositoryName,
    output.pullRequest.pullRequestId
  )
})

/** What CodeCommit's capabilities read and write through. */
type CapabilityServices =
  | CacheService.PullRequestRepo
  | ConfigService.ConfigService
  | ReadClient.CodeCommitReadClient
  | RelayCapabilities.PullRequestCommentPoster
  | RelayFindingPublisher
  | Crypto.Crypto

const unavailable = (message: string, fix: string) =>
  Effect.succeed(RelayMount.of({ harness: Effect.fail(new RelayUnavailableError({ message, fix })) }))

/** The backends Relay runs turns on, given the directory the CLIs start in. The first is the default. */
export type RelayBackends<R> = (
  directory: string
) => Effect.Effect<readonly [RelayBackend, ...ReadonlyArray<RelayBackend>], never, R>

/** Claude Code (the default for new sessions) and Codex, each on the user's own CLI login. */
export const cliBackends: RelayBackends<ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem> = (
  directory
) =>
  Effect.gen(function*(): Effect.fn.Return<
    readonly [RelayBackend, ...ReadonlyArray<RelayBackend>],
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
  > {
    const claude = yield* claudeCodeBackend({ cwd: directory })
    const codex = yield* codexCliBackend({ cwd: directory })
    return [claude, codex]
  })

/** Start Relay for this server with these backends, or record why it can't run. */
export const relayMountLayerWith = <R>(backends: RelayBackends<R>) =>
  Layer.effect(
    RelayMount,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* Config.String("HOME").pipe(Config.orElse(() => Config.String("USERPROFILE")))
      const directory = path.join(home, ".codecommit", "relay")
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
      const available = yield* backends(directory)
      const capabilities = RelayCapabilities.capabilities
      const registered: ReadonlyArray<RegisteredCapability<CapabilityServices>> = [
        register(capabilities.getPullRequest),
        register(capabilities.listPullRequests),
        register(webCapabilities.getPullRequestDiff),
        register(capabilities.postComment, { receipt: commentReceipt }),
        register(webCapabilities.postLineComment, { receipt: commentReceipt })
      ]
      const harness = yield* make({
        storePath: path.join(directory, "sessions.sqlite"),
        instructions,
        capabilities: registered,
        backends: available
      })
      return RelayMount.of({ harness: Effect.succeed(harness) })
    }).pipe(
      Effect.catchTags({
        RelayStoreLocked: ({ message }) =>
          unavailable(message, "Another codecommit web owns Relay's sessions. Stop it, then restart this one."),
        RelayStoreFailed: ({ message }) =>
          unavailable(message, "Check that ~/.codecommit/relay is owned by you and writable, then restart."),
        ConfigError: () => unavailable("HOME is not set.", "Start codecommit web from a login shell."),
        // The store refuses a linked directory or database file before it chmods or opens anything.
        RelayStoreLinked: (failure) =>
          Effect.logWarning("Relay refused a linked data directory", failure).pipe(
            Effect.andThen(
              unavailable(
                "~/.codecommit/relay is a link.",
                "Replace ~/.codecommit/relay with a directory you own, then restart."
              )
            )
          )
      }),
      Effect.catchTag("PlatformError", (failure) =>
        Effect.logWarning("Relay could not start", failure).pipe(
          Effect.andThen(
            unavailable(
              "Relay could not prepare its data directory.",
              "Check that ~/.codecommit is owned by you and writable, then restart."
            )
          )
        ))
    )
  )

/** Start Relay for this server on the user's CLI logins, or record why it can't run. */
export const relayMountLayer = relayMountLayerWith(cliBackends)
