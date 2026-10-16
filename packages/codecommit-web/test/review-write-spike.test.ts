import { expect, expectTypeOf, it } from "@effect/vitest"
import { AwsApiError } from "@knpkv/codecommit-core/Errors.js"
import { AuditLogRepo, type NewAuditLogEntry } from "@knpkv/codecommit-core/PermissionService/AuditLog.js"
import { PermissionService, type PermissionState } from "@knpkv/codecommit-core/PermissionService/index.js"
import { PermissionGate } from "@knpkv/codecommit-core/PermissionService/PermissionGate.js"
import {
  CodeCommitReviewAction,
  CodeCommitReviewClient,
  CodeCommitReviewConflictError,
  type CodeCommitReviewError,
  CodeCommitReviewReceipt
} from "@knpkv/codecommit-core/ReviewClient.js"
import { ConfigProvider, Effect, Result, Schema } from "effect"
import { makeRelayFindingPublisher, RelayFindingPublisher } from "../src/server/review/RelayFindingPublisher.js"
import { makeReviewWriteSpike } from "../src/server/review/ReviewWriteSpike.js"

const action = Schema.decodeSync(CodeCommitReviewAction.cases.comment)({
  _tag: "comment",
  target: {
    account: { profile: "owner-profile", region: "fixture-region" },
    repositoryName: "fixture-repository",
    pullRequestId: "7",
    revisionId: "revision-1",
    sourceCommit: "a".repeat(40),
    destinationCommit: "b".repeat(40),
    destinationReference: "refs/heads/main"
  },
  content: "A recorded finding with its prepared publication token.",
  clientRequestToken: "prepared-finding-token",
  location: { filePath: "src/example.ts", filePosition: 12, relativeFileVersion: "AFTER" }
})
const receipt = new CodeCommitReviewReceipt({ operationId: "comment:fixture-comment", summary: "Comment posted" })
const configured = (enabled: string | undefined) =>
  ConfigProvider.fromUnknown(
    enabled === undefined ? {} : { CODECOMMIT_REVIEW_WRITE_SPIKE_ENABLED: enabled }
  )

it.effect("default-off and explicit false refuse before the publisher is called", () =>
  Effect.gen(function*() {
    let calls = 0
    const publisher = RelayFindingPublisher.of({
      post: () =>
        Effect.sync(() => {
          calls += 1
          return receipt
        })
    })
    for (const flag of [undefined, "false"]) {
      const result = yield* Effect.result(makeReviewWriteSpike()).pipe(
        Effect.provideService(RelayFindingPublisher, publisher),
        Effect.provideService(ConfigProvider.ConfigProvider, configured(flag))
      )
      expect(result).toEqual(Result.fail(expect.objectContaining({ _tag: "ReviewWriteSpikeDisabled" })))
    }
    expect(calls).toBe(0)
  }))

it.effect("malformed config fails closed rather than enabling the experiment", () =>
  Effect.gen(function*() {
    let calls = 0
    const result = yield* Effect.result(makeReviewWriteSpike()).pipe(
      Effect.provideService(RelayFindingPublisher, {
        post: () =>
          Effect.sync(() => {
            calls += 1
            return receipt
          })
      }),
      Effect.provideService(ConfigProvider.ConfigProvider, configured("not-a-boolean"))
    )
    expect(Result.isFailure(result)).toBe(true)
    expect(calls).toBe(0)
  }))

const ownerFixture = (permission: PermissionState, refused: CodeCommitReviewError | null = null) => {
  const checks: Array<string> = []
  const audits: Array<NewAuditLogEntry> = []
  const writes: Array<CodeCommitReviewAction> = []
  const make = makeRelayFindingPublisher().pipe(
    Effect.provideService(PermissionService, {
      check: (operation) =>
        Effect.sync(() => {
          checks.push(operation)
          return permission
        }),
      set: () => Effect.void,
      setCategory: () => Effect.void,
      getAll: () => Effect.succeed({}),
      resetAll: () => Effect.void,
      isAuditEnabled: () => Effect.succeed(true),
      getAuditRetention: () => Effect.succeed(30),
      setAudit: () => Effect.void
    }),
    Effect.provideService(PermissionGate, { request: () => Effect.succeed("allow_once") }),
    Effect.provideService(AuditLogRepo, {
      log: (entry) =>
        Effect.sync(() => {
          audits.push(entry)
        }),
      findAll: () => Effect.succeed({ items: [], total: 0 }),
      prune: () => Effect.succeed(0),
      clearAll: () => Effect.succeed(0),
      exportAll: () => Effect.succeed([])
    }),
    Effect.provideService(CodeCommitReviewClient, {
      execute: (submitted) =>
        Effect.suspend(() => {
          writes.push(submitted)
          return refused === null ? Effect.succeed(receipt) : Effect.fail(refused)
        }),
      preflight: () => Effect.die("Publisher must use the owner execute boundary"),
      reconcile: () => Effect.succeed({ _tag: "pending" })
    })
  )
  return { make, checks, audits, writes }
}

it.effect("post delegates unchanged account profile/region, repo, PR, revision/head/base, finding content/location and prepared token to one permission/audit owner", () =>
  Effect.gen(function*() {
    const owner = ownerFixture("always_allow")
    const publisher = yield* owner.make
    const spike = yield* makeReviewWriteSpike().pipe(
      Effect.provideService(RelayFindingPublisher, publisher),
      Effect.provideService(ConfigProvider.ConfigProvider, configured("true"))
    )
    expectTypeOf(spike.post).parameter(0).extract<{ readonly _tag: "approve" | "merge" }>().toEqualTypeOf<never>()
    expect(yield* spike.post(action)).toEqual(receipt)
    expect(owner.writes).toEqual([action])
    expect(owner.checks).toEqual(["postPullRequestComment"])
    expect(owner.audits).toHaveLength(1)
    expect(owner.audits[0]?.permissionState).toBe("always_allowed")
    expect(owner.audits[0]?.context).toContain("provider succeeded")
  }))

it.effect("rejects oversized or extra command fields before permission, audit or provider execution", () =>
  Effect.gen(function*() {
    const owner = ownerFixture("always_allow")
    const publisher = yield* owner.make
    const spike = yield* makeReviewWriteSpike().pipe(
      Effect.provideService(RelayFindingPublisher, publisher),
      Effect.provideService(ConfigProvider.ConfigProvider, configured("true"))
    )
    const invalid = [
      { ...action, content: "x".repeat(10_101) },
      { ...action, extraAuthority: "must-not-pass" }
    ]
    for (const command of invalid) {
      expect(Result.isFailure(yield* Effect.result(spike.post(command)))).toBe(true)
    }
    expect(owner.checks).toHaveLength(0)
    expect(owner.audits).toHaveLength(0)
    expect(owner.writes).toHaveLength(0)
  }))

it.effect("permission refusal audits once without calling the core writer", () =>
  Effect.gen(function*() {
    const owner = ownerFixture("deny")
    const publisher = yield* owner.make
    const spike = yield* makeReviewWriteSpike().pipe(
      Effect.provideService(RelayFindingPublisher, publisher),
      Effect.provideService(ConfigProvider.ConfigProvider, configured("true"))
    )
    const result = yield* Effect.result(spike.post(action))
    expect(result).toEqual(Result.fail(expect.objectContaining({ _tag: "AwsApiError" })))
    expect(owner.writes).toHaveLength(0)
    expect(owner.checks).toEqual(["postPullRequestComment"])
    expect(owner.audits).toHaveLength(1)
    expect(owner.audits[0]?.permissionState).toBe("denied")
  }))

it.effect("exact-head and prepared-token refusals propagate without retry or token replacement", () =>
  Effect.gen(function*() {
    const failures = [
      new CodeCommitReviewConflictError({ operation: "post-comment", reason: "source-commit-changed" }),
      new AwsApiError({
        operation: "postPullRequestComment",
        profile: action.target.account.profile,
        region: action.target.account.region,
        cause: { _tag: "InvalidClientRequestTokenException" }
      })
    ]
    for (const failure of failures) {
      const owner = ownerFixture("always_allow", failure)
      const publisher = yield* owner.make
      const spike = yield* makeReviewWriteSpike().pipe(
        Effect.provideService(RelayFindingPublisher, publisher),
        Effect.provideService(ConfigProvider.ConfigProvider, configured("true"))
      )
      const result = yield* Effect.result(spike.post(action))
      expect(result).toEqual(Result.fail(failure))
      expect(owner.writes).toEqual([action])
      expect(owner.checks).toHaveLength(1)
      expect(owner.audits).toHaveLength(1)
      expect(owner.audits[0]?.context).toContain("provider failed")
    }
  }))
