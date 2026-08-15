/** Permission-gated publication boundary for Relay findings. @module */
import { AwsApiError, PermissionDeniedError } from "@knpkv/codecommit-core/Errors.js"
import { AuditLogRepo, type NewAuditLogEntry } from "@knpkv/codecommit-core/PermissionService/AuditLog.js"
import { PermissionService } from "@knpkv/codecommit-core/PermissionService/index.js"
import { getOperationMeta } from "@knpkv/codecommit-core/PermissionService/operations.js"
import { PermissionGate } from "@knpkv/codecommit-core/PermissionService/PermissionGate.js"
import * as ReviewClient from "@knpkv/codecommit-core/ReviewClient.js"
import { Clock, Context, Effect, Random } from "effect"

type FindingCommentAction = Extract<ReviewClient.CodeCommitReviewAction, { readonly _tag: "comment" }>

/** Narrow web authority: Relay may publish one exact-head finding as a PR comment. */
export interface RelayFindingPublisherService {
  readonly post: (
    action: FindingCommentAction
  ) => Effect.Effect<ReviewClient.CodeCommitReviewReceipt, ReviewClient.CodeCommitReviewError>
}

/** The web server never exposes approval or merge authority through this service. */
export class RelayFindingPublisher extends Context.Service<
  RelayFindingPublisher,
  RelayFindingPublisherService
>()("@knpkv/codecommit-web/RelayFindingPublisher") {}

const operation = "postPullRequestComment"

const deniedError = (action: FindingCommentAction, reason: "denied" | "timeout") =>
  new AwsApiError({
    operation,
    profile: action.target.account.profile,
    region: action.target.account.region,
    cause: new PermissionDeniedError({ operation, reason })
  })

/** Wrap the full core client behind the single comment operation the web UI owns. */
export const makeRelayFindingPublisher = Effect.fn("RelayFindingPublisher.make")(function*() {
  const client = yield* ReviewClient.CodeCommitReviewClient
  const permissions = yield* PermissionService
  const permissionGate = yield* PermissionGate
  const auditLog = yield* AuditLogRepo

  const audit = (
    action: FindingCommentAction,
    permissionState: NewAuditLogEntry["permissionState"],
    durationMs: number | null
  ): Effect.Effect<void> =>
    permissions.isAuditEnabled().pipe(
      Effect.flatMap((enabled) =>
        enabled
          ? Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              auditLog.log({
                timestamp: new Date(now).toISOString(),
                operation,
                accountProfile: action.target.account.profile,
                region: action.target.account.region,
                permissionState,
                context: `Post Relay finding to PR #${action.target.pullRequestId}`,
                durationMs
              })
            )
          )
          : Effect.void
      ),
      Effect.ignore
    )

  const check = (
    action: FindingCommentAction
  ): Effect.Effect<"always_allowed" | "allowed", ReviewClient.CodeCommitReviewError> =>
    Effect.gen(function*() {
      const state = yield* permissions.check(operation)
      if (state === "always_allow") return "always_allowed"
      if (state === "deny") {
        yield* audit(action, "denied", null)
        return yield* deniedError(action, "denied")
      }
      const now = yield* Clock.currentTimeMillis
      const nonce = yield* Random.nextIntBetween(0, 999_999_999)
      const response = yield* permissionGate.request({
        id: `gate-${now}-${nonce}`,
        operation,
        category: getOperationMeta(operation).category,
        context: `Post Relay finding to PR #${action.target.pullRequestId}`
      }).pipe(
        Effect.catchTag("PermissionDeniedError", (error) =>
          Effect.gen(function*() {
            const auditState = error.reason === "denied" ? "denied" : "timed_out"
            if (error.reason === "denied") yield* permissions.set(operation, "deny")
            yield* audit(action, auditState, null)
            return yield* deniedError(action, error.reason)
          }))
      )
      if (response === "always_allow") {
        yield* permissions.set(operation, "always_allow")
        return "always_allowed"
      }
      if (response === "deny") {
        yield* permissions.set(operation, "deny")
        yield* audit(action, "denied", null)
        return yield* deniedError(action, "denied")
      }
      return "allowed"
    })

  return {
    post: (action) =>
      Effect.gen(function*() {
        const permissionState = yield* check(action)
        const startedAt = yield* Clock.currentTimeMillis
        return yield* client.execute(action).pipe(
          Effect.ensuring(
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((completedAt) => audit(action, permissionState, completedAt - startedAt))
            )
          )
        )
      })
  } satisfies RelayFindingPublisherService
})
