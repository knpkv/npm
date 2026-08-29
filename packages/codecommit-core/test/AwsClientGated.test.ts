import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema, Stream } from "effect"
import { AwsClientGatedLive, InnerAwsClient } from "../src/AwsClient/AwsClientGated.js"
import { AwsClient } from "../src/AwsClient/index.js"
import { AwsProfileName, AwsRegion } from "../src/Domain.js"
import { AuditLogRepo } from "../src/PermissionService/AuditLog.js"
import { PermissionService } from "../src/PermissionService/index.js"
import { PermissionGate } from "../src/PermissionService/PermissionGate.js"

const unused = (operation: string) => Effect.die(`unexpected ${operation}`)

describe("AwsClientGated", () => {
  it.effect("forwards exact-repository pull-request options to the inner client", () => {
    const calls: Array<unknown> = []
    const inner: AwsClient.Service = {
      getPullRequests: (account, options) => {
        calls.push({ account, options })
        return Stream.empty
      },
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
    }
    const dependencies = Layer.mergeAll(
      Layer.succeed(InnerAwsClient, inner),
      Layer.succeed(
        PermissionService,
        PermissionService.of({
          check: () => Effect.succeed("always_allow"),
          set: () => Effect.void,
          getAll: () => Effect.succeed({}),
          resetAll: () => Effect.void,
          isAuditEnabled: () => Effect.succeed(false),
          getAuditRetention: () => Effect.succeed(30),
          setAudit: () => Effect.void
        })
      ),
      Layer.succeed(PermissionGate, PermissionGate.of({ request: () => Effect.succeed("allow_once") })),
      Layer.succeed(
        AuditLogRepo,
        AuditLogRepo.of({
          log: () => Effect.void,
          findAll: () => Effect.succeed({ items: [], total: 0 }),
          prune: () => Effect.succeed(0),
          clearAll: () => Effect.succeed(0),
          exportAll: () => Effect.succeed([])
        })
      )
    )
    const account = {
      profile: Schema.decodeSync(AwsProfileName)("dev"),
      region: Schema.decodeSync(AwsRegion)("eu-west-1")
    }

    return Effect.gen(function*() {
      const client = yield* AwsClient
      yield* client.getPullRequests(account, { status: "OPEN", repositoryName: "identity" }).pipe(Stream.runDrain)

      expect(calls).toEqual([{
        account,
        options: { status: "OPEN", repositoryName: "identity" }
      }])
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(AwsClientGatedLive.pipe(Layer.provide(dependencies)))
    )
  })
})
