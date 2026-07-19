import { categoriesKey, retryableKey, ServerError, ThrottlingError } from "@distilled.cloud/aws/Category"
import * as AwsRetry from "@distilled.cloud/aws/Retry"
import { NodeHttpClient } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer, Result, Schedule, Schema } from "effect"
import * as Ref from "effect/Ref"
import { TestClock } from "effect/testing"

import * as AwsClientConfig from "../src/AwsClientConfig.js"
import { AwsProfileName, AwsRegion } from "../src/Domain.js"
import { AwsCredentialError } from "../src/Errors.js"
import { CodeCommitReadClient } from "../src/ReadClient/ReadClient.js"

const liveReadClient = CodeCommitReadClient.live.pipe(
  Layer.provide([AwsClientConfig.Default, NodeHttpClient.layerFetch])
)

describe("CodeCommitReadProvider compatibility", () => {
  it.effect("preserves distilled AWS retry delays with the pinned Effect version", () =>
    Effect.gen(function*() {
      const firstDelay = Effect.fn("ReadProviderCompatibility.firstDelay")(function*(error: unknown) {
        const lastError = yield* Ref.make(error)
        const step = yield* Schedule.toStepWithMetadata(AwsRetry.makeDefault(lastError).schedule)
        const next = yield* step(error).pipe(Effect.forkChild)
        yield* TestClock.adjust(Duration.seconds(3))
        return Duration.toMillis((yield* Fiber.join(next)).duration)
      })

      const transientDelay = yield* firstDelay({
        [categoriesKey]: { [ServerError]: true }
      })
      const throttlingDelay = yield* firstDelay({
        [categoriesKey]: { [ThrottlingError]: true }
      })
      const retryAfterDelay = yield* firstDelay({
        [retryableKey]: {},
        retryAfterSeconds: 2
      })

      assert.isAtLeast(transientDelay, 100)
      assert.isBelow(transientDelay, 150)
      assert.isAtLeast(throttlingDelay, 500)
      assert.isBelow(throttlingDelay, 550)
      assert.isAtLeast(retryAfterDelay, 2_000)
      assert.isBelow(retryAfterDelay, 2_050)
    }))

  it.effect("preserves missing AWS credentials as a typed failure", () =>
    Effect.gen(function*() {
      const client = yield* CodeCommitReadClient
      const result = yield* client.discoverAccount({
        profile: Schema.decodeUnknownSync(AwsProfileName)("control-center-definitely-missing-profile"),
        region: Schema.decodeUnknownSync(AwsRegion)("eu-central-1")
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, AwsCredentialError)
    }).pipe(Effect.provide(liveReadClient)))
})
