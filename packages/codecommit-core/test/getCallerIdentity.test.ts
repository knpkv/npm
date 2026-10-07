import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { getCallerIdentity } from "../src/AwsClient/getCallerIdentity.js"
import { AwsProfileName, AwsRegion } from "../src/Domain.js"
import { codeCommitMockAwsClientConfig } from "../src/MockTransport.js"

const account = {
  profile: Schema.decodeSync(AwsProfileName)("dev"),
  region: Schema.decodeSync(AwsRegion)("eu-west-1")
}

/** STS answering GetCallerIdentity at its XML query protocol with the given result fields. */
const sts = (result: string) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(
        request,
        new Response(
          `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult>${result}</GetCallerIdentityResult><ResponseMetadata><RequestId>r</RequestId></ResponseMetadata></GetCallerIdentityResponse>`,
          { status: 200, headers: { "content-type": "text/xml" } }
        )
      ))
    )
  ).pipe(Layer.merge(codeCommitMockAwsClientConfig))

describe("getCallerIdentity", () => {
  it.layer(sts("<Account>123456789012</Account><Arn>arn:aws:sts::123456789012:assumed-role/R/alice</Arn>"))((it) => {
    it.effect("resolves an identity with its account and ARN", () =>
      Effect.gen(function*() {
        expect(yield* getCallerIdentity(account)).toEqual({
          accountId: "123456789012",
          arn: "arn:aws:sts::123456789012:assumed-role/R/alice",
          username: "alice"
        })
      }))
  })

  it.layer(sts("<Account>123456789012</Account>"))((it) => {
    it.effect("fails rather than resolving an identity without an ARN", () =>
      Effect.gen(function*() {
        const exit = yield* Effect.exit(getCallerIdentity(account))
        expect(exit.pipe(Exit.findErrorOption)).toMatchObject({ value: { _tag: "AwsApiError" } })
      }))
  })
})
