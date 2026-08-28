import { AwsClient, CacheService, ChildEnv, type Domain, type Errors, PRService } from "@knpkv/codecommit-core"
import { Effect, Predicate, Schema, Stream } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import {
  browserLauncherSucceeded,
  clipboardCommandSucceeded,
  controlCenterIdentityRequestInit,
  controlCenterOriginConfiguration,
  isControlCenterManagedReviewIdentity,
  managedReviewIdentityContentLengthAllowed,
  manualReviewHandoffMessage,
  MAXIMUM_CONTROL_CENTER_IDENTITY_BYTES,
  planControlCenterReviewHandoff,
  resolveControlCenterOrigin
} from "../../managed-review.js"
import { assumeConsoleArgs } from "../browser-command.js"
import { fetchPrComments } from "../comment-fetch.js"
import { runtimeAtom, TuiApplicationScope } from "./runtime.js"

export { fetchPrComments } from "../comment-fetch.js"

// ---------------------------------------------------------------------------
// Shared Helpers
// ---------------------------------------------------------------------------

export interface CreatePRInput {
  readonly repositoryName: string
  readonly title: string
  readonly description?: string
  readonly sourceBranch: string
  readonly destinationBranch: string
  readonly account: Domain.Account
}

export interface ListBranchesInput {
  readonly repositoryName: string
  readonly account: Domain.Account
}

const notifyError = Effect.fn("notifyError")(function*(title: string, error: Errors.AwsClientError) {
  const notificationRepo = yield* CacheService.NotificationRepo
  yield* notificationRepo.addSystem({
    type: "error",
    title,
    message: error.message
  })
})

const exitCode = (command: ChildProcess.Command) =>
  Effect.scoped(command.pipe(Effect.flatMap((handle) => handle.exitCode)))

class BrowserLaunchExitError extends Schema.TaggedError<BrowserLaunchExitError>()(
  "BrowserLaunchExitError",
  { command: Schema.String, exitCode: Schema.Int }
) {}

class ClipboardCopyExitError extends Schema.TaggedError<ClipboardCopyExitError>()(
  "ClipboardCopyExitError",
  { command: Schema.String, exitCode: Schema.Int }
) {}

const successfulBrowserExit = <Exit extends number, Error, Requirements>(
  command: string,
  effect: Effect.Effect<Exit, Error, Requirements>
) =>
  effect.pipe(
    Effect.flatMap((code) =>
      browserLauncherSucceeded(code)
        ? Effect.void
        : Effect.fail(new BrowserLaunchExitError({ command, exitCode: code }))
    )
  )

export const copyToClipboard = Effect.fn("copyToClipboard")(
  function*(text: string) {
    const copyWith = (command: string, args: ReadonlyArray<string> = []) =>
      exitCode(ChildProcess.make(command, args, {
        stdin: Stream.make(text).pipe(Stream.encodeText)
      })).pipe(
        Effect.flatMap((code) =>
          clipboardCommandSucceeded(code)
            ? Effect.succeed(true)
            : Effect.fail(new ClipboardCopyExitError({ command, exitCode: code }))
        )
      )

    return yield* copyWith("pbcopy").pipe(
      Effect.catchIf(() => true, () => copyWith("wl-copy")),
      Effect.catchIf(() => true, () => copyWith("xclip", ["-selection", "clipboard"])),
      Effect.catchIf(() => true, () => copyWith("clip.exe"))
    )
  },
  Effect.catchIf(() => true, (error) =>
    Effect.gen(function*() {
      const notificationRepo = yield* CacheService.NotificationRepo
      yield* notificationRepo.addSystem({
        type: "error",
        title: "Clipboard",
        message: Predicate.isError(error) ? error.message : String(error)
      })
      return false
    }))
)

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

/**
 * Log in to AWS SSO
 * @category atoms
 */
export const loginToAwsAtom = runtimeAtom.fn((profile: Domain.AwsProfileName) =>
  Effect.gen(function*() {
    const notificationRepo = yield* CacheService.NotificationRepo
    const ownerScope = yield* TuiApplicationScope

    if (profile.trim().length === 0) {
      yield* notificationRepo.addSystem({
        type: "error",
        title: "SSO Login",
        message: "No profile specified"
      })
      return
    }

    yield* notificationRepo.addSystem({
      type: "info",
      title: "SSO Login",
      message: `Opening browser for ${profile}...`
    })

    yield* Effect.forkIn(
      exitCode(ChildProcess.make("aws", ["sso", "login", "--profile", profile], {
        stdout: "inherit",
        stderr: "inherit"
      })).pipe(
        Effect.tap(() =>
          notificationRepo.addSystem({
            type: "success",
            title: "SSO Login",
            message: `Login complete for ${profile}`
          })
        ),
        Effect.catchIf(() => true, (e) =>
          notificationRepo.addSystem({
            type: "error",
            title: "SSO Login Failed",
            message: Predicate.isError(e) ? e.message : String(e)
          })),
        Effect.withSpan("loginToAws", { attributes: { profile } })
      ),
      ownerScope
    )
  })
)

/**
 * Copies PR link and runs assume -c for the profile
 * @category atoms
 */
export const openPrAtom = runtimeAtom.fn((pr: Domain.PullRequest) =>
  Effect.gen(function*() {
    const notificationRepo = yield* CacheService.NotificationRepo
    const ownerScope = yield* TuiApplicationScope
    const host = yield* ChildEnv.HostEnvironment
    const profile = pr.account.profile

    yield* copyToClipboard(pr.link)

    yield* notificationRepo.addSystem({
      type: "info",
      title: "Assume",
      message: `Opening ${profile} → PR console...`
    })

    yield* Effect.forkIn(
      exitCode(ChildProcess.make("assume", assumeConsoleArgs(pr.link, profile), {
        stdout: "inherit",
        stderr: "inherit",
        // `assume` is resolved from PATH and needs the caller's AWS/SSO env, so the
        // flag must be merged into the inherited environment. The profile argument
        // stays authoritative only if ambient AWS credentials are dropped.
        env: ChildEnv.profileScopedEnv(host.variables, { GRANTED_ALIAS_CONFIGURED: "true" }),
        extendEnv: true
      })).pipe(
        Effect.tap(() =>
          notificationRepo.addSystem({
            type: "success",
            title: "Assume",
            message: `Assumed ${profile}`
          })
        ),
        Effect.catchIf(() => true, (e) =>
          notificationRepo.addSystem({
            type: "error",
            title: "Assume Failed",
            message: Predicate.isError(e) ? e.message : String(e)
          })),
        Effect.withSpan("openPr", { attributes: { profile, prId: pr.id } })
      ),
      ownerScope
    )
  })
)

/**
 * Opens a URL in the default browser
 * @category atoms
 */
export const openBrowserAtom = runtimeAtom.fn((link: string) =>
  Effect.gen(function*() {
    const ownerScope = yield* TuiApplicationScope
    const openWith = (command: string, args: ReadonlyArray<string>) =>
      successfulBrowserExit(
        command,
        exitCode(ChildProcess.make(command, args, {
          stdout: "pipe",
          stderr: "pipe"
        }))
      )

    yield* openWith("open", [link]).pipe(
      Effect.catchIf(() => true, () => openWith("xdg-open", [link])),
      Effect.catchIf(() => true, () => openWith("rundll32.exe", ["url.dll,FileProtocolHandler", link])),
      Effect.catchIf(() => true, (error) =>
        Effect.gen(function*() {
          const notificationRepo = yield* CacheService.NotificationRepo
          yield* notificationRepo.addSystem({
            type: "error",
            title: "Open Browser",
            message: Predicate.isError(error) ? error.message : String(error)
          })
        })),
      Effect.forkIn(ownerScope),
      Effect.asVoid,
      Effect.withSpan("openBrowser")
    )
  })
)

/** Opens the durable Control Center review for one selected PR, or labels the local fallback. */
export const openManagedReviewAtom = runtimeAtom.fn((pullRequestUrl: string) =>
  Effect.gen(function*() {
    const ownerScope = yield* TuiApplicationScope
    const client = yield* HttpClient.HttpClient
    const notificationRepo = yield* CacheService.NotificationRepo
    const origin = resolveControlCenterOrigin(yield* controlCenterOriginConfiguration)
    const handoff = planControlCenterReviewHandoff(pullRequestUrl, origin)
    if (handoff._tag === "unavailable") {
      yield* notificationRepo.addSystem({
        type: "warning",
        title: "Managed Review Unavailable",
        message: "Control Center origin is invalid. Local TUI review is Relay-only and not durable."
      })
      return
    }
    if (handoff._tag === "manual") {
      const copied = yield* copyToClipboard(handoff.clipboardText)
      yield* notificationRepo.addSystem({
        type: "warning",
        title: "Secure Managed Review Handoff Required",
        message: manualReviewHandoffMessage(handoff.clipboardText, copied)
      })
      return
    }
    const available = yield* client.execute(HttpClientRequest.get(handoff.identityUrl)).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, controlCenterIdentityRequestInit),
      Effect.flatMap((response) =>
        managedReviewIdentityContentLengthAllowed(
            response.headers["content-length"],
            response.headers["content-encoding"]
          )
          ? response.stream.pipe(
            Stream.flatMap((bytes) => Stream.fromIterable(bytes)),
            Stream.take(MAXIMUM_CONTROL_CENTER_IDENTITY_BYTES + 1),
            Stream.map((byte) => Uint8Array.of(byte)),
            Stream.decodeText(),
            Stream.mkString,
            Effect.map((body) => isControlCenterManagedReviewIdentity(response.status, body))
          )
          : Effect.succeed(false)
      ),
      Effect.timeout("2 seconds"),
      Effect.catchIf(() => true, () => Effect.succeed(false))
    )
    if (!available) {
      yield* notificationRepo.addSystem({
        type: "warning",
        title: "Managed Review Unavailable",
        message: `Control Center identity was not found at ${origin}. Local TUI review is Relay-only and not durable.`
      })
      return
    }
    const copied = yield* copyToClipboard(handoff.clipboardText)
    if (!copied) {
      yield* notificationRepo.addSystem({
        type: "warning",
        title: "Managed Review Link",
        message: manualReviewHandoffMessage(handoff.clipboardText, false)
      })
    }
    const url = handoff.reviewUrl
    const openWith = (command: string, args: ReadonlyArray<string>) =>
      successfulBrowserExit(
        command,
        exitCode(ChildProcess.make(command, args, { stdout: "pipe", stderr: "pipe" }))
      )
    yield* openWith("open", [url]).pipe(
      Effect.catchIf(() => true, () => openWith("xdg-open", [url])),
      Effect.catchIf(() => true, () => openWith("rundll32.exe", ["url.dll,FileProtocolHandler", url])),
      Effect.catchIf(() => true, () =>
        notificationRepo.addSystem({
          type: "error",
          title: "Managed Review",
          message: "Control Center is available, but the browser could not be opened."
        })),
      Effect.forkIn(ownerScope),
      Effect.asVoid,
      Effect.withSpan("openManagedReview")
    )
  })
)

/**
 * Create a new pull request
 * @category atoms
 */
export const createPrAtom = runtimeAtom.fn((input: CreatePRInput) =>
  Effect.gen(function*() {
    const service = yield* PRService.PRService
    const awsClient = yield* AwsClient.AwsClient
    const notificationRepo = yield* CacheService.NotificationRepo

    yield* notificationRepo.addSystem({
      type: "info",
      title: "Creating PR",
      message: `${input.title} in ${input.repositoryName}...`
    })

    const prId = yield* awsClient.createPullRequest({
      account: { profile: input.account.profile, region: input.account.region },
      repositoryName: input.repositoryName,
      title: input.title,
      ...(input.description && { description: input.description }),
      sourceReference: input.sourceBranch,
      destinationReference: input.destinationBranch
    }).pipe(
      Effect.tapError((e) => notifyError("Create PR Failed", e)),
      Effect.catchTag("AwsApiError", () => Effect.succeed("")),
      Effect.catchTag("AwsCredentialError", () => Effect.succeed("")),
      Effect.catchTag("AwsThrottleError", () => Effect.succeed("")),
      Effect.withSpan("createPr", { attributes: { repo: input.repositoryName } })
    )

    if (prId.length > 0) {
      yield* notificationRepo.addSystem({
        type: "success",
        title: "PR Created",
        message: `${input.title} (#${prId})`
      })
      yield* service.refresh
    }

    return prId
  })
)

/**
 * Fetch comments for a specific PR and return them
 * @category atoms
 */
export const fetchPrCommentsAtom = runtimeAtom.fn((pr: Domain.PullRequest) => fetchPrComments(pr))

/**
 * List branches for a repository
 * @category atoms
 */
export const listBranchesAtom = runtimeAtom.fn((input: ListBranchesInput) =>
  Effect.gen(function*() {
    const awsClient = yield* AwsClient.AwsClient

    const branches: Array<string> = yield* awsClient.listBranches({
      account: { profile: input.account.profile, region: input.account.region },
      repositoryName: input.repositoryName
    }).pipe(
      Effect.tapError((e) => notifyError("List Branches Failed", e)),
      Effect.catchTag("AwsApiError", () => Effect.succeed<Array<string>>([])),
      Effect.catchTag("AwsCredentialError", () => Effect.succeed<Array<string>>([])),
      Effect.catchTag("AwsThrottleError", () => Effect.succeed<Array<string>>([])),
      Effect.withSpan("listBranches", { attributes: { repo: input.repositoryName } })
    )

    return branches.sort()
  })
)
