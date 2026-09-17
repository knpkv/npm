import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { AwsClient } from "@knpkv/codecommit-core"
import { Effect, Layer, Stream } from "effect"
import { TestConsole } from "effect/testing"
import { Command } from "effect/unstable/cli"
import { prUpdateCommand } from "../src/PrUpdate.js"

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

describe("pr update", () => {
  it.effect("fails on stderr when neither update flag is present", () =>
    Effect.gen(function*() {
      const exit = yield* Command.runWith(prUpdateCommand, { version: "0.0.0-test" })(["42"]).pipe(Effect.exit)
      const stdout = yield* TestConsole.logLines
      const stderr = yield* TestConsole.errorLines

      expect(exit._tag).toBe("Failure")
      expect(stdout).toEqual([])
      expect(stderr).toEqual(["At least one of --title or --description must be provided"])
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(Layer.mergeAll(AwsLayer, NodeServices.layer))
    ))
})
