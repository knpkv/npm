/** @effect-diagnostics strictEffectProvide:skip-file */

import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { DatabaseLive } from "../src/CacheService/Database.js"
import { PullRequestRepo, UpsertInput } from "../src/CacheService/repos/PullRequestRepo/index.js"
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

const withCache = <A, E>(
  body: Effect.Effect<A, E, PullRequestRepo | StatsRepo>
) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-approval-unknown-" })
    const services = Layer.mergeAll(PullRequestRepo.Default, StatsRepo.Default, DatabaseLive).pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: root } })))
    )
    return yield* body.pipe(Effect.provide(services), Effect.scoped)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const read = (id: string) =>
  Effect.flatMap(PullRequestRepo, (repo) => repo.findByCoordinates("123456789012", id, "payments", "eu-west-1")).pipe(
    Effect.map(Option.getOrThrow)
  )

describe("PullRequestRepo approval unknown", () => {
  it.effect("keeps the last known approval and rules while unknown, and a later evaluation replaces and clears them", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* repo.upsert(upsertInput("42", { isApproved: 1, satisfied: true, unknown: null }))
      yield* repo.upsert(upsertInput("42", { isApproved: 0, satisfied: false, unknown: "NotPermitted" }))

      const unknown = yield* read("42")
      expect(unknown.isApproved).toBe(true)
      expect(unknown.approvalUnknownReason).toBe("NotPermitted")
      expect(unknown.approvalRules.map((r) => r.satisfied)).toEqual([true])
      expect(approvalOf(decodeCachedPR(unknown))).toEqual({ _tag: "Unknown", reason: { _tag: "NotPermitted" } })

      yield* repo.upsert(upsertInput("42", { isApproved: 0, satisfied: false, unknown: null }))
      const evaluated = yield* read("42")
      expect(evaluated.approvalUnknownReason).toBeNull()
      expect(evaluated.approvalRules.map((r) => r.satisfied)).toEqual([false])
      expect(approvalOf(decodeCachedPR(evaluated))).toEqual({ _tag: "Pending" })
    })))

  it.effect("stores a never-cached pull request whose evaluation failed, reading as Unknown", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      yield* repo.upsert(upsertInput("43", { isApproved: 0, satisfied: false, unknown: "NotPermitted" }))
      expect(approvalOf(decodeCachedPR(yield* read("43"))))
        .toEqual({ _tag: "Unknown", reason: { _tag: "NotPermitted" } })
    })))

  it.effect("does not count a last known approval as approved in health stats while it is unknown", () =>
    withCache(Effect.gen(function*() {
      const repo = yield* PullRequestRepo
      const stats = yield* StatsRepo
      yield* repo.upsert(upsertInput("44", { isApproved: 1, satisfied: true, unknown: null }))
      yield* repo.upsert(upsertInput("45", { isApproved: 1, satisfied: true, unknown: null }))
      yield* repo.upsert(upsertInput("45", { isApproved: 0, satisfied: false, unknown: "NotPermitted" }))
      const health = yield* stats.healthIndicators("2026-10-01T00:00:00.000Z", "2026-10-08T00:00:00.000Z", {})
      expect(health.total).toBe(2)
      expect(health.approved).toBe(1)
    })))
})
