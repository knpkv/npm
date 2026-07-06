/**
 * @title AwsClientGated — transparent permission proxy
 *
 * Wraps every AwsClient method with permission check + audit logging.
 * Returns the same `AwsClient.Service` type — callers don't know it exists.
 *
 * Two patterns:
 *   1. InnerAwsClient tag — holds the real implementation, avoids circular dep
 *   2. Service capture at Layer construction — all services yielded once,
 *      closed over in gate/wrapEffect/wrapStream, no R leakage
 *
 * PermissionDeniedError → AwsApiError at the boundary for type transparency.
 * The actual PermissionDeniedError is preserved as the AwsApiError's `cause`.
 *
 * All operations — reads, writes, and approval rule CRUD — are gated with
 * the appropriate category for UI badge color and prompt behavior.
 *
 * @module
 */
import { Clock, Context, Effect, Layer, Random, Schema, Stream } from "effect"
import { AwsProfileName, AwsRegion } from "../Domain.js"
import { AwsApiError, PermissionDeniedError } from "../Errors.js"
import { AuditLogRepo, type NewAuditLogEntry } from "../PermissionService/AuditLog.js"
import { PermissionService } from "../PermissionService/index.js"
import { getOperationMeta } from "../PermissionService/operations.js"
import { PermissionGate } from "../PermissionService/PermissionGate.js"
import { AwsClient, type AwsClientError } from "./index.js"

// Layer composition: AwsClientLive → InnerAwsClient (rename) → AwsClientGated → AwsClient
export class InnerAwsClient extends Context.Service<
  InnerAwsClient,
  AwsClient.Service
>()("@knpkv/codecommit-core/InnerAwsClient") {}

interface GateParams {
  readonly operation: string
  readonly context: string
  readonly accountProfile: string
  readonly region: string
}

type PromptAllowedState = "always_allowed" | "allowed"

const decodeAwsProfileName = Schema.decodeSync(AwsProfileName)
const decodeAwsRegion = Schema.decodeSync(AwsRegion)
const alwaysAllowedState: PromptAllowedState = "always_allowed"
const allowedState: PromptAllowedState = "allowed"

const toDeniedError = (p: GateParams, reason: "denied" | "timeout") =>
  new AwsApiError({
    operation: p.operation,
    profile: decodeAwsProfileName(p.accountProfile),
    region: decodeAwsRegion(p.region),
    cause: new PermissionDeniedError({ operation: p.operation, reason })
  })

export const AwsClientGatedLive: Layer.Layer<
  AwsClient,
  never,
  InnerAwsClient | PermissionService | PermissionGate | AuditLogRepo
> = Layer.effect(
  AwsClient,
  Effect.gen(function*() {
    const inner = yield* InnerAwsClient
    const permService = yield* PermissionService
    const gateService = yield* PermissionGate
    const auditLog = yield* AuditLogRepo
    // --- Core gate logic (captured services, no R leakage) ---

    // Reads auditEnabled dynamically from Ref on each call —
    // toggling audit in settings takes effect without restart
    const logAudit = (
      params: GateParams,
      permissionState: NewAuditLogEntry["permissionState"],
      durationMs: number | null
    ): Effect.Effect<void> =>
      permService.isAuditEnabled().pipe(
        Effect.flatMap((enabled) =>
          enabled
            ? Clock.currentTimeMillis.pipe(
              Effect.flatMap((nowMs) =>
                auditLog.log({
                  timestamp: new Date(nowMs).toISOString(),
                  operation: params.operation,
                  accountProfile: params.accountProfile,
                  region: params.region,
                  permissionState,
                  context: params.context,
                  durationMs
                })
              )
            )
            : Effect.void
        ),
        Effect.catchCause(() => Effect.void)
      )

    const promptUser = (params: GateParams): Effect.Effect<"always_allowed" | "allowed", AwsClientError> =>
      Effect.gen(function*() {
        const meta = getOperationMeta(params.operation)
        const now = yield* Clock.currentTimeMillis
        const nonce = yield* Random.nextIntBetween(0, 999_999_999)
        const response = yield* gateService.request({
          id: `gate-${now}-${nonce}`,
          operation: params.operation,
          category: meta.category,
          context: params.context
        }).pipe(Effect.mapError(() => toDeniedError(params, "timeout")))

        if (response === "always_allow") {
          yield* permService.set(params.operation, "always_allow")
          return alwaysAllowedState
        }
        if (response === "deny") {
          yield* permService.set(params.operation, "deny")
          yield* logAudit(params, "denied", null)
          return yield* Effect.fail(toDeniedError(params, "denied"))
        }
        return allowedState
      })

    const checkPermission = (
      params: GateParams
    ): Effect.Effect<"always_allowed" | "allowed", AwsClientError> =>
      Effect.gen(function*() {
        const state = yield* permService.check(params.operation)
        if (state === "always_allow") {
          return alwaysAllowedState
        }
        if (state === "deny") {
          yield* logAudit(params, "denied", null)
          return yield* Effect.fail(toDeniedError(params, "denied"))
        }
        return yield* promptUser(params)
      })

    // --- Declarative wrapping: gated(op, ctx, acct, method) → wrapped method ---

    // P inferred from `method` (last arg) — `acct` and `ctx` just extract strings
    const gated = <P, A>(
      op: string,
      ctx: (p: NoInfer<P>) => string,
      acct: (p: NoInfer<P>) => { profile: string; region: string },
      method: (p: P) => Effect.Effect<A, AwsClientError>
    ) =>
    (params: P): Effect.Effect<A, AwsClientError> => {
      const a = acct(params)
      const g: GateParams = { operation: op, context: ctx(params), accountProfile: a.profile, region: a.region }
      return Effect.gen(function*() {
        const ps = yield* checkPermission(g)
        const start = yield* Clock.currentTimeMillis
        const result = yield* method(params)
        const end = yield* Clock.currentTimeMillis
        yield* logAudit(g, ps, end - start)
        return result
      })
    }

    const gatedStream = <P, A>(
      op: string,
      ctx: (p: NoInfer<P>) => string,
      acct: (p: NoInfer<P>) => { profile: string; region: string },
      method: (p: P) => Stream.Stream<A, AwsClientError>
    ) =>
    (params: P): Stream.Stream<A, AwsClientError> => {
      const a = acct(params)
      const g: GateParams = { operation: op, context: ctx(params), accountProfile: a.profile, region: a.region }
      return Stream.unwrap(
        checkPermission(g).pipe(
          Effect.flatMap((ps) =>
            Clock.currentTimeMillis.pipe(Effect.map((start) => ({
              ps,
              start
            })))
          ),
          Effect.map(({ ps, start }) =>
            method(params).pipe(
              Stream.onEnd(
                Clock.currentTimeMillis.pipe(
                  Effect.flatMap((end) => logAudit(g, ps, end - start))
                )
              )
            )
          )
        )
      )
    }

    const self = (a: { profile: string; region: string }) => a
    const nested = (p: { account: { profile: string; region: string } }) => p.account

    return {
      getPullRequests: gatedStream(
        "getPullRequests",
        (a) => `List PRs for ${a.profile}`,
        self,
        (a) => inner.getPullRequests(a)
      ),
      getCallerIdentity: gated(
        "getCallerIdentity",
        (a) => `Get identity for ${a.profile}`,
        self,
        inner.getCallerIdentity
      ),
      createPullRequest: gated(
        "createPullRequest",
        (p) => `Create PR on ${p.repositoryName}`,
        nested,
        inner.createPullRequest
      ),
      listBranches: gated("listBranches", (p) => `List branches in ${p.repositoryName}`, nested, inner.listBranches),
      getCommentsForPullRequest: gated(
        "getCommentsForPullRequest",
        (p) => `Comments for PR #${p.pullRequestId}`,
        nested,
        inner.getCommentsForPullRequest
      ),
      updatePullRequestTitle: gated(
        "updatePullRequestTitle",
        (p) => `Edit title of PR #${p.pullRequestId}`,
        nested,
        inner.updatePullRequestTitle
      ),
      updatePullRequestDescription: gated(
        "updatePullRequestDescription",
        (p) => `Edit desc of PR #${p.pullRequestId}`,
        nested,
        inner.updatePullRequestDescription
      ),
      getPullRequest: gated("getPullRequest", (p) => `Fetch PR #${p.pullRequestId}`, nested, inner.getPullRequest),
      getDifferences: gated("getDifferences", (p) => `Diff for ${p.repositoryName}`, nested, inner.getDifferences),
      createApprovalRule: gated(
        "createApprovalRule",
        (p) => `Create rule "${p.approvalRuleName}" on PR #${p.pullRequestId}`,
        nested,
        inner.createApprovalRule
      ),
      updateApprovalRule: gated(
        "updateApprovalRule",
        (p) => `Update rule "${p.approvalRuleName}" on PR #${p.pullRequestId}`,
        nested,
        inner.updateApprovalRule
      ),
      deleteApprovalRule: gated(
        "deleteApprovalRule",
        (p) => `Delete rule "${p.approvalRuleName}" on PR #${p.pullRequestId}`,
        nested,
        inner.deleteApprovalRule
      )
    } satisfies AwsClient.Service
  })
)
