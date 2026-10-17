/**
 * Host-local read authority. The provider is acquired once; each request binds its authenticated
 * caller to fresh saved grants and mandatory audit append. No provider client or writer is exported
 * from the package entry. PR/review/diff text is for this host's authenticated hub only.
 * @module
 */
import * as AwsClientConfig from "@knpkv/codecommit-core/AwsClientConfig.js"
import { attachHostCache, type HostCacheReads } from "@knpkv/codecommit-core/CacheService/HostReads.js"
import type { CachedPullRequest } from "@knpkv/codecommit-core/CacheService/repos/PullRequestRepo/internal.js"
import { TuiConfig } from "@knpkv/codecommit-core/ConfigService/internal.js"
import { AuditLogRepo } from "@knpkv/codecommit-core/PermissionService/AuditLog.js"
import { makeSavedPermissionCheck } from "@knpkv/codecommit-core/PermissionService/index.js"
import { CachedPRToPullRequest } from "@knpkv/codecommit-core/PRService/internal.js"
import * as ReadClient from "@knpkv/codecommit-core/ReadClient.js"
import type { ReviewRunReading } from "@knpkv/review"
import { type CanvasLastLook, CanvasReading } from "@knpkv/review/canvas"
import { Clock, Config, Context, Duration, Effect, Exit, Layer, Result, Schema, ScopedCache, Semaphore } from "effect"
import type { Scope } from "effect"
import type * as Crypto from "effect/Crypto"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import {
  CodeDetail,
  CodeDiff,
  CodeDiffContent,
  type CodeDiffContentQuery,
  CodeQueue,
  type CodeQueueQuery,
  type CodeReference,
  CodeReviewReading
} from "../host-contract.js"
import { CodeHostReadError, type CodeReferenceStore } from "./host-model.js"
import { codePullRequest } from "./host-presentation.js"
import { makePermissionedReadClient } from "./internal/PermissionedReadClient.js"
import type { CanvasSourceFile } from "./review/CanvasGraphBuilder.js"
import { makeCanvasGraphJobs } from "./review/CanvasGraphJobs.js"
import {
  loadPullRequestDiff,
  loadPullRequestDiffContent,
  makePullRequestChangedFilesSource
} from "./review/PullRequestReview.js"
import { reviewConversationsOf } from "./review/review-comments-projection.js"
import { reviewRunIdentity, reviewRunSubject } from "./review/review-run-projection.js"
import { makeReviewRunReader, type ReviewRunReader, ReviewRunStoreError } from "./review/ReviewRunReader.js"

export interface CodeHostReads {
  readonly queue: (query: CodeQueueQuery) => Effect.Effect<CodeQueue, CodeHostReadError>
  readonly detail: (ref: CodeReference) => Effect.Effect<CodeDetail, CodeHostReadError>
  readonly review: (
    ref: CodeReference,
    caller: { readonly login: string }
  ) => Effect.Effect<CodeReviewReading, CodeHostReadError>
  readonly diff: (ref: CodeReference, caller: { readonly login: string }) => Effect.Effect<CodeDiff, CodeHostReadError>
  readonly diffContent: (
    query: CodeDiffContentQuery,
    caller: { readonly login: string }
  ) => Effect.Effect<CodeDiffContent, CodeHostReadError>
  /** The canvas graph of the current revision; Building until every changed file is read. */
  readonly canvas: (
    ref: CodeReference,
    caller: { readonly login: string }
  ) => Effect.Effect<CanvasReading, CodeHostReadError>
}

const notRecorded = { _tag: "NotRecorded" } satisfies CanvasLastLook

/** Decode only recognized failure tags; provider causes remain private and are classified recursively. */
const ProviderReadFailure = Schema.Union([
  CodeHostReadError,
  Schema.Struct({
    _tag: Schema.Literals([
      "AwsCredentialError",
      "AwsApiError",
      "PullRequestReviewError",
      "PermissionRequired",
      "PermissionDeniedError"
    ]),
    cause: Schema.optionalKey(Schema.Unknown)
  })
])
const readFailure = (error: typeof ProviderReadFailure.Type): CodeHostReadError => {
  switch (error._tag) {
    case "CodeHostReadError":
      return error
    case "AwsCredentialError":
      return new CodeHostReadError({ reason: "sign_in_required" })
    case "PermissionRequired":
      return new CodeHostReadError({ reason: "permission_required" })
    case "PermissionDeniedError":
      return new CodeHostReadError({ reason: "denied" })
    case "AwsApiError":
    case "PullRequestReviewError": {
      const nested = Schema.decodeUnknownResult(ProviderReadFailure)(error.cause)
      return Result.isSuccess(nested) ? readFailure(nested.success) : new CodeHostReadError({ reason: "unavailable" })
    }
  }
}

const cacheFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((cause) => Effect.logWarning("Code host cache is unavailable", cause)),
    Effect.mapError(() => new CodeHostReadError({ reason: "cache_unavailable" }))
  )

/** Internal constructor for service fixtures; the public entry never accepts an unpermissioned client. */
export const makeCodeHostReadsFromClient = Effect.fn("CodeHostReads.bind")(function*(options: {
  readonly cache: HostCacheReads
  readonly reviews: ReviewRunReader
  readonly references: CodeReferenceStore
  readonly configPath: string
  readonly permissionPath: string
}, inner: ReadClient.CodeCommitReadClientService) {
  const fs = yield* FileSystem.FileSystem
  const check = yield* makeSavedPermissionCheck(options.permissionPath)
  const concurrency = yield* Semaphore.make(2)
  // Background canvas reads take their own lane, so a building map never queues ahead of an interactive read.
  const canvasLane = yield* Semaphore.make(1)
  // A small change answers Ready on its first read; a large one answers Building and the view reads again.
  const canvasJobs = yield* makeCanvasGraphJobs(8, "750 millis")
  const { cache, references } = options
  const exact = Effect.fn("CodeHostReads.exact")(function*(ref: CodeReference) {
    const coordinates = yield* references.resolve(ref)
    if (coordinates === null) return yield* new CodeHostReadError({ reason: "not_found" })
    const row = yield* cache.exact(coordinates).pipe(cacheFailure)
    if (row === null) return yield* new CodeHostReadError({ reason: "not_found" })
    return row
  })
  const itemOf = Effect.fn("CodeHostReads.item")(function*(row: CachedPullRequest) {
    const ref = yield* references.reference({
      accountId: row.awsAccountId,
      region: row.accountRegion,
      repository: row.repositoryName,
      id: row.id
    })
    return codePullRequest(row, ref)
  })
  const audit = AuditLogRepo.of({
    log: cache.log,
    clearAll: () => Effect.die("Host read authority cannot delete audits"),
    prune: () => Effect.die("Host read authority cannot prune audits"),
    exportAll: () => Effect.die("Host read authority cannot export audits"),
    findAll: () => Effect.die("Host read authority cannot inspect audits")
  })
  const clientFor = (caller: { readonly login: string }) =>
    makePermissionedReadClient(inner, {
      mode: "saved-grants",
      caller: caller.login,
      check
    }).pipe(Effect.provideService(AuditLogRepo, audit))
  const boundedReadIn =
    (lane: Semaphore.Semaphore) => <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, CodeHostReadError> =>
      lane.withPermits(1)(effect).pipe(
        Effect.timeout("15 seconds"),
        Effect.tapError((cause) => Effect.logWarning("Code host provider read refused", cause)),
        Effect.mapError((cause) => {
          const decoded = Schema.decodeUnknownResult(ProviderReadFailure)(cause)
          return Result.isSuccess(decoded)
            ? readFailure(decoded.success)
            : new CodeHostReadError({ reason: "unavailable" })
        })
      )
  const boundedRead = boundedReadIn(concurrency)

  return {
    queue: Effect.fn("CodeHostReads.queue")(function*(query: CodeQueueQuery) {
      const profiles = yield* Effect.gen(function*() {
        if (!(yield* fs.exists(options.configPath))) return null
        const config = yield* fs.readFileString(options.configPath).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(TuiConfig)))
        )
        return config.accounts.filter((account) => account.enabled).map((account) => account.profile)
      }).pipe(
        Effect.tapError((cause) => Effect.logWarning("Code queue visibility configuration is unavailable", cause)),
        Effect.mapError(() => new CodeHostReadError({ reason: "config_unavailable" }))
      )
      const rows = yield* cache.queue({ ...query, profiles }).pipe(cacheFailure)
      const items = yield* Effect.forEach(rows.slice(0, 50), itemOf)
      const observedAt = yield* Clock.currentTimeMillis
      return yield* Schema.decodeUnknownEffect(CodeQueue)({ _tag: "Ready", items, more: rows.length > 50, observedAt })
        .pipe(cacheFailure)
    }),
    detail: Effect.fn("CodeHostReads.detail")(function*(ref: CodeReference) {
      const row = yield* exact(ref)
      const item = yield* itemOf(row)
      return yield* Schema.decodeUnknownEffect(CodeDetail)({
        _tag: "Ready",
        item,
        description: (row.description ?? "").slice(0, 16_384),
        sourceBranch: row.sourceBranch.slice(0, 256),
        destinationBranch: row.destinationBranch.slice(0, 256)
      }).pipe(cacheFailure)
    }),
    review: Effect.fn("CodeHostReads.review")(function*(ref: CodeReference, caller: { readonly login: string }) {
      return yield* boundedRead(Effect.gen(function*() {
        const row = yield* exact(ref)
        const client = yield* clientFor(caller)
        const pullRequest = yield* Schema.decodeUnknownEffect(CachedPRToPullRequest)(row)
        const diff = yield* loadPullRequestDiff(client, pullRequest)
        const observedAt = yield* Clock.currentTimeMillis
        const identity = {
          namespace: "codecommit",
          subjectId: ref,
          revisionId: diff.revisionId,
          baseRevision: diff.baseCommit,
          headRevision: diff.headCommit
        }
        const run = yield* reviewRunSubject(pullRequest).pipe(
          Effect.mapError(() => new ReviewRunStoreError({ operation: "read", reason: "invalid" })),
          Effect.flatMap((subject) => options.reviews.read(reviewRunIdentity(subject, diff))),
          Effect.map((saved): ReviewRunReading =>
            saved === null ? { _tag: "NotRecorded" } : {
              _tag: "Ready",
              run: { ...saved, identity: { ...saved.identity, subjectId: ref } }
            }
          ),
          Effect.tapError((failure) => Effect.logWarning("Code review history could not be read", failure)),
          Effect.catchTag("ReviewRunStoreError", (failure) =>
            Effect.succeed(
              {
                _tag: "Unavailable",
                reason: failure.reason
              } satisfies ReviewRunReading
            ))
        )
        const conversations = yield* cache.comments({
          accountId: row.awsAccountId,
          region: row.accountRegion,
          repository: row.repositoryName,
          id: row.id
        }).pipe(
          Effect.flatMap((cached) => reviewConversationsOf(cached, diff)),
          Effect.catchTag("HostCommentsReadError", (failure) =>
            Effect.succeed({
              _tag: "Unavailable",
              reason: failure.reason
            })),
          cacheFailure
        )
        return yield* Schema.decodeUnknownEffect(CodeReviewReading, { onExcessProperty: "error" })({
          diff: { ...diff, readAt: observedAt, cacheUpdatedAt: row.lastModifiedDate.getTime() },
          workspace: {
            identity,
            observedAt,
            run,
            conversations,
            checks: { _tag: "Unknown" }
          }
        })
      }))
    }),
    diff: Effect.fn("CodeHostReads.diff")(function*(ref: CodeReference, caller: { readonly login: string }) {
      return yield* boundedRead(Effect.gen(function*() {
        const row = yield* exact(ref)
        const client = yield* clientFor(caller)
        const pullRequest = yield* Schema.decodeUnknownEffect(CachedPRToPullRequest)(row)
        const result = yield* loadPullRequestDiff(client, pullRequest)
        const readAt = yield* Clock.currentTimeMillis
        return yield* Schema.decodeUnknownEffect(CodeDiff)({
          ...result,
          readAt,
          cacheUpdatedAt: row.lastModifiedDate.getTime()
        })
      }))
    }),
    diffContent: Effect.fn("CodeHostReads.diffContent")(
      function*(query: CodeDiffContentQuery, caller: { readonly login: string }) {
        return yield* boundedRead(Effect.gen(function*() {
          const row = yield* exact(query.ref)
          const client = yield* clientFor(caller)
          const pullRequest = yield* Schema.decodeUnknownEffect(CachedPRToPullRequest)(row)
          const result = yield* loadPullRequestDiffContent(client, pullRequest, query, query.fileIndex)
          return yield* Schema.decodeUnknownEffect(CodeDiffContent)(result)
        }))
      }
    ),
    canvas: Effect.fn("CodeHostReads.canvas")(function*(ref: CodeReference, caller: { readonly login: string }) {
      const { changedFiles, diff, pullRequest } = yield* boundedRead(Effect.gen(function*() {
        const row = yield* exact(ref)
        const client = yield* clientFor(caller)
        const pullRequest = yield* Schema.decodeUnknownEffect(CachedPRToPullRequest)(row)
        // One changed-file inventory for the whole job: each file load reuses it instead of listing the change again.
        const changedFiles = yield* makePullRequestChangedFilesSource(client)
        const diff = yield* loadPullRequestDiff(client, pullRequest, changedFiles)
        return { changedFiles, diff, pullRequest }
      }))
      const load = (index: number): Effect.Effect<CanvasSourceFile, CodeHostReadError> =>
        boundedReadIn(canvasLane)(Effect.gen(function*() {
          const file = diff.files[index]
          if (file === undefined) return yield* new CodeHostReadError({ reason: "unavailable" })
          const client = yield* clientFor(caller)
          const content = yield* loadPullRequestDiffContent(client, pullRequest, diff, index, changedFiles)
          const text: CanvasSourceFile["content"] = content.state === "text"
            ? { _tag: "Text", before: content.before, after: content.after }
            : { _tag: "Opaque" }
          const source: CanvasSourceFile = {
            path: file.path,
            status: file.status,
            previousPath: file.previousPath,
            content: text
          }
          return source
        }))
      const graph = yield* canvasJobs.read(
        JSON.stringify([ref, diff.revisionId, diff.headCommit, caller.login]),
        diff.headCommit,
        diff.files.length,
        load
      )
      const reading = {
        graph,
        context: { lastLook: notRecorded, readingPath: notRecorded, findings: notRecorded, tests: notRecorded }
      }
      return yield* Schema.decodeUnknownEffect(CanvasReading, { onExcessProperty: "error" })(reading).pipe(
        Effect.tapError((cause) => Effect.logWarning("Code canvas reading is invalid", cause)),
        Effect.mapError(() => new CodeHostReadError({ reason: "unavailable" }))
      )
    })
  } satisfies CodeHostReads
})

/**
 * Call only on the explicitly configured credential host. Acquires one provider at startup and
 * attaches lazily to the existing owner cache. Failed attachments retry after two seconds;
 * a successful attachment stays scoped to the host runtime. No cache creation or migration.
 * Returned methods carry no provider configuration or permission-grant authority.
 */
export const makeCodeHostReads = Effect.fn("CodeHostReads.make")(function*(
  referenceStore: Effect.Effect<
    CodeReferenceStore,
    CodeHostReadError,
    Scope.Scope | Crypto.Crypto | FileSystem.FileSystem | Path.Path
  >
) {
  const home = yield* Config.String("HOME").pipe(Config.orElse(() => Config.String("USERPROFILE")))
  const path = yield* Path.Path
  const directory = path.join(home, ".codecommit")
  const providerContext = yield* Layer.build(
    ReadClient.CodeCommitReadClient.live.pipe(
      Layer.provide(AwsClientConfig.layer({ operationTimeout: "12 seconds", maxRetries: 0 }))
    )
  )
  const inner = Context.get(providerContext, ReadClient.CodeCommitReadClient)
  const attachment = yield* ScopedCache.makeWith({
    capacity: 1,
    lookup: (_key: "owner") =>
      Effect.gen(function*() {
        const cache = yield* attachHostCache(path.join(directory, "cache.db")).pipe(cacheFailure)
        const references = yield* referenceStore.pipe(
          Effect.tapError((cause) => Effect.logWarning("Code reference store is unavailable", cause))
        )
        const reviews = yield* makeReviewRunReader(path.join(directory, "reviews"))
        return yield* makeCodeHostReadsFromClient({
          cache,
          reviews,
          references,
          configPath: path.join(directory, "config.json"),
          permissionPath: path.join(directory, "permissions.json")
        }, inner)
      }),
    timeToLive: (exit) => Exit.isSuccess(exit) ? Duration.infinity : "2 seconds"
  })
  const read = <A>(operation: (reads: CodeHostReads) => Effect.Effect<A, CodeHostReadError>) =>
    ScopedCache.get(attachment, "owner").pipe(Effect.flatMap((reads) =>
      operation(reads).pipe(
        // Retire only the failed attachment. A concurrent failure must not evict its replacement.
        // A failed reattachment uses the ordinary 2s negative TTL; a valid replacement is ready immediately.
        Effect.tapError((failure) =>
          failure.reason === "cache_unavailable"
            ? ScopedCache.invalidateWhen(attachment, "owner", (cached) => cached === reads)
            : Effect.void
        )
      )
    ))
  return {
    queue: (query) => read((reads) => reads.queue(query)),
    detail: (ref) => read((reads) => reads.detail(ref)),
    review: (ref, caller) => read((reads) => reads.review(ref, caller)),
    diff: (ref, caller) => read((reads) => reads.diff(ref, caller)),
    diffContent: (query, caller) => read((reads) => reads.diffContent(query, caller)),
    canvas: (ref, caller) => read((reads) => reads.canvas(ref, caller))
  } satisfies CodeHostReads
})
