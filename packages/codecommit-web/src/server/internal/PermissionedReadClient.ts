/** Permission and audit boundary for Schema-decoded CodeCommit provider reads. @module */
import { AwsApiError, PermissionDeniedError } from "@knpkv/codecommit-core/Errors.js"
import { AuditLogRepo, type NewAuditLogEntry } from "@knpkv/codecommit-core/PermissionService/AuditLog.js"
import { PermissionService } from "@knpkv/codecommit-core/PermissionService/index.js"
import { getOperationMeta } from "@knpkv/codecommit-core/PermissionService/operations.js"
import { PermissionGate } from "@knpkv/codecommit-core/PermissionService/PermissionGate.js"
import * as ReadClient from "@knpkv/codecommit-core/ReadClient.js"
import { Clock, Context, Effect, Option, Random, Stream } from "effect"

interface GateParams {
  readonly account: ReadClient.CodeCommitReadAccount
  readonly context: string
  readonly operation: string
}

type AllowedState = "always_allowed" | "allowed"
const MAXIMUM_CHANGED_FILE_PAGE_REQUESTS = 1_001

interface ChangedFilePaginationState {
  readonly nextToken: string | null
  readonly pageRequests: number
  readonly seenTokens: ReadonlySet<string>
}

/** Holds the decoded provider client before permission enforcement. */
export class InnerCodeCommitReadClient extends Context.Service<
  InnerCodeCommitReadClient,
  ReadClient.CodeCommitReadClientService
>()("@knpkv/codecommit-web/InnerCodeCommitReadClient") {}

const deniedError = (params: GateParams, reason: "denied" | "timeout") =>
  new AwsApiError({
    operation: params.operation,
    profile: params.account.profile,
    region: params.account.region,
    cause: new PermissionDeniedError({ operation: params.operation, reason })
  })

/** Construct a read client that checks permission and audits before every provider call. */
export const makePermissionedReadClient = Effect.fn("PermissionedReadClient.make")(function*(
  inner: ReadClient.CodeCommitReadClientService
) {
  const permissions = yield* PermissionService
  const permissionGate = yield* PermissionGate
  const auditLog = yield* AuditLogRepo

  const audit = (
    params: GateParams,
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
                operation: params.operation,
                accountProfile: params.account.profile,
                region: params.account.region,
                permissionState,
                context: params.context,
                durationMs
              })
            )
          )
          : Effect.void
      ),
      Effect.ignore
    )

  const check = (params: GateParams): Effect.Effect<AllowedState, ReadClient.CodeCommitReadError> =>
    Effect.gen(function*() {
      const state = yield* permissions.check(params.operation)
      if (state === "always_allow") return "always_allowed"
      if (state === "deny") {
        yield* audit(params, "denied", null)
        return yield* deniedError(params, "denied")
      }
      const now = yield* Clock.currentTimeMillis
      const nonce = yield* Random.nextIntBetween(0, 999_999_999)
      const response = yield* permissionGate.request({
        id: `gate-${now}-${nonce}`,
        operation: params.operation,
        category: getOperationMeta(params.operation).category,
        context: params.context
      }).pipe(
        Effect.catchTag("PermissionDeniedError", (error) =>
          Effect.gen(function*() {
            if (error.reason === "denied") {
              yield* permissions.set(params.operation, "deny")
              yield* audit(params, "denied", null)
            } else {
              yield* audit(params, "timed_out", null)
            }
            return yield* deniedError(params, error.reason)
          }))
      )
      if (response === "always_allow") {
        yield* permissions.set(params.operation, "always_allow")
        return "always_allowed"
      }
      if (response === "deny") {
        yield* permissions.set(params.operation, "deny")
        yield* audit(params, "denied", null)
        return yield* deniedError(params, "denied")
      }
      return "allowed"
    })

  const gated = <P, A>(
    operation: string,
    context: (request: NoInfer<P>) => string,
    account: (request: NoInfer<P>) => ReadClient.CodeCommitReadAccount,
    method: (request: P) => Effect.Effect<A, ReadClient.CodeCommitReadError>
  ) =>
  (request: P): Effect.Effect<A, ReadClient.CodeCommitReadError> => {
    const params = { operation, context: context(request), account: account(request) }
    return Effect.gen(function*() {
      const permissionState = yield* check(params)
      const startedAt = yield* Clock.currentTimeMillis
      return yield* method(request).pipe(
        Effect.ensuring(
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((completedAt) => audit(params, permissionState, completedAt - startedAt))
          )
        )
      )
    })
  }

  const self = (account: ReadClient.CodeCommitReadAccount) => account
  const nested = (request: { readonly account: ReadClient.CodeCommitReadAccount }) => request.account

  const listPullRequestIdsPage = gated(
    "listPullRequests",
    (request: Parameters<ReadClient.CodeCommitReadClientService["listPullRequestIdsPage"]>[0]) =>
      `List pull requests in ${request.repositoryName}`,
    nested,
    inner.listPullRequestIdsPage
  )
  const getPullRequest = gated(
    "getPullRequest",
    (request: Parameters<ReadClient.CodeCommitReadClientService["getPullRequest"]>[0]) =>
      `Fetch PR #${request.pullRequestId}`,
    nested,
    inner.getPullRequest
  )
  const listPullRequestsPage: ReadClient.CodeCommitReadClientService["listPullRequestsPage"] = (request) =>
    Effect.gen(function*() {
      const page = yield* listPullRequestIdsPage(request)
      const pullRequests = yield* Effect.forEach(
        page.pullRequestIds,
        (pullRequestId) => getPullRequest({ account: request.account, pullRequestId })
      )
      return new ReadClient.CodeCommitPullRequestPage({ pullRequests, nextToken: page.nextToken })
    })
  const getChangedFilesPage = gated(
    "getDifferences",
    (request: Parameters<ReadClient.CodeCommitReadClientService["getChangedFilesPage"]>[0]) =>
      `Read differences in ${request.repositoryName}`,
    nested,
    inner.getChangedFilesPage
  )
  const initialPageToken = (): string | null => null

  const streamPullRequests: ReadClient.CodeCommitReadClientService["streamPullRequests"] = (request) =>
    Stream.paginate(initialPageToken(), (nextToken) =>
      listPullRequestsPage({ ...request, nextToken }).pipe(
        Effect.map((page) => [
          page.pullRequests,
          page.nextToken === null ? Option.none<string | null>() : Option.some<string | null>(page.nextToken)
        ])
      ))

  const streamChangedFiles: ReadClient.CodeCommitReadClientService["streamChangedFiles"] = (request) =>
    Stream.paginate<ChangedFilePaginationState, ReadClient.CodeCommitChangedFile, ReadClient.CodeCommitReadError>(
      { nextToken: null, pageRequests: 0, seenTokens: new Set() },
      Effect.fn("PermissionedReadClient.changedFilesPage")(function*(state) {
        if (state.pageRequests >= MAXIMUM_CHANGED_FILE_PAGE_REQUESTS) {
          return yield* new ReadClient.CodeCommitMalformedResponseError({
            operation: "GetDifferences",
            diagnosticCode: "page-request-limit"
          })
        }
        const page = yield* getChangedFilesPage({ ...request, nextToken: state.nextToken })
        if (page.nextToken === null) return [page.files, Option.none<ChangedFilePaginationState>()]
        if (state.seenTokens.has(page.nextToken)) {
          return yield* new ReadClient.CodeCommitMalformedResponseError({
            operation: "GetDifferences",
            diagnosticCode: "repeated-page-token"
          })
        }
        return [
          page.files,
          Option.some<ChangedFilePaginationState>({
            nextToken: page.nextToken,
            pageRequests: state.pageRequests + 1,
            seenTokens: new Set([...state.seenTokens, page.nextToken])
          })
        ]
      })
    )

  return {
    discoverAccount: gated(
      "getCallerIdentity",
      (account) => `Discover account for ${account.profile}`,
      self,
      inner.discoverAccount
    ),
    listRepositoriesPage: gated(
      "listRepositories",
      (request) => `List repositories for ${request.account.profile}`,
      nested,
      inner.listRepositoriesPage
    ),
    getBlob: gated(
      "getBlob",
      (request) => `Read immutable blob in ${request.repositoryName}`,
      nested,
      inner.getBlob
    ),
    listPullRequestIdsPage,
    listPullRequestsPage,
    streamPullRequests,
    getPullRequest,
    getRepositoryIdentity: gated(
      "getRepository",
      (request) => `Read repository identity for ${request.repositoryName}`,
      nested,
      inner.getRepositoryIdentity
    ),
    getChangedFilesPage,
    streamChangedFiles
  } satisfies ReadClient.CodeCommitReadClientService
})
