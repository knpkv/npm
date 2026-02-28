import { Command } from "@effect/platform"
import { AwsClient, CacheService, type Domain, type Errors, PRService } from "@knpkv/codecommit-core"
import { Effect, Stream } from "effect"
import { runtimeAtom } from "./runtime.js"

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

const isDarwin = process.platform === "darwin"

const notifyError = (title: string, error: Errors.AwsClientError) =>
  Effect.gen(function*() {
    const notificationRepo = yield* CacheService.NotificationRepo
    yield* notificationRepo.addSystem({
      type: "error",
      title,
      message: error.message
    })
  })

const copyToClipboard = (text: string) =>
  Effect.gen(function*() {
    const cmd = isDarwin
      ? Command.make("pbcopy")
      : Command.make("xclip", "-selection", "clipboard")

    yield* Command.exitCode(
      Command.stdin(cmd, Stream.make(text).pipe(Stream.encodeText))
    )
  }).pipe(
    Effect.catchAll((error) =>
      Effect.gen(function*() {
        const notificationRepo = yield* CacheService.NotificationRepo
        yield* notificationRepo.addSystem({
          type: "error",
          title: "Clipboard",
          message: error instanceof Error ? error.message : String(error)
        })
      })
    ),
    Effect.withSpan("copyToClipboard")
  )

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

/**
 * Log in to AWS SSO
 * @category atoms
 */
export const loginToAwsAtom = runtimeAtom.fn(
  Effect.fnUntraced(function*(profile: Domain.AwsProfileName) {
    const notificationRepo = yield* CacheService.NotificationRepo

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

    const cmd = Command.make("aws", "sso", "login", "--profile", profile).pipe(
      Command.stdout("inherit"),
      Command.stderr("inherit")
    )

    yield* Effect.forkDaemon(
      Command.exitCode(cmd).pipe(
        Effect.tap(() =>
          notificationRepo.addSystem({
            type: "success",
            title: "SSO Login",
            message: `Login complete for ${profile}`
          })
        ),
        Effect.catchAll((e) =>
          notificationRepo.addSystem({
            type: "error",
            title: "SSO Login Failed",
            message: e instanceof Error ? e.message : String(e)
          })
        ),
        Effect.withSpan("loginToAws", { attributes: { profile } })
      )
    )
  })
)

/**
 * Copies PR link and runs assume -c for the profile
 * @category atoms
 */
export const openPrAtom = runtimeAtom.fn(
  Effect.fnUntraced(function*(pr: Domain.PullRequest) {
    const notificationRepo = yield* CacheService.NotificationRepo
    const profile = pr.account.profile

    yield* copyToClipboard(pr.link)

    yield* notificationRepo.addSystem({
      type: "info",
      title: "Assume",
      message: `Opening ${profile} → PR console...`
    })

    const cmd = Command.make("assume", "-cd", pr.link, profile).pipe(
      Command.stdout("inherit"),
      Command.stderr("inherit"),
      Command.env({ GRANTED_ALIAS_CONFIGURED: "true" })
    )

    yield* Effect.forkDaemon(
      Command.exitCode(cmd).pipe(
        Effect.tap(() =>
          notificationRepo.addSystem({
            type: "success",
            title: "Assume",
            message: `Assumed ${profile}`
          })
        ),
        Effect.catchAll((e) =>
          notificationRepo.addSystem({
            type: "error",
            title: "Assume Failed",
            message: e instanceof Error ? e.message : String(e)
          })
        ),
        Effect.withSpan("openPr", { attributes: { profile, prId: pr.id } })
      )
    )
  })
)

/**
 * Opens a URL in the default browser
 * @category atoms
 */
export const openBrowserAtom = runtimeAtom.fn(
  Effect.fnUntraced(function*(link: string) {
    const openCmd = isDarwin ? "open" : "xdg-open"
    const cmd = Command.make(openCmd, link).pipe(
      Command.stdout("pipe"),
      Command.stderr("pipe")
    )

    yield* Command.exitCode(cmd).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function*() {
          const notificationRepo = yield* CacheService.NotificationRepo
          yield* notificationRepo.addSystem({
            type: "error",
            title: "Open Browser",
            message: error instanceof Error ? error.message : String(error)
          })
        })
      ),
      Effect.fork,
      Effect.asVoid,
      Effect.withSpan("openBrowser")
    )
  })
)

/**
 * Create a new pull request
 * @category atoms
 */
export const createPrAtom = runtimeAtom.fn(
  Effect.fnUntraced(function*(input: CreatePRInput) {
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
export const fetchPrCommentsAtom = runtimeAtom.fn(
  Effect.fnUntraced(function*(pr: Domain.PullRequest) {
    const awsClient = yield* AwsClient.AwsClient

    return yield* awsClient.getCommentsForPullRequest({
      account: { profile: pr.account.profile, region: pr.account.region },
      pullRequestId: pr.id,
      repositoryName: pr.repositoryName
    }).pipe(
      Effect.tapError((e) => notifyError("Fetch Comments Failed", e)),
      Effect.catchTag("AwsApiError", () => Effect.succeed([] as Array<Domain.PRCommentLocation>)),
      Effect.catchTag("AwsCredentialError", () => Effect.succeed([] as Array<Domain.PRCommentLocation>)),
      Effect.catchTag("AwsThrottleError", () => Effect.succeed([] as Array<Domain.PRCommentLocation>)),
      Effect.withSpan("fetchPrComments", { attributes: { prId: pr.id } })
    )
  })
)

/**
 * List branches for a repository
 * @category atoms
 */
export const listBranchesAtom = runtimeAtom.fn(
  Effect.fnUntraced(function*(input: ListBranchesInput) {
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
