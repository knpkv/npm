/**
 * Schema-decoded CodeCommit pull-request and changed-file reads.
 *
 * @category Read client
 * @module
 */
import { Context, Effect, Layer, Option, Predicate, Schema, Stream } from "effect"

import type { AwsClientError } from "../Errors.js"
import { CodeCommitMalformedResponseError, type CodeCommitReadError, CodeCommitReadNotFoundError } from "./errors.js"
import {
  CodeCommitAccountIdentity,
  CodeCommitBlobId,
  CodeCommitBlobMetadata,
  CodeCommitChangedFile,
  CodeCommitChangedFilesPage,
  CodeCommitPageToken,
  CodeCommitPullRequestPage,
  CodeCommitPullRequestRevision,
  type CodeCommitReadAccount
} from "./models.js"
import {
  CodeCommitReadProvider,
  CodeCommitReadProviderLive,
  type GetDifferencesProviderPageRequest,
  type GetPullRequestProviderRequest,
  type ListPullRequestsProviderPageRequest
} from "./ReadProvider.js"

const PROVIDER_PAGE_LIMIT = 100

const RawCallerIdentity = Schema.Struct({
  Account: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  Arn: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty())
})

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
    title: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
    description: Schema.optional(Schema.String),
    authorArn: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
    pullRequestStatus: Schema.Literals(["OPEN", "CLOSED"]),
    pullRequestTargets: Schema.Array(RawPullRequestTarget).check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(PROVIDER_PAGE_LIMIT)
    ),
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

const malformed = (operation: string) =>
  new CodeCommitMalformedResponseError({
    operation,
    diagnosticCode: "provider-response-schema-invalid"
  })

const isNotFoundCause = (cause: unknown): boolean =>
  Predicate.isTagged(cause, "PullRequestDoesNotExistException") ||
  Predicate.isTagged(cause, "RepositoryDoesNotExistException") ||
  Predicate.isTagged(cause, "CommitDoesNotExistException")

const mapProviderError = (operation: string) => (error: AwsClientError): CodeCommitReadError =>
  error._tag === "AwsApiError" && isNotFoundCause(error.cause)
    ? new CodeCommitReadNotFoundError({ operation })
    : error

const decodeProvider = <S extends Schema.Codec<unknown, unknown, never, never>>(
  operation: string,
  schema: S,
  value: unknown
): Effect.Effect<S["Type"], CodeCommitMalformedResponseError> =>
  Schema.decodeUnknownEffect(Schema.toType(schema))(value).pipe(
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
    title: pullRequest.title,
    description: pullRequest.description,
    authorArn: pullRequest.authorArn,
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
  readonly listPullRequestsPage: (
    request: Omit<ListPullRequestsProviderPageRequest, "maximumResults">
  ) => Effect.Effect<CodeCommitPullRequestPage, CodeCommitReadError>
  readonly streamPullRequests: (
    request: Omit<ListPullRequestsProviderPageRequest, "maximumResults" | "nextToken">
  ) => Stream.Stream<CodeCommitPullRequestRevision, CodeCommitReadError>
  readonly getPullRequest: (
    request: GetPullRequestProviderRequest
  ) => Effect.Effect<CodeCommitPullRequestRevision, CodeCommitReadError>
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
          const identity = yield* decodeProvider("discover-account", RawCallerIdentity, raw)
          return new CodeCommitAccountIdentity({ accountId: identity.Account, arn: identity.Arn })
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

      const listPullRequestsPage = Effect.fn("CodeCommitReadClient.listPullRequestsPage")(function*(
        request: Omit<ListPullRequestsProviderPageRequest, "maximumResults">
      ) {
        const raw = yield* provider.listPullRequestsPage({ ...request, maximumResults: PROVIDER_PAGE_LIMIT }).pipe(
          Effect.mapError(mapProviderError("list-pull-requests"))
        )
        const page = yield* decodeProvider("list-pull-requests", RawPullRequestPage, raw)
        const pullRequests = yield* Effect.forEach(
          page.pullRequestIds,
          (pullRequestId) => getPullRequest({ account: request.account, pullRequestId }),
          { concurrency: 5 }
        )
        return new CodeCommitPullRequestPage({
          pullRequests,
          nextToken: page.nextToken === undefined ? null : CodeCommitPageToken.make(page.nextToken)
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
        getChangedFilesPage,
        getPullRequest,
        listPullRequestsPage,
        streamChangedFiles,
        streamPullRequests
      } satisfies CodeCommitReadClientService
    })
  )

  /** Production client layer backed by distilled-aws. */
  static readonly live = CodeCommitReadClient.layer.pipe(Layer.provide(CodeCommitReadProviderLive))
}
