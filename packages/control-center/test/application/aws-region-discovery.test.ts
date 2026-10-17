import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"

import {
  ApplicationAwsSignInRequired,
  ApplicationInvalidRequest,
  ApplicationRateLimited,
  ApplicationServiceUnavailable
} from "../../src/server/api/ApplicationServices.js"
import {
  AwsRegionDiscovery,
  AwsRegionReader,
  AwsRegionReadFailure,
  makeAwsRegionDiscovery
} from "../../src/server/application/awsRegionDiscovery.js"

const run = <A, E>(
  enabledRegions: AwsRegionReader["Service"]["enabledRegions"],
  effect: Effect.Effect<A, E, AwsRegionDiscovery>
) =>
  Effect.flatMap(
    makeAwsRegionDiscovery().pipe(Effect.provideService(AwsRegionReader, { enabledRegions })),
    (discovery) => effect.pipe(Effect.provideService(AwsRegionDiscovery, discovery))
  )

describe("AWS region discovery", () => {
  it.effect("lists the profile's enabled regions, sorted and without repeats", () =>
    run(
      () => Effect.succeed(["us-east-1", "eu-west-1", "eu-central-1", "eu-west-1"]),
      Effect.gen(function*() {
        const discovery = yield* AwsRegionDiscovery
        const regions = yield* discovery.regions("production")
        assert.deepStrictEqual(regions, ["eu-central-1", "eu-west-1", "us-east-1"])
      })
    ))

  it.effect("asks for a fresh sign-in when the profile's credentials are refused", () =>
    run(
      () => Effect.fail(new AwsRegionReadFailure({ reason: "sign-in" })),
      Effect.gen(function*() {
        const discovery = yield* AwsRegionDiscovery
        const result = yield* Effect.result(discovery.regions("production"))
        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) assert.instanceOf(result.failure, ApplicationAwsSignInRequired)
      })
    ))

  it.effect("reports throttling as rate limited and anything else as unavailable", () =>
    Effect.gen(function*() {
      const throttled = yield* run(
        () => Effect.fail(new AwsRegionReadFailure({ reason: "throttled" })),
        Effect.flatMap(AwsRegionDiscovery, (discovery) => Effect.flip(discovery.regions("production")))
      )
      assert.instanceOf(throttled, ApplicationRateLimited)
      const unavailable = yield* run(
        () => Effect.fail(new AwsRegionReadFailure({ reason: "unavailable" })),
        Effect.flatMap(AwsRegionDiscovery, (discovery) => Effect.flip(discovery.regions("production")))
      )
      assert.instanceOf(unavailable, ApplicationServiceUnavailable)
    }))

  it.effect("refuses a malformed profile name before asking AWS", () => {
    let calls = 0
    return run(
      () =>
        Effect.sync((): ReadonlyArray<string> => {
          calls += 1
          return []
        }),
      Effect.gen(function*() {
        const discovery = yield* AwsRegionDiscovery
        const failure = yield* Effect.flip(discovery.regions(" "))
        assert.instanceOf(failure, ApplicationInvalidRequest)
        assert.strictEqual(calls, 0)
      })
    )
  })
})
