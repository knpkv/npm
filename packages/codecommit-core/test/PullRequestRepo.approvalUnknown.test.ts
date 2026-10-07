import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { DatabaseLive } from "../src/CacheService/Database.js"
import { CachedPullRequest, PullRequestRepo, UpsertInput } from "../src/CacheService/repos/PullRequestRepo/index.js"
import { StatsRepo } from "../src/CacheService/repos/StatsRepo/index.js"
import { approvalOf } from "../src/Domain.js"
import { decodeCachedPR } from "../src/PRService/internal.js"

const rule = (satisfied: boolean) => ({
  ruleName: "two-reviewers",
  requiredApprovals: 2,
  poolMembers: ["alice"],
  poolMemberArns: [],
  satisfied
})

const upsertInput = (
  id: string,
  evaluation: { readonly isApproved: 0 | 1; readonly satisfied: boolean; readonly unknown: "NotPermitted" | null }
) =>
  Schema.decodeSync(UpsertInput)({
    id,
    awsAccountId: "123456789012",
    repoAccountId: null,
    accountProfile: "production",
    accountRegion: "eu-west-1",
    title: `PR ${id}`,
    description: null,
    author: "author",
    repositoryName: "payments",
    creationDate: "2026-10-05T00:00:00.000Z",
    lastModifiedDate: "2026-10-05T00:00:00.000Z",
    status: "OPEN",
    sourceBranch: "feature",
    destinationBranch: "main",
    isMergeable: 1,
    isApproved: evaluation.isApproved,
    approvalUnknownReason: evaluation.unknown,
    commentCount: 0,
    link: `https://example.invalid/pr/${id}`,
    approvedBy: [],
    approvedByArns: [],
    approvalRules: [rule(evaluation.satisfied)]
  })

/**
 * A provider re-read of the pull request at the cached revision (same last activity), evaluated or
 * with its approval unknown.
 */
const reread = (
  read: { readonly isApproved?: boolean; readonly unknown?: "Throttled"; readonly lastActivityDate?: string }
) => ({
  isApproved: read.isApproved ?? false,
  approvalRules: [rule(read.isApproved ?? false)],
  ...(read.unknown !== undefined && { approvalUnknown: { _tag: read.unknown } })
})

/** The version a re-read carries: its last activity (the cached revision by default) and a fresh observation. */
const versionOf = (read: { readonly lastActivityDate?: string }) =>
  Effect.map(Effect.flatMap(PullRequestRepo, (repo) => repo.observe()), (observation) => ({
    lastActivity: new Date(read.lastActivityDate ?? "2026-10-05T00:00:00.000Z"),
    observation
  }))

const withCache = <A, E>(
  body: Effect.Effect<A, E, PullRequestRepo | StatsRepo>
) =>
  Effect.gen(function*() {
    const node = yield* Layer.build(NodeServices.layer)
    return yield* withServices(body).pipe(Effect.provideContext(node))
  }).pipe(Effect.scoped)

/** The repositories on a fresh cache database under a temporary HOME. */
const withServices = <A, E>(
  body: Effect.Effect<A, E, PullRequestRepo | StatsRepo>
) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-approval-unknown-" })
    const services = Layer.mergeAll(PullRequestRepo.Default, StatsRepo.Default, DatabaseLive).pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: root } })))
    )
    const context = yield* Layer.build(services)
    return yield* body.pipe(Effect.provideContext(context))
  })

const read = (id: string) =>
  Effect.flatMap(PullRequestRepo, (repo) => repo.findByCoordinates("123456789012", id, "payments", "eu-west-1")).pipe(
    Effect.map(Option.getOrThrow)
  )

describe("PullRequestRepo approval unknown", () => {
  it.effect("keeps the last known approval and rules while unknown, and a later evaluation replaces and clears them", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* repo.upsert(upsertInput("42", { isApproved: 1, satisfied: true, unknown: null }), yield* repo.observe())
      yield* repo.upsert(
        upsertInput("42", { isApproved: 0, satisfied: false, unknown: "NotPermitted" }),
        yield* repo.observe()
      )

      const unknown = yield* read("42")
      expect(unknown.isApproved).toBe(true)
      expect(unknown.approvalUnknownReason).toBe("NotPermitted")
      expect(unknown.approvalRules.map((r) => r.satisfied)).toEqual([true])
      expect(approvalOf(decodeCachedPR(unknown))).toEqual({ _tag: "Unknown", reason: { _tag: "NotPermitted" } })

      yield* repo.upsert(upsertInput("42", { isApproved: 0, satisfied: false, unknown: null }), yield* repo.observe())
      const evaluated = yield* read("42")
      expect(evaluated.approvalUnknownReason).toBeNull()
      expect(evaluated.approvalRules.map((r) => r.satisfied)).toEqual([false])
      expect(approvalOf(decodeCachedPR(evaluated))).toEqual({ _tag: "Pending" })
    })))

  it.effect("stores a never-cached pull request whose evaluation failed, reading as Unknown", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* repo.upsert(
        upsertInput("43", { isApproved: 0, satisfied: false, unknown: "NotPermitted" }),
        yield* repo.observe()
      )
      expect(approvalOf(decodeCachedPR(yield* read("43"))))
        .toEqual({ _tag: "Unknown", reason: { _tag: "NotPermitted" } })
    })))

  it.effect("does not count a last known approval as approved in health stats while it is unknown", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      const stats = yield* StatsRepo
      yield* repo.upsert(upsertInput("44", { isApproved: 1, satisfied: true, unknown: null }), yield* repo.observe())
      yield* repo.upsert(upsertInput("45", { isApproved: 1, satisfied: true, unknown: null }), yield* repo.observe())
      yield* repo.upsert(
        upsertInput("45", { isApproved: 0, satisfied: false, unknown: "NotPermitted" }),
        yield* repo.observe()
      )
      const health = yield* stats.healthIndicators("2026-10-01T00:00:00.000Z", "2026-10-08T00:00:00.000Z", {})
      expect(health.total).toBe(2)
      expect(health.approved).toBe(1)
    })))

  it.effect("records a re-read's evaluation: unknown keeps the last known approval, evaluated replaces it", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      const coordinates = { repositoryName: "payments", accountRegion: "eu-west-1" }
      yield* repo.upsert(upsertInput("46", { isApproved: 1, satisfied: true, unknown: null }), yield* repo.observe())
      yield* repo.recordApprovalEvaluation(
        "123456789012",
        "46",
        reread({ unknown: "Throttled" }),
        yield* versionOf({ unknown: "Throttled" }),
        coordinates
      )
      const unknown = yield* read("46")
      expect([unknown.isApproved, unknown.approvalUnknownReason]).toEqual([true, "Throttled"])

      yield* repo.recordApprovalEvaluation(
        "123456789012",
        "46",
        reread({ isApproved: false }),
        yield* versionOf({ isApproved: false }),
        coordinates
      )
      const evaluated = yield* read("46")
      expect([evaluated.isApproved, evaluated.approvalUnknownReason]).toEqual([false, null])
      expect(evaluated.approvalRules.map((r) => r.satisfied)).toEqual([false])
    })))

  // The write contract takes complete rules: a partial one would decode to no rules on the next read,
  // silently dropping the approval requirements.
  it.effect("persists an evaluation's complete rules and reads them back", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      const coordinates = { repositoryName: "payments", accountRegion: "eu-west-1" }
      yield* repo.upsert(upsertInput("47", { isApproved: 0, satisfied: false, unknown: null }), yield* repo.observe())
      yield* repo.recordApprovalEvaluation(
        "123456789012",
        "47",
        reread({ isApproved: true }),
        yield* versionOf({ isApproved: true }),
        coordinates
      )
      expect((yield* read("47")).approvalRules.map((r) => [r.ruleName, r.requiredApprovals, r.satisfied]))
        .toEqual([["two-reviewers", 2, true]])
    })))

  // The history sync runs outside the refresh lock: its read of an older revision must not overwrite
  // the approval a refresh has since stored for a newer one.
  it.effect("keeps a newer revision's approval when an older read's evaluation lands after it", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      const coordinates = { repositoryName: "payments", accountRegion: "eu-west-1" }
      yield* repo.upsert(
        Schema.decodeSync(UpsertInput)({
          ...Schema.encodeSync(UpsertInput)(upsertInput("48", { isApproved: 0, satisfied: false, unknown: null })),
          lastModifiedDate: "2026-10-06T00:00:00.000Z"
        }),
        yield* repo.observe()
      )
      yield* repo.recordApprovalEvaluation(
        "123456789012",
        "48",
        reread({ isApproved: true }),
        yield* versionOf({ isApproved: true }),
        coordinates
      )
      yield* repo.recordApprovalEvaluation(
        "123456789012",
        "48",
        reread({ unknown: "Throttled" }),
        yield* versionOf({ unknown: "Throttled" }),
        coordinates
      )
      const kept = yield* read("48")
      expect([kept.isApproved, kept.approvalUnknownReason]).toEqual([false, null])

      // A read of the newer revision is recorded.
      yield* repo.recordApprovalEvaluation(
        "123456789012",
        "48",
        reread({ isApproved: true, lastActivityDate: "2026-10-06T00:00:00.000Z" }),
        yield* versionOf({ isApproved: true, lastActivityDate: "2026-10-06T00:00:00.000Z" }),
        coordinates
      )
      expect((yield* read("48")).isApproved).toBe(true)
    })))

  // An accepted evaluation is as fresh as its read, so an older read that lands after it is dropped.
  it.effect("drops an older read's evaluation that lands after a newer one", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      const coordinates = { repositoryName: "payments", accountRegion: "eu-west-1" }
      yield* repo.upsert(upsertInput("53", { isApproved: 0, satisfied: false, unknown: null }), yield* repo.observe())
      yield* repo.recordApprovalEvaluation(
        "123456789012",
        "53",
        reread({ isApproved: false, lastActivityDate: "2026-10-07T00:00:00.000Z" }),
        yield* versionOf({ isApproved: false, lastActivityDate: "2026-10-07T00:00:00.000Z" }),
        coordinates
      )
      yield* repo.recordApprovalEvaluation(
        "123456789012",
        "53",
        reread({ isApproved: true, lastActivityDate: "2026-10-06T00:00:00.000Z" }),
        yield* versionOf({ isApproved: true, lastActivityDate: "2026-10-06T00:00:00.000Z" }),
        coordinates
      )
      const row = yield* read("53")
      // The newer evaluation wins; an evaluation moves only the approval group, so the row keeps its date.
      expect([row.isApproved, row.lastModifiedDate.toISOString()]).toEqual([false, "2026-10-05T00:00:00.000Z"])
    })))

  // A stale CLOSED read must not rewind a newer row, which would then let its evaluation through.
  it.effect("keeps a newer row when an older read closes it, and still closes it from a newer read", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      const coordinates = { repositoryName: "payments", accountRegion: "eu-west-1" }
      yield* repo.upsert(
        Schema.decodeSync(UpsertInput)({
          ...Schema.encodeSync(UpsertInput)(upsertInput("54", { isApproved: 0, satisfied: false, unknown: null })),
          lastModifiedDate: "2026-10-06T00:00:00.000Z"
        }),
        yield* repo.observe()
      )
      yield* repo.updateStatusAndClosedAt(
        "123456789012",
        "54",
        "CLOSED",
        "2026-10-05T12:00:00.000Z",
        yield* repo.observe(),
        undefined,
        [],
        coordinates
      )
      const kept = yield* read("54")
      expect([kept.status, kept.lastModifiedDate.toISOString()]).toEqual(["OPEN", "2026-10-06T00:00:00.000Z"])

      yield* repo.updateStatusAndClosedAt(
        "123456789012",
        "54",
        "CLOSED",
        "2026-10-07T00:00:00.000Z",
        yield* repo.observe(),
        undefined,
        [],
        coordinates
      )
      expect((yield* read("54")).status).toBe("CLOSED")
    })))

  // Every row has the column since migration 0022. A row without it is a projection that dropped it,
  // and reading it as known would show a stale approval as current.
  it.effect("rejects a cached row without its approval-unknown column, and accepts NULL", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* repo.upsert(upsertInput("55", { isApproved: 1, satisfied: true, unknown: null }), yield* repo.observe())
      const { approvalUnknownReason, ...withoutColumn } = Schema.encodeSync(CachedPullRequest)(yield* read("55"))
      expect(approvalUnknownReason).toBeNull()
      expect(Schema.decodeUnknownExit(CachedPullRequest)(withoutColumn)._tag).toBe("Failure")
      expect(Schema.decodeUnknownExit(CachedPullRequest)({ ...withoutColumn, approvalUnknownReason: null })._tag)
        .toBe("Success")
    })))
})
