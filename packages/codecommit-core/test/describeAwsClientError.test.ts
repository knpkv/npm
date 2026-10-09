import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { AwsProfileName, AwsRegion } from "../src/Domain.js"
import {
  AwsApiError,
  AwsCredentialError,
  AwsThrottleError,
  describeAwsClientError,
  PermissionDeniedError
} from "../src/Errors.js"

const at = { profile: Schema.decodeSync(AwsProfileName)("dev"), region: Schema.decodeSync(AwsRegion)("eu-central-1") }

const providerError = (name: string, message: string) => Object.assign(new Error(message), { name })

describe("describeAwsClientError", () => {
  it("names the provider's error, not the wrapper's tag", () => {
    const error = new AwsApiError({
      ...at,
      cause: providerError("UnrecognizedClientException", "The security token included in the request is invalid."),
      operation: "getPullRequests"
    })
    expect(describeAwsClientError(error)).toBe(
      "UnrecognizedClientException: The security token included in the request is invalid."
    )
  })

  it("says credentials or throttling first", () => {
    expect(
      describeAwsClientError(
        new AwsCredentialError({ ...at, cause: providerError("CredentialsProviderError", "Token expired") })
      )
    ).toBe("Credentials unavailable: CredentialsProviderError: Token expired")
    expect(
      describeAwsClientError(
        new AwsThrottleError({ cause: new Error("Rate exceeded"), operation: "getPullRequests", retryCount: 3 })
      )
    ).toBe(
      "Throttled: Rate exceeded"
    )
  })

  it("never returns an empty description", () => {
    expect(describeAwsClientError(new AwsApiError({ ...at, cause: "", operation: "getPullRequests" }))).toBe(
      "no detail from the provider"
    )
  })

  // QA-169: the permission gate's refusal read "PermissionDeniedError:" — a tag and an empty message.
  it("says a held or denied permission in words", () => {
    const gated = (reason: "denied" | "timeout") =>
      new AwsApiError({
        ...at,
        cause: new PermissionDeniedError({ operation: "getPullRequests", reason }),
        operation: "getPullRequests"
      })
    expect(describeAwsClientError(gated("denied"))).toBe("Not allowed: the getPullRequests permission is denied")
    expect(describeAwsClientError(gated("timeout"))).toBe(
      "Not allowed yet: the getPullRequests permission prompt has no answer"
    )
  })

  it("names a provider error with no message without a dangling colon", () => {
    const error = new AwsApiError({
      ...at,
      cause: providerError("ServiceUnavailable", ""),
      operation: "getPullRequests"
    })
    expect(describeAwsClientError(error)).toBe("ServiceUnavailable")
  })
})
