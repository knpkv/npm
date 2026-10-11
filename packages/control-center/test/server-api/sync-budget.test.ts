import { assert, describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import { PluginConnectionId, WorkspaceId } from "../../src/domain/identifiers.js"
import {
  consumeManualSynchronizationTokens,
  consumeRequestToken,
  RequestLimitPolicy,
  requestRateLimiterLayer
} from "../../src/server/api/RequestLimits.js"

const workspaceId = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000001")
const connectionId = (index: number) =>
  PluginConnectionId.make(
    `01890f6f-6d6a-7cc0-98d2-${String(index).padStart(12, "0")}`
  )
const peer = "peer:127.0.0.1"
const manual = (index: number) =>
  consumeManualSynchronizationTokens({
    workspaceId,
    pluginConnectionId: connectionId(index),
    peer
  })

describe("resolved synchronization budgets", () => {
  it.effect("allows ten connections to synchronize once without sharing their connection budget", () =>
    Effect.gen(function*() {
      for (let index = 1; index <= 10; index++) yield* manual(index)
    }).pipe(Effect.provide([RequestLimitPolicy.defaultLayer, requestRateLimiterLayer])))

  it.effect("rejects a third attempt on one connection with its retry delay", () =>
    Effect.gen(function*() {
      yield* manual(1)
      yield* manual(1)
      const result = yield* manual(1).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.deepInclude(result.failure, {
          _tag: "RequestRateLimitExceeded",
          budget: "per-connection",
          retryAfterSeconds: 30
        })
      }
      yield* manual(2)
    }).pipe(Effect.provide([RequestLimitPolicy.defaultLayer, requestRateLimiterLayer])))

  it.effect("enforces the manual global cap across distinct connections", () =>
    Effect.gen(function*() {
      for (let index = 1; index <= 60; index++) yield* manual(index)
      const result = yield* manual(61).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.deepInclude(result.failure, {
          _tag: "RequestRateLimitExceeded",
          budget: "global",
          retryAfterSeconds: 1
        })
      }
      yield* consumeManualSynchronizationTokens({
        workspaceId,
        pluginConnectionId: connectionId(62),
        peer: "peer:192.0.2.1"
      })
    }).pipe(Effect.provide([RequestLimitPolicy.defaultLayer, requestRateLimiterLayer])))

  it.effect("keeps onboarding independent of both manual budgets", () =>
    Effect.gen(function*() {
      for (let index = 1; index <= 60; index++) yield* consumeRequestToken("sync-onboarding", workspaceId)
      const result = yield* consumeRequestToken("sync-onboarding", workspaceId).pipe(Effect.result)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "RequestRateLimitExceeded")
      yield* manual(1)
      yield* manual(1)
      for (let index = 2; index <= 59; index++) yield* manual(index)
    }).pipe(Effect.provide([RequestLimitPolicy.defaultLayer, requestRateLimiterLayer])))
})
