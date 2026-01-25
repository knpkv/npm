import { Command } from "@effect/platform"
import type { Atom, Result } from "@effect-atom/atom-react"
import { Cause, Effect, Stream } from "effect"
import { PRService } from "@knpkv/codecommit-core"
import type { Account, PullRequest } from "@knpkv/codecommit-core"
import { runtimeAtom } from "./runtime.js"
import { AwsClient } from "@knpkv/codecommit-core"

export interface CreatePRInput {
  readonly repositoryName: string
  readonly title: string
  readonly description?: string
  readonly sourceBranch: string
  readonly destinationBranch: string
  readonly account: Account
}

const handleError = (error: unknown) =>
  Effect.gen(function* () {
    const msg = error instanceof Error ? error.message : String(error)
    const service = yield* PRService
    yield* service.addNotification({
      type: "error",
      title: "System Error",
      message: msg
    })
  })

const copyToClipboard = (text: string) =>
  Effect.gen(function* () {
    const cmd = process.platform === "darwin"
      ? Command.make("pbcopy")
      : Command.make("xclip", "-selection", "clipboard")

    yield* Command.exitCode(
      Command.stdin(cmd, Stream.make(text).pipe(Stream.encodeText))
    )
  }).pipe(Effect.catchAll(handleError))

/**
 * Log in to AWS SSO
 * @category atoms
 */
export const loginToAwsAtom: Atom.Writable<Result.Result<void>, string> = runtimeAtom.fn(
  (profile: string) =>
    Effect.gen(function* () {
      const service = yield* PRService

      if (!profile || profile.trim() === "") {
        yield* service.addNotification({
          type: "error",
          title: "SSO Login",
          message: "No profile specified"
        })
        return
      }

      yield* service.addNotification({
        type: "info",
        title: "SSO Login",
        message: `Opening browser for ${profile}...`
      })

      const cmd = Command.make("aws", "sso", "login", "--profile", profile).pipe(
        Command.stdout("inherit"),
        Command.stderr("inherit")
      )

      // Run in background
      yield* Effect.forkDaemon(
        Command.exitCode(cmd).pipe(
          Effect.tap(() =>
            service.addNotification({
              type: "success",
              title: "SSO Login",
              message: `Login complete for ${profile}`
            })
          ),
          Effect.catchAll((e) =>
            service.addNotification({
              type: "error",
              title: "SSO Login Failed",
              message: e instanceof Error ? e.message : String(e)
            })
          )
        )
      )
    }) as any
)

/**
 * Copies PR link and runs assume -c for the profile
 * @category atoms
 */
export const openPrAtom: Atom.Writable<Result.Result<void>, PullRequest> = runtimeAtom.fn(
  (pr: PullRequest) =>
    Effect.gen(function* () {
      const service = yield* PRService
      const profile = pr.account.id

      // Copy URL to clipboard
      yield* copyToClipboard(pr.link)

      yield* service.addNotification({
        type: "info",
        title: "Assume",
        message: `URL copied. Running assume -c ${profile}...`
      })

      const cmd = Command.make("assume", "-c", profile).pipe(
        Command.stdout("inherit"),
        Command.stderr("inherit"),
        Command.env({ GRANTED_ALIAS_CONFIGURED: "true" })
      )

      // Run in background
      yield* Effect.forkDaemon(
        Command.exitCode(cmd).pipe(
          Effect.tap(() =>
            service.addNotification({
              type: "success",
              title: "Assume",
              message: `Assumed ${profile}`
            })
          ),
          Effect.catchAll((e) =>
            service.addNotification({
              type: "error",
              title: "Assume Failed",
              message: e instanceof Error ? e.message : String(e)
            })
          )
        )
      )
    }) as any
)

/**
 * Opens a URL in the default browser
 * @category atoms
 */
export const openBrowserAtom: Atom.Writable<Result.Result<void>, string> = runtimeAtom.fn(
  (link: string) =>
    Effect.gen(function* () {
      const openCmd = process.platform === "darwin" ? "open" : "xdg-open"
      const cmd = Command.make(openCmd, link).pipe(
        Command.stdout("pipe"),
        Command.stderr("pipe")
      )

      yield* Command.exitCode(cmd).pipe(
        Effect.catchAll(handleError),
        Effect.fork,
        Effect.asVoid
      )
    }) as any
)

/**
 * Create a new pull request
 * @category atoms
 */
export const createPrAtom: Atom.Writable<Result.Result<string>, CreatePRInput> = runtimeAtom.fn(
  (input: CreatePRInput) =>
    Effect.gen(function* () {
      const service = yield* PRService
      const awsClient = yield* AwsClient

      yield* service.addNotification({
        type: "info",
        title: "Creating PR",
        message: `${input.title} in ${input.repositoryName}...`
      })

      const prId = yield* awsClient.createPullRequest({
        account: { profile: input.account.id, region: input.account.region },
        repositoryName: input.repositoryName,
        title: input.title,
        ...(input.description && { description: input.description }),
        sourceReference: input.sourceBranch,
        destinationReference: input.destinationBranch
      }).pipe(
        Effect.tapError((e) =>
          service.addNotification({
            type: "error",
            title: "AWS Error",
            message: e instanceof Error ? e.message : JSON.stringify(e)
          })
        )
      )

      yield* service.addNotification({
        type: "success",
        title: "PR Created",
        message: `${input.title} (#${prId})`
      })

      // Trigger refresh to show new PR
      yield* service.refresh

      return prId
    }).pipe(
      Effect.catchAllCause((cause) =>
        Effect.gen(function* () {
          const service = yield* PRService
          const msg = Cause.pretty(cause)
          yield* service.addNotification({
            type: "error",
            title: "Create PR Failed",
            message: msg.slice(0, 300)
          })
          return ""
        })
      )
    ) as any
)

export interface ListBranchesInput {
  readonly repositoryName: string
  readonly account: Account
}

/**
 * List branches for a repository
 * @category atoms
 */
export const listBranchesAtom: Atom.Writable<Result.Result<string[]>, ListBranchesInput> = runtimeAtom.fn(
  (input: ListBranchesInput) =>
    Effect.gen(function* () {
      const awsClient = yield* AwsClient

      const branches = yield* awsClient.listBranches({
        account: { profile: input.account.id, region: input.account.region },
        repositoryName: input.repositoryName
      })

      return branches.sort()
    }).pipe(
      Effect.catchAll((e) =>
        Effect.gen(function* () {
          const service = yield* PRService
          yield* service.addNotification({
            type: "error",
            title: "List Branches Failed",
            message: e instanceof Error ? e.message : String(e)
          })
          return [] as string[]
        })
      )
    ) as any
)
