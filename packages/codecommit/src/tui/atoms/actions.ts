import { AwsClient, CacheService, ChildEnv, type Domain, type Errors, PRService } from "@knpkv/codecommit-core"
import { Effect, Predicate, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { assumeConsoleArgs } from "../browser-command.js"
import { runtimeAtom, TuiApplicationScope } from "./runtime.js"

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

const copyToClipboard = Effect.fn("copyToClipboard")(
  function*(text: string) {
    const copyWith = (command: string, args: ReadonlyArray<string> = []) =>
      exitCode(ChildProcess.make(command, args, {
        stdin: Stream.make(text).pipe(Stream.encodeText)
      }))

    yield* copyWith("pbcopy").pipe(
      Effect.catchIf(() => true, () => copyWith("xclip", ["-selection", "clipboard"]))
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

    if (!profile || profile.trim() === "") {
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
        env: ChildEnv.profileScopedEnv({ GRANTED_ALIAS_CONFIGURED: "true" }),
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
      exitCode(ChildProcess.make(command, args, {
        stdout: "pipe",
        stderr: "pipe"
      }))

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

    if (prId) {
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
const emptyCommentLocations = (): Array<Domain.PRCommentLocation> => []

export const fetchPrCommentsAtom = runtimeAtom.fn((pr: Domain.PullRequest) =>
  Effect.gen(function*() {
    const awsClient = yield* AwsClient.AwsClient
    const comments = yield* awsClient.getCommentsForPullRequest({
      account: { profile: pr.account.profile, region: pr.account.region },
      pullRequestId: pr.id,
      repositoryName: pr.repositoryName
    }).pipe(
      Effect.tapError((e) => notifyError("Fetch Comments Failed", e)),
      Effect.catchTag("AwsApiError", () => Effect.succeed(emptyCommentLocations())),
      Effect.catchTag("AwsCredentialError", () => Effect.succeed(emptyCommentLocations())),
      Effect.catchTag("AwsThrottleError", () => Effect.succeed(emptyCommentLocations())),
      Effect.withSpan("fetchPrComments", { attributes: { prId: pr.id } })
    )
    return {
      comments,
      identity: {
        profile: pr.account.profile,
        pullRequestId: pr.id,
        region: pr.account.region,
        repositoryName: pr.repositoryName
      }
    }
  })
)

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
