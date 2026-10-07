import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { DatabaseLive } from "../src/CacheService/Database.js"
import { diffPR } from "../src/CacheService/diff.js"
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
/**
 * A provider re-read of the pull request, whole: the row as listed (OPEN unless `status` says
 * otherwise) at `lastActivityDate` (the cached revision by default), evaluated or with its approval
 * unknown.
 */
const reread = (
  read: {
    readonly isApproved?: boolean
    readonly unknown?: "Throttled"
    readonly lastActivityDate?: string
    readonly status?: "OPEN" | "CLOSED"
  }
) => ({
  title: "Re-read",
  author: "author",
  status: read.status ?? "OPEN",
  creationDate: new Date("2026-10-05T00:00:00.000Z"),
  lastActivityDate: new Date(read.lastActivityDate ?? "2026-10-05T00:00:00.000Z"),
  sourceBranch: "feature",
  destinationBranch: "main",
  isMergeable: true,
  approvedBy: [],
  approvedByArns: [],
  isApproved: read.isApproved ?? false,
  approvalRules: [rule(read.isApproved ?? false)],
  ...(read.unknown !== undefined && { approvalUnknown: { _tag: read.unknown } })
})

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

  // CodeCommit evaluates a pull request with no rules as approved; nobody signed off, so the approval
  // rate does not count it, as the queue reads it "No approval required".
  it.effect("does not count a pull request without approval rules as approved in health stats", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      const stats = yield* StatsRepo
      yield* repo.upsert(upsertInput("48", { isApproved: 1, satisfied: true, unknown: null }), yield* repo.observe())
      yield* repo.upsert(
        { ...upsertInput("49", { isApproved: 1, satisfied: true, unknown: null }), approvalRules: [] },
        yield* repo.observe()
      )
      const health = yield* stats.healthIndicators("2026-10-01T00:00:00.000Z", "2026-10-08T00:00:00.000Z", {})
      expect([health.total, health.approved]).toEqual([2, 1])
    })))

  it.effect("records a re-read's evaluation: unknown keeps the last known approval, evaluated replaces it", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      const coordinates = { repositoryName: "payments", accountRegion: "eu-west-1" }
      yield* repo.upsert(upsertInput("46", { isApproved: 1, satisfied: true, unknown: null }), yield* repo.observe())
      yield* repo.writeRead("123456789012", "46", reread({ unknown: "Throttled" }), yield* repo.observe(), coordinates)
      const unknown = yield* read("46")
      expect([unknown.isApproved, unknown.approvalUnknownReason]).toEqual([true, "Throttled"])

      yield* repo.writeRead("123456789012", "46", reread({ isApproved: false }), yield* repo.observe(), coordinates)
      const evaluated = yield* read("46")
      expect([evaluated.isApproved, evaluated.approvalUnknownReason]).toEqual([false, null])
      expect(evaluated.approvalRules.map((r) => r.satisfied)).toEqual([false])
    })))

  // Recovery from Unknown is announced only over a known baseline: a pull request first seen while its
  // evaluation fails is cached as not approved, a placeholder, not a last known value.
  describe("approval baseline", () => {
    const approvalAnnouncements = (cached: CachedPullRequest, fresh: { readonly isApproved: boolean }) =>
      diffPR(cached, {
        ...cached,
        isApproved: fresh.isApproved,
        approvalUnknownReason: null,
        approvalRules: [rule(fresh.isApproved)]
      }, "123456789012").filter((n) => n.type === "approval_changed").map((n) => n.message)

    it.effect("announces nothing when a pull request first seen as unknown evaluates approved", () =>
      withCache(Effect.gen(function*() {
        const repo = yield* PullRequestRepo
        yield* repo.upsert(
          upsertInput("50", { isApproved: 0, satisfied: false, unknown: "NotPermitted" }),
          yield* repo.observe()
        )
        expect(approvalAnnouncements(yield* read("50"), { isApproved: true })).toEqual([])
      })))

    it.effect("announces a sign-off made while evaluation was failing, once the baseline was known", () =>
      withCache(Effect.gen(function*() {
        const repo = yield* PullRequestRepo
        yield* repo.upsert(upsertInput("51", { isApproved: 0, satisfied: false, unknown: null }), yield* repo.observe())
        yield* repo.upsert(
          upsertInput("51", { isApproved: 0, satisfied: false, unknown: "Throttled" }),
          yield* repo.observe()
        )
        const cached = yield* read("51")
        expect(approvalAnnouncements(cached, { isApproved: true })).toEqual([
          "Approval granted on #51 PR 51 (payments)"
        ])
        // Unchanged across the outage: nothing to announce.
        expect(approvalAnnouncements(cached, { isApproved: false })).toEqual([])
      })))

    it.effect("keeps the baseline known through a re-read that records unknown", () =>
      withCache(Effect.gen(function*() {
        const repo = yield* PullRequestRepo
        const coordinates = { repositoryName: "payments", accountRegion: "eu-west-1" }
        yield* repo.upsert(upsertInput("52", { isApproved: 1, satisfied: true, unknown: null }), yield* repo.observe())
        yield* repo.writeRead(
          "123456789012",
          "52",
          reread({ unknown: "Throttled" }),
          yield* repo.observe(),
          coordinates
        )
        expect(approvalAnnouncements(yield* read("52"), { isApproved: false })).toEqual([
          "Approval revoked on #52 Re-read (payments)"
        ])
      })))
  })

  // The write contract takes complete rules: a partial one would decode to no rules on the next read,
  // silently dropping the approval requirements.
  it.effect("persists an evaluation's complete rules and reads them back", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      const coordinates = { repositoryName: "payments", accountRegion: "eu-west-1" }
      yield* repo.upsert(upsertInput("47", { isApproved: 0, satisfied: false, unknown: null }), yield* repo.observe())
      yield* repo.writeRead("123456789012", "47", reread({ isApproved: true }), yield* repo.observe(), coordinates)
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
      yield* repo.writeRead("123456789012", "48", reread({ isApproved: true }), yield* repo.observe(), coordinates)
      yield* repo.writeRead("123456789012", "48", reread({ unknown: "Throttled" }), yield* repo.observe(), coordinates)
      const kept = yield* read("48")
      expect([kept.isApproved, kept.approvalUnknownReason]).toEqual([false, null])

      // A read of the newer revision is recorded.
      yield* repo.writeRead(
        "123456789012",
        "48",
        reread({ isApproved: true, lastActivityDate: "2026-10-06T00:00:00.000Z" }),
        yield* repo.observe(),
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
      yield* repo.writeRead(
        "123456789012",
        "53",
        reread({ isApproved: false, lastActivityDate: "2026-10-07T00:00:00.000Z" }),
        yield* repo.observe(),
        coordinates
      )
      yield* repo.writeRead(
        "123456789012",
        "53",
        reread({ isApproved: true, lastActivityDate: "2026-10-06T00:00:00.000Z" }),
        yield* repo.observe(),
        coordinates
      )
      const row = yield* read("53")
      // The newer read wins, whole: its approval and its revision.
      expect([row.isApproved, row.lastModifiedDate.toISOString()]).toEqual([false, "2026-10-07T00:00:00.000Z"])
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
      yield* repo.writeRead(
        "123456789012",
        "54",
        reread({ status: "CLOSED", lastActivityDate: "2026-10-05T12:00:00.000Z" }),
        yield* repo.observe(),
        coordinates
      )
      const kept = yield* read("54")
      expect([kept.status, kept.lastModifiedDate.toISOString()]).toEqual(["OPEN", "2026-10-06T00:00:00.000Z"])

      yield* repo.writeRead(
        "123456789012",
        "54",
        reread({ status: "CLOSED", lastActivityDate: "2026-10-07T00:00:00.000Z" }),
        yield* repo.observe(),
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
