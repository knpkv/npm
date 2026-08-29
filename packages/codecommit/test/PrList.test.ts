import { describe, expect, it } from "@effect/vitest"
import { AwsClient } from "@knpkv/codecommit-core"
import { Data, Effect, Layer, Stream } from "effect"
import { FilterService } from "../src/FilterService.js"
import { PrListConfigUnreadable, PrListService } from "../src/PrList.js"

class ConfigFixtureError extends Data.TaggedError("ConfigFixtureError") {
  override get message(): string {
    return "invalid fixture config"
  }
}

const unused = (operation: string) => Effect.die(`unexpected ${operation}`)

const AwsLayer = Layer.succeed(
  AwsClient.AwsClient,
  AwsClient.AwsClient.of({
    getPullRequests: () => Stream.die("unexpected getPullRequests"),
    getCallerIdentity: () => unused("getCallerIdentity"),
    createPullRequest: () => unused("createPullRequest"),
    listBranches: () => unused("listBranches"),
    getCommentsForPullRequest: () => unused("getCommentsForPullRequest"),
    updatePullRequestTitle: () => unused("updatePullRequestTitle"),
    updatePullRequestDescription: () => unused("updatePullRequestDescription"),
    getPullRequest: () => unused("getPullRequest"),
    getDifferences: () => unused("getDifferences"),
    createApprovalRule: () => unused("createApprovalRule"),
    updateApprovalRule: () => unused("updateApprovalRule"),
    deleteApprovalRule: () => unused("deleteApprovalRule")
  })
)

const FilterLayer = Layer.succeed(
  FilterService,
  FilterService.of({
    resolveTargets: Effect.fail(new ConfigFixtureError()),
    collect: () => unused("collect"),
    collectOpen: () => unused("collectOpen")
  })
)

const PrListLayer = PrListService.live.pipe(
  Layer.provide(Layer.mergeAll(AwsLayer, FilterLayer))
)

describe("PrListService", () => {
  it.effect("keeps config load failures in the typed error channel", () =>
    Effect.gen(function*() {
      const service = yield* PrListService
      const error = yield* service.resolveTargets.pipe(Effect.flip)

      expect(error).toBeInstanceOf(PrListConfigUnreadable)
      expect(error.message).toContain("invalid fixture config")
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(PrListLayer)
    ))
})
