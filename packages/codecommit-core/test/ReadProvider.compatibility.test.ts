import { NodeHttpClient } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import * as AwsRetry from "distilled-aws/Retry"
import { Effect, Layer, Result, Schema } from "effect"
import * as Ref from "effect/Ref"

import * as AwsClientConfig from "../src/AwsClientConfig.js"
import { AwsProfileName, AwsRegion } from "../src/Domain.js"
import { AwsCredentialError } from "../src/Errors.js"
import { CodeCommitReadClient } from "../src/ReadClient/ReadClient.js"

const liveReadClient = CodeCommitReadClient.live.pipe(
  Layer.provide([AwsClientConfig.Default, NodeHttpClient.layerFetch])
)

describe("CodeCommitReadProvider compatibility", () => {
  it.effect("constructs the distilled AWS retry policy with the pinned Effect version", () =>
    Effect.gen(function*() {
      const lastError = yield* Ref.make<unknown>(undefined)
      const policy = AwsRetry.makeDefault(lastError)

      assert.isDefined(policy.schedule)
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
