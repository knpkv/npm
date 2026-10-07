/**
 * A merged or closed pull request is never listed again, so approvers that couldn't be read on its
 * last read would stay unknown forever. Each refresh's stale pass re-reads a capped batch of them,
 * oldest-updated first, on a real cache: the batch drains across refreshes, and a failed re-read stays
 * unknown without holding the refresh back.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer, Option, Ref, Schema, Stream, SubscriptionRef } from "effect"
import { AwsClient } from "../src/AwsClient/index.js"
import { PullRequestDetail } from "../src/AwsClient/internal.js"
import { DatabaseLive } from "../src/CacheService/Database.js"
import { NotificationRepo } from "../src/CacheService/repos/NotificationRepo.js"
import { PullRequestRepo, UpsertInput } from "../src/CacheService/repos/PullRequestRepo/index.js"
import { SubscriptionRepo } from "../src/CacheService/repos/SubscriptionRepo.js"
import { AccountConfig } from "../src/ConfigService/internal.js"
import { type AppState, AwsProfileName, AwsRegion } from "../src/Domain.js"
import { AwsApiError } from "../src/Errors.js"
import { fetchAndUpsertPRs } from "../src/PRService/refreshFetch.js"

const awsAccountId = "123456789012"
const account = Schema.decodeSync(AccountConfig)({ profile: "test-profile", regions: ["us-east-1"], enabled: true })

/** A cached row as an earlier read left it (a first read with unknown approvers stores none). */
const row = (id: string, read: {
  readonly status: "OPEN" | "MERGED"
  readonly lastModifiedDate: string
  readonly approvedBy: ReadonlyArray<string>
  readonly approversUnknown: boolean
}) =>
  Schema.decodeSync(UpsertInput)({
    id,
    awsAccountId,
    repoAccountId: null,
    accountProfile: "test-profile",
    accountRegion: "us-east-1",
    title: `PR ${id}`,
    description: null,
    author: "author",
    repositoryName: "payments",
    creationDate: "2026-08-01T00:00:00.000Z",
    lastModifiedDate: read.lastModifiedDate,
    status: read.status,
    sourceBranch: "feature",
    destinationBranch: "main",
    isMergeable: 1,
    isApproved: 0,
    approvalUnknownReason: null,
    commentCount: 0,
    link: `https://example.invalid/pr/${id}`,
    approvedBy: [...read.approvedBy],
    approvedByArns: [],
    approversUnknown: read.approversUnknown,
    approvalRules: []
  })

/** The provider's read of a pull request: merged, at its cached last activity, with these approvers. */
const detail = (lastActivityDate: string, approvedBy: ReadonlyArray<string>, approversUnknown = false) =>
  new PullRequestDetail({
    ...Schema.decodeSync(PullRequestDetail)({
      revisionId: "revision",
      sourceCommit: "a".repeat(40),
      title: "Merged",
      author: "author",
      status: "MERGED",
      repositoryName: "payments",
      sourceBranch: "feature",
      destinationBranch: "main",
      creationDate: new Date("2026-08-01T00:00:00.000Z"),
      lastActivityDate: new Date(lastActivityDate),
      approvedBy: [...approvedBy],
      approvedByArns: [],
      isMergeable: true,
      approvalRules: []
    }),
    ...(approversUnknown && { approversUnknown: true })
  })

/** One refresh with no listed pull requests, where `reread` answers each single-PR read. */
const refresh = (reread: (id: string) => Effect.Effect<PullRequestDetail, AwsApiError>) =>
  Effect.gen(function*() {
    const state = yield* SubscriptionRef.make<AppState>({ pullRequests: [], accounts: [], status: "loading" })
    const providers = yield* Layer.build(Layer.mergeAll(
      Layer.mock(AwsClient, {
        getPullRequests: () => Stream.empty,
        getPullRequest: ({ pullRequestId }) => reread(pullRequestId)
      }),
      Layer.mock(NotificationRepo, { addSystem: () => Effect.void }),
      Layer.mock(SubscriptionRepo, {})
    ))
    return yield* fetchAndUpsertPRs({
      state,
      enabledAccounts: [account],
      accountIdMap: new Map([["test-profile", awsAccountId]]),
      subscribedRef: yield* Ref.make(new Set<string>()),
      currentUser: undefined,
      identityGeneration: 1,
      staleThreshold: "9999-12-31T23:59:59Z"
    }).pipe(Effect.provideContext(providers))
  }).pipe(Effect.scoped)

const approversOf = (id: string) =>
  Effect.flatMap(PullRequestRepo, (repo) => repo.findByCoordinates(awsAccountId, id, "payments", "us-east-1")).pipe(
    Effect.map(Option.map((cached) => ({ approvedBy: cached.approvedBy, unknown: cached.approversUnknown })))
  )

const withCache = <A, E>(body: Effect.Effect<A, E, PullRequestRepo>) =>
  Effect.gen(function*() {
    const node = yield* Layer.build(NodeServices.layer)
    return yield* Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-approver-repair-" })
      const services = Layer.mergeAll(PullRequestRepo.Default, DatabaseLive).pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: root } })))
      )
      return yield* body.pipe(Effect.provideContext(yield* Layer.build(services)))
    }).pipe(Effect.provideContext(node))
  }).pipe(Effect.scoped)

const day = (n: number) => `2026-08-${String(n).padStart(2, "0")}T00:00:00.000Z`

describe("approver repair of merged and closed pull requests", () => {
  it.effect("re-reads 25 per refresh, oldest-updated first, until none is unknown", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      const ids = Array.from({ length: 30 }, (_, i) => String(100 + i))
      // Updated on days 1..30: 100 is the oldest.
      for (const [i, id] of ids.entries()) {
        yield* repo.upsert(
          row(id, { status: "MERGED", lastModifiedDate: day(i + 1), approvedBy: [], approversUnknown: true }),
          yield* repo.observe()
        )
      }
      const reads = yield* Ref.make<ReadonlyArray<string>>([])
      const reread = (id: string) =>
        Ref.update(reads, (all) => [...all, id]).pipe(
          Effect.as(detail(day(ids.indexOf(id) + 1), ["alice"]))
        )

      yield* refresh(reread)
      expect([...(yield* Ref.get(reads))].sort()).toEqual(ids.slice(0, 25))
      expect(yield* approversOf("100")).toEqual(Option.some({ approvedBy: ["alice"], unknown: false }))
      expect(yield* approversOf("129")).toEqual(Option.some({ approvedBy: [], unknown: true }))

      yield* Ref.set(reads, [])
      yield* refresh(reread)
      expect([...(yield* Ref.get(reads))].sort()).toEqual(ids.slice(25))
      expect(yield* approversOf("129")).toEqual(Option.some({ approvedBy: ["alice"], unknown: false }))

      yield* Ref.set(reads, [])
      yield* refresh(reread)
      expect(yield* Ref.get(reads)).toEqual([])
    })))

  // The stale pass finds a pull request merged while its approver read failed: the row is terminal
  // and unknown, and the next refresh's repair reads its approvers.
  it.effect("heals a pull request that merged while its approvers couldn't be read", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* repo.upsert(
        row("7", { status: "OPEN", lastModifiedDate: day(1), approvedBy: ["bob"], approversUnknown: false }),
        yield* repo.observe()
      )
      yield* refresh(() => Effect.succeed(detail(day(2), [], true)))
      expect(yield* approversOf("7")).toEqual(Option.some({ approvedBy: ["bob"], unknown: true }))

      yield* refresh(() => Effect.succeed(detail(day(2), ["alice"])))
      expect(yield* approversOf("7")).toEqual(Option.some({ approvedBy: ["alice"], unknown: false }))
    })))

  it.effect("keeps a row unknown when its repair read fails, and still reports the refresh", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* repo.upsert(
        row("8", { status: "MERGED", lastModifiedDate: day(1), approvedBy: [], approversUnknown: true }),
        yield* repo.observe()
      )
      const scopes = yield* refresh(() =>
        Effect.fail(
          new AwsApiError({
            operation: "getPullRequest",
            profile: AwsProfileName.make("test-profile"),
            region: AwsRegion.make("us-east-1"),
            cause: "boom"
          })
        )
      )
      expect(yield* approversOf("8")).toEqual(Option.some({ approvedBy: [], unknown: true }))
      expect(scopes).toEqual([{ profile: "test-profile", region: "us-east-1", awsAccountId }])
    })))
})
