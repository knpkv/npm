/**
 * Schema-decoded CodeCommit pull-request and changed-file reads.
 *
 * @category Read client
 * @module
 */
import { Context, Effect, Layer, Option, Predicate, Schema, Stream } from "effect"

import type { AwsClientError } from "../Errors.js"
import {
  CodeCommitBlobTooLargeError,
  CodeCommitMalformedResponseError,
  type CodeCommitReadError,
  CodeCommitReadNotFoundError
} from "./errors.js"
import {
  CODECOMMIT_BLOB_MAXIMUM_BYTES,
  CodeCommitAccountIdentity,
  CodeCommitBlobContent,
  CodeCommitBlobId,
  CodeCommitBlobMetadata,
  CodeCommitChangedFile,
  CodeCommitChangedFilesPage,
  CodeCommitPageToken,
  CodeCommitPullRequestIdsPage,
  CodeCommitPullRequestPage,
  CodeCommitPullRequestRevision,
  type CodeCommitReadAccount,
  CodeCommitRepositoryIdentity,
  CodeCommitRepositoryPage
} from "./models.js"
import {
  CodeCommitReadProvider,
  CodeCommitReadProviderLive,
  type GetBlobProviderRequest,
  type GetDifferencesProviderPageRequest,
  type GetPullRequestProviderRequest,
  type GetRepositoryProviderRequest,
  type ListPullRequestsProviderPageRequest,
  type ListRepositoriesProviderPageRequest
} from "./ReadProvider.js"

const PROVIDER_PAGE_LIMIT = 100

/**
 * Concurrency for hydrating a listed page's pull requests via GetPullRequest.
 *
 * CodeCommit's GetPullRequest throttle ceiling is low; a wide fan-out bursts it
 * and surfaces ThrottlingException even for small repositories. Kept low so a
 * single sync stays under the limit, trading a little latency for reliability.
 */
export const PULL_REQUEST_HYDRATION_CONCURRENCY = 2

const RawCallerIdentity = Schema.Struct({
  Account: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  Arn: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty())
})

const RawRepositoryIdentity = Schema.Struct({
  repositoryMetadata: Schema.Struct({
    accountId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
    repositoryName: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty())
  })
})

const RawBlobResponse = Schema.Struct({ content: Schema.Uint8Array })

const RawPullRequestTarget = Schema.Struct({
  repositoryName: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  sourceReference: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  destinationReference: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  destinationCommit: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  sourceCommit: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  mergeBase: Schema.optional(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  mergeMetadata: Schema.optional(Schema.Struct({
    isMerged: Schema.optional(Schema.Boolean)
  }))
})

const RawPullRequestResponse = Schema.Struct({
  pullRequest: Schema.Struct({
    pullRequestId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
    revisionId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
    // Provider-supplied free text: CodeCommit does not guarantee a trimmed
    // title (observed trailing "\n"), so normalize on decode instead of rejecting.
    title: Schema.String.check(Schema.isNonEmpty()),
    description: Schema.optional(Schema.String),
    // CodeCommit omits authorArn for deleted/system identities (observed "Missing
    // key"); the sibling AwsClient read paths already model it as optional.
    authorArn: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()))),
    pullRequestStatus: Schema.Literals(["OPEN", "CLOSED"]),
    pullRequestTargets: Schema.Array(RawPullRequestTarget).check(Schema.isLengthBetween(1, 1)),
    creationDate: Schema.Date,
    lastActivityDate: Schema.Date
  })
})

const RawPullRequestPage = Schema.Struct({
  pullRequestIds: Schema.Array(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty())).check(
    Schema.isMaxLength(PROVIDER_PAGE_LIMIT)
  ),
  nextToken: Schema.optional(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()))
})

const RawBlob = Schema.Struct({
  blobId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  path: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  mode: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty())
})

const RawDifference = Schema.Union([
  Schema.Struct({ changeType: Schema.Literal("A"), afterBlob: RawBlob }),
  Schema.Struct({ changeType: Schema.Literal("D"), beforeBlob: RawBlob }),
  Schema.Struct({ changeType: Schema.Literal("M"), beforeBlob: RawBlob, afterBlob: RawBlob })
])

const RawDifferencesPage = Schema.Struct({
  differences: Schema.optional(Schema.Array(RawDifference).check(Schema.isMaxLength(PROVIDER_PAGE_LIMIT))),
  NextToken: Schema.optional(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()))
})

const RawRepositoryPage = Schema.Struct({
  repositories: Schema.optional(
    Schema.Array(Schema.Struct({
      repositoryName: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100)),
      repositoryId: Schema.optional(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()))
    })).check(Schema.isMaxLength(1_000))
  ),
  nextToken: Schema.optional(Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()))
})

const malformed = (operation: string) =>
  new CodeCommitMalformedResponseError({
    operation,
    diagnosticCode: "provider-response-schema-invalid"
  })

const isNotFoundCause = (cause: unknown): boolean =>
  Predicate.isTagged(cause, "BlobIdDoesNotExistException") ||
  Predicate.isTagged(cause, "PullRequestDoesNotExistException") ||
  Predicate.isTagged(cause, "RepositoryDoesNotExistException") ||
  Predicate.isTagged(cause, "CommitDoesNotExistException")

const mapProviderError = (operation: string) => (error: AwsClientError): CodeCommitReadError => {
  if (error._tag !== "AwsApiError") return error
  if (isNotFoundCause(error.cause)) return new CodeCommitReadNotFoundError({ operation })
  return operation === "get-blob" && Predicate.isTagged(error.cause, "FileTooLargeException")
    ? new CodeCommitBlobTooLargeError({
      operation,
      maximumBytes: CODECOMMIT_BLOB_MAXIMUM_BYTES,
      actualBytes: null,
      source: "provider"
    })
    : error
}

// Effect Schema error messages embed the rejected value. That is a useful
// field-level diagnostic for metadata operations, but get-blob carries raw
// repository file bytes, so its message must never reach the logs.
const operationLogsRejectedValue = (operation: string): boolean => operation !== "get-blob"

const decodeProvider = <S extends Schema.Codec<unknown, unknown, never, never>>(
  operation: string,
  schema: S,
  value: unknown
): Effect.Effect<S["Type"], CodeCommitMalformedResponseError> =>
  Schema.decodeUnknownEffect(Schema.toType(schema))(value).pipe(
    Effect.tapError((error) =>
      Effect.logError(
        operationLogsRejectedValue(operation)
          ? `CodeCommit provider response failed schema decode (${operation}): ${error.message}`
          : `CodeCommit provider response failed schema decode (${operation})`
      )
    ),
    Effect.mapError(() => malformed(operation))
  )

const decodePullRequest = Effect.fn("CodeCommitReadClient.decodePullRequest")(function*(value: unknown) {
  const raw = yield* decodeProvider("get-pull-request", RawPullRequestResponse, value)
  const pullRequest = raw.pullRequest
  const target = pullRequest.pullRequestTargets[0]
  if (target === undefined) return yield* malformed("get-pull-request")
  return yield* Schema.decodeUnknownEffect(CodeCommitPullRequestRevision)({
    pullRequestId: pullRequest.pullRequestId,
    revisionId: pullRequest.revisionId,
    repositoryName: target.repositoryName,
    title: pullRequest.title.trim(),
    description: pullRequest.description,
    authorArn: pullRequest.authorArn ?? null,
    status: target.mergeMetadata?.isMerged === true ? "MERGED" : pullRequest.pullRequestStatus,
    sourceReference: target.sourceReference,
    destinationReference: target.destinationReference,
    sourceCommit: target.sourceCommit,
    destinationCommit: target.destinationCommit,
    mergeBase: target.mergeBase ?? null,
    creationDate: pullRequest.creationDate,
    lastActivityDate: pullRequest.lastActivityDate
  }).pipe(Effect.mapError(() => malformed("get-pull-request")))
})

/** Decode caller identity evidence obtained inside an already-bound AWS runtime. @internal */
export const decodeAccountIdentityProviderResponse = Effect.fn(
  "CodeCommitReadClient.decodeAccountIdentityProviderResponse"
)(function*(value: unknown) {
  const identity = yield* decodeProvider("discover-account", RawCallerIdentity, value)
  return new CodeCommitAccountIdentity({ accountId: identity.Account, arn: identity.Arn })
})

/** Decode repository ownership evidence obtained inside an already-bound AWS runtime. @internal */
export const decodeRepositoryIdentityProviderResponse = Effect.fn(
  "CodeCommitReadClient.decodeRepositoryIdentityProviderResponse"
)(function*(value: unknown) {
  const response = yield* decodeProvider("get-repository-identity", RawRepositoryIdentity, value)
  return yield* Schema.decodeUnknownEffect(CodeCommitRepositoryIdentity)(response.repositoryMetadata).pipe(
    Effect.mapError(() => malformed("get-repository-identity"))
  )
})

const toBlobMetadata = (blob: typeof RawBlob.Type): CodeCommitBlobMetadata =>
  new CodeCommitBlobMetadata({ blobId: CodeCommitBlobId.make(blob.blobId), path: blob.path, mode: blob.mode })

const toChangedFile = (difference: typeof RawDifference.Type): CodeCommitChangedFile => {
  switch (difference.changeType) {
    case "A":
      return new CodeCommitChangedFile({ status: "added", before: null, after: toBlobMetadata(difference.afterBlob) })
    case "D":
      return new CodeCommitChangedFile({
        status: "deleted",
        before: toBlobMetadata(difference.beforeBlob),
        after: null
      })
    case "M":
      return new CodeCommitChangedFile({
        status: difference.beforeBlob.path === difference.afterBlob.path ? "modified" : "renamed",
        before: toBlobMetadata(difference.beforeBlob),
        after: toBlobMetadata(difference.afterBlob)
      })
  }
}

/** Public read operations implemented over an injectable raw provider. */
export interface CodeCommitReadClientService {
  readonly discoverAccount: (
    account: CodeCommitReadAccount
  ) => Effect.Effect<CodeCommitAccountIdentity, CodeCommitReadError>
  readonly listRepositoriesPage: (
    request: ListRepositoriesProviderPageRequest
  ) => Effect.Effect<CodeCommitRepositoryPage, CodeCommitReadError>
  readonly getBlob: (
    request: GetBlobProviderRequest
  ) => Effect.Effect<CodeCommitBlobContent, CodeCommitReadError>
  readonly listPullRequestsPage: (
    request: Omit<ListPullRequestsProviderPageRequest, "maximumResults">
  ) => Effect.Effect<CodeCommitPullRequestPage, CodeCommitReadError>
  /** Decoded provider page before each pull request is hydrated. @internal */
  readonly listPullRequestIdsPage: (
    request: Omit<ListPullRequestsProviderPageRequest, "maximumResults">
  ) => Effect.Effect<CodeCommitPullRequestIdsPage, CodeCommitReadError>
  readonly streamPullRequests: (
    request: Omit<ListPullRequestsProviderPageRequest, "maximumResults" | "nextToken">
  ) => Stream.Stream<CodeCommitPullRequestRevision, CodeCommitReadError>
  readonly getPullRequest: (
    request: GetPullRequestProviderRequest
  ) => Effect.Effect<CodeCommitPullRequestRevision, CodeCommitReadError>
  readonly getRepositoryIdentity: (
    request: GetRepositoryProviderRequest
  ) => Effect.Effect<CodeCommitRepositoryIdentity, CodeCommitReadError>
  readonly getChangedFilesPage: (
    request: Omit<GetDifferencesProviderPageRequest, "maximumResults">
  ) => Effect.Effect<CodeCommitChangedFilesPage, CodeCommitReadError>
  readonly streamChangedFiles: (
    request: Omit<GetDifferencesProviderPageRequest, "maximumResults" | "nextToken">
  ) => Stream.Stream<CodeCommitChangedFile, CodeCommitReadError>
}

/** Schema-decoded CodeCommit read service. */
export class CodeCommitReadClient extends Context.Service<CodeCommitReadClient, CodeCommitReadClientService>()(
  "@knpkv/codecommit-core/CodeCommitReadClient"
) {
  /** Read client implementation requiring a raw provider boundary. */
  static readonly layer = Layer.effect(
    CodeCommitReadClient,
    Effect.gen(function*() {
      const provider = yield* CodeCommitReadProvider

      const discoverAccount = Effect.fn("CodeCommitReadClient.discoverAccount")(
        function*(account: CodeCommitReadAccount) {
          const raw = yield* provider.getCallerIdentity(account).pipe(
            Effect.mapError(mapProviderError("discover-account"))
          )
          return yield* decodeAccountIdentityProviderResponse(raw)
        }
      )

      const getPullRequest = Effect.fn("CodeCommitReadClient.getPullRequest")(function*(
        request: GetPullRequestProviderRequest
      ) {
        const raw = yield* provider.getPullRequest(request).pipe(
          Effect.mapError(mapProviderError("get-pull-request"))
        )
        return yield* decodePullRequest(raw)
      })

      const getRepositoryIdentity = Effect.fn("CodeCommitReadClient.getRepositoryIdentity")(function*(
        request: GetRepositoryProviderRequest
      ) {
        const raw = yield* provider.getRepository(request).pipe(
          Effect.mapError(mapProviderError("get-repository-identity"))
        )
        return yield* decodeRepositoryIdentityProviderResponse(raw)
      })

      const listRepositoriesPage = Effect.fn("CodeCommitReadClient.listRepositoriesPage")(function*(
        request: ListRepositoriesProviderPageRequest
      ) {
        const raw = yield* provider.listRepositoriesPage(request).pipe(
          Effect.mapError(mapProviderError("list-repositories"))
        )
        const page = yield* decodeProvider("list-repositories", RawRepositoryPage, raw)
        return yield* Schema.decodeUnknownEffect(CodeCommitRepositoryPage)({
          repositoryNames: (page.repositories ?? []).map(({ repositoryName }) => repositoryName),
          nextToken: page.nextToken ?? null
        }).pipe(Effect.mapError(() => malformed("list-repositories")))
      })

      const getBlob = Effect.fn("CodeCommitReadClient.getBlob")(function*(request: GetBlobProviderRequest) {
        const raw = yield* provider.getBlob(request).pipe(
          Effect.mapError(mapProviderError("get-blob"))
        )
        const response = yield* decodeProvider("get-blob", RawBlobResponse, raw)
        if (response.content.byteLength > CODECOMMIT_BLOB_MAXIMUM_BYTES) {
          return yield* new CodeCommitBlobTooLargeError({
            operation: "get-blob",
            maximumBytes: CODECOMMIT_BLOB_MAXIMUM_BYTES,
            actualBytes: response.content.byteLength,
            source: "read-client"
          })
        }
        return new CodeCommitBlobContent({
          blobId: CodeCommitBlobId.make(request.blobId),
          bytes: response.content
        })
      })

      const listPullRequestIdsPage = Effect.fn("CodeCommitReadClient.listPullRequestIdsPage")(function*(
        request: Omit<ListPullRequestsProviderPageRequest, "maximumResults">
      ) {
        const raw = yield* provider.listPullRequestsPage({ ...request, maximumResults: PROVIDER_PAGE_LIMIT }).pipe(
          Effect.mapError(mapProviderError("list-pull-requests"))
        )
        const page = yield* decodeProvider("list-pull-requests", RawPullRequestPage, raw)
        return yield* Schema.decodeUnknownEffect(CodeCommitPullRequestIdsPage)({
          pullRequestIds: page.pullRequestIds,
          nextToken: page.nextToken ?? null
        }).pipe(Effect.mapError(() => malformed("list-pull-requests")))
      })

      const listPullRequestsPage = Effect.fn("CodeCommitReadClient.listPullRequestsPage")(function*(
        request: Omit<ListPullRequestsProviderPageRequest, "maximumResults">
      ) {
        const page = yield* listPullRequestIdsPage(request)
        const pullRequests = yield* Effect.forEach(
          page.pullRequestIds,
          (pullRequestId) => getPullRequest({ account: request.account, pullRequestId }),
          { concurrency: PULL_REQUEST_HYDRATION_CONCURRENCY }
        )
        return new CodeCommitPullRequestPage({
          pullRequests,
          nextToken: page.nextToken
        })
      })

      const getChangedFilesPage = Effect.fn("CodeCommitReadClient.getChangedFilesPage")(function*(
        request: Omit<GetDifferencesProviderPageRequest, "maximumResults">
      ) {
        const raw = yield* provider.getDifferencesPage({ ...request, maximumResults: PROVIDER_PAGE_LIMIT }).pipe(
          Effect.mapError(mapProviderError("get-differences"))
        )
        const page = yield* decodeProvider("get-differences", RawDifferencesPage, raw)
        return new CodeCommitChangedFilesPage({
          files: (page.differences ?? []).map(toChangedFile),
          nextToken: page.NextToken === undefined ? null : CodeCommitPageToken.make(page.NextToken),
          providerPageLimit: PROVIDER_PAGE_LIMIT
        })
      })

      const streamPullRequests: CodeCommitReadClientService["streamPullRequests"] = (request) =>
        Stream.paginate<string | null, CodeCommitPullRequestRevision, CodeCommitReadError>(
          null,
          (nextToken) =>
            listPullRequestsPage({ ...request, nextToken }).pipe(
              Effect.map((page) => [
                page.pullRequests,
                page.nextToken === null ? Option.none<string | null>() : Option.some<string | null>(page.nextToken)
              ])
            )
        )

      const streamChangedFiles: CodeCommitReadClientService["streamChangedFiles"] = (request) =>
        Stream.paginate<string | null, CodeCommitChangedFile, CodeCommitReadError>(
          null,
          (nextToken) =>
            getChangedFilesPage({ ...request, nextToken }).pipe(
              Effect.map((page) => [
                page.files,
                page.nextToken === null ? Option.none<string | null>() : Option.some<string | null>(page.nextToken)
              ])
            )
        )

      return {
        discoverAccount,
        getBlob,
        getChangedFilesPage,
        getPullRequest,
        getRepositoryIdentity,
        listPullRequestIdsPage,
        listPullRequestsPage,
        listRepositoriesPage,
        streamChangedFiles,
        streamPullRequests
      } satisfies CodeCommitReadClientService
    })
  )

  /** Production client layer backed by @distilled.cloud/aws. */
  static readonly live = CodeCommitReadClient.layer.pipe(Layer.provide(CodeCommitReadProviderLive))
}
