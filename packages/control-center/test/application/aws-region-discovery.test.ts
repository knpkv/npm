import { assert, describe, it } from "@effect/vitest"
import { codeCommitMockAwsClientConfig } from "@knpkv/codecommit-core/MockTransport.js"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
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
  classifyRegionReadCause,
  decodeEnabledRegions,
  makeAwsRegionDiscovery
} from "../../src/server/application/awsRegionDiscovery.js"
import { awsResourceDiscoveryLayerWithCodeCommitHttpClient } from "../../src/server/application/awsResourceDiscovery.js"

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
        assert.deepStrictEqual(regions, { _tag: "available", regions: ["eu-central-1", "eu-west-1", "us-east-1"] })
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

  // account:ListRegions is a new IAM action; a profile without it is a fact for the form, not an outage.
  it.effect("reports a profile that may not list regions as denied, not unavailable", () =>
    run(
      () => Effect.fail(new AwsRegionReadFailure({ reason: "denied" })),
      Effect.gen(function*() {
        const discovery = yield* AwsRegionDiscovery
        assert.deepStrictEqual(yield* discovery.regions("production"), { _tag: "denied" })
      })
    ))

  it("classifies provider causes without keeping them", () => {
    assert.strictEqual(classifyRegionReadCause({ _tag: "AccessDeniedException", message: "x" }).reason, "denied")
    assert.strictEqual(classifyRegionReadCause({ name: "UnauthorizedException" }).reason, "denied")
    assert.strictEqual(classifyRegionReadCause({ _tag: "ThrottlingException" }).reason, "throttled")
    assert.strictEqual(classifyRegionReadCause({ _tag: "CredentialsProviderError" }).reason, "sign-in")
    assert.strictEqual(classifyRegionReadCause({ _tag: "InternalFailure" }).reason, "unavailable")
  })

  it.effect("decodes region names and refuses a malformed or overlong list instead of trimming it", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(yield* decodeEnabledRegions(["eu-west-1", "us-east-1"]), ["eu-west-1", "us-east-1"])
      const malformed = yield* Effect.flip(decodeEnabledRegions(["eu-west-1", "not a region"]))
      assert.strictEqual(malformed.reason, "unavailable")
      const overlong = yield* Effect.flip(
        decodeEnabledRegions(Array.from({ length: 65 }, (_, index) => `eu-west-${index}`))
      )
      assert.strictEqual(overlong.reason, "unavailable")
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

  // The injected-transport composition is the deterministic (mock) runtime: no host profile, no public Account API.
  it.effect("is absent from the injected-transport composition, so mock mode never reads a host profile", () =>
    Effect.gen(function*() {
      const requests: Array<string> = []
      const transport = HttpClient.make((request) => {
        requests.push(request.url)
        return Effect.die("region discovery used the injected transport")
      })
      const context = yield* Layer.build(
        awsResourceDiscoveryLayerWithCodeCommitHttpClient(transport, codeCommitMockAwsClientConfig).pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, transport))
        )
      )
      assert.isTrue(Option.isNone(Context.getOption(context, AwsRegionDiscovery)))
      assert.deepStrictEqual(requests, [])
    }).pipe(Effect.scoped))
})
