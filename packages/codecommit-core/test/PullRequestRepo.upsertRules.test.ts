/** @effect-diagnostics strictEffectProvide:skip-file */

import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Layer, Option } from "effect"
import { DatabaseLive } from "../src/CacheService/Database.js"
import { PullRequestRepo, type UpsertInput } from "../src/CacheService/repos/PullRequestRepo/index.js"

/**
 * A single-PR refresh hands the cache the provider's approval rules as plain objects, as the detail
 * read builds them. The upsert must store them; before, it required ApprovalRule instances, failed
 * with a CacheError, and every refresh of a PR with a rule answered HTTP 500.
 */
const withRules: UpsertInput = {
  id: "44",
  awsAccountId: "123456789012",
  repoAccountId: null,
  accountProfile: "dev",
  accountRegion: "eu-central-1",
  title: "Stable Control Center live integration diff",
  description: null,
  author: "author",
  repositoryName: "control-center-live-fixture",
  creationDate: "2026-07-31T08:07:00.236Z",
  lastModifiedDate: "2026-07-31T08:07:00.236Z",
  status: "OPEN",
  sourceBranch: "fixture-change",
  destinationBranch: "main",
  isMergeable: 1,
  isApproved: 0,
  commentCount: 0,
  link: "https://example.invalid/pr/44",
  approvedBy: [],
  approvedByArns: [],
  approvalRules: [{
    ruleName: "Required Approvers",
    requiredApprovals: 1,
    poolMembers: ["reviewer"],
    poolMemberArns: ["arn:aws:sts::123456789012:assumed-role/R/reviewer"],
    satisfied: false
  }]
}

describe("PullRequestRepo.upsert approval rules", () => {
  it.effect("stores plain approval rules, as a single-PR refresh passes them", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codecommit-upsert-rules-" })
      const services = Layer.mergeAll(PullRequestRepo.Default, DatabaseLive).pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: root } })))
      )
      yield* Effect.gen(function*() {
        const repo = yield* PullRequestRepo
        yield* repo.upsert(withRules)
        const stored = yield* repo.findByCoordinates(
          "123456789012",
          "44",
          "control-center-live-fixture",
          "eu-central-1"
        )
        expect(Option.map(stored, (row) => row.approvalRules.map((rule) => [rule.ruleName, rule.poolMembers])))
          .toEqual(Option.some([["Required Approvers", ["reviewer"]]]))
      }).pipe(Effect.provide(services), Effect.scoped)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
