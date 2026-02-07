import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect } from "effect"
import { AwsApiError, AwsCredentialError, ConfigError } from "../src/Errors.js"

describe("Errors", () => {
  // TaggedErrors must be yieldable in Effect.gen without Effect.fail()
  it.effect("AwsApiError is yieldable and has correct tag", () =>
    Effect.gen(function*() {
      const result = yield* Effect.flip(
        Effect.gen(function*() {
          return yield* new AwsApiError({ operation: "getPR", profile: "dev", region: "us-east-1", cause: "boom" })
        })
      )
      expect(result._tag).toBe("AwsApiError")
      expect(result.operation).toBe("getPR")
    }))

  // catchTag must match on _tag for pattern-based error handling
  it.effect("AwsCredentialError is catchable by tag", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        return yield* new AwsCredentialError({ profile: "dev", region: "us-east-1", cause: "expired" })
      }).pipe(
        Effect.catchTag("AwsCredentialError", (e) => Effect.succeed(`caught: ${e.profile}`))
      )
      const result = yield* program
      expect(result).toBe("caught: dev")
    }))

  // ConfigError optional cause field must work when absent
  it.effect("ConfigError works with optional cause", () =>
    Effect.gen(function*() {
      const result = yield* Effect.flip(
        Effect.gen(function*() {
          return yield* new ConfigError({ message: "not found" })
        })
      )
      expect(result._tag).toBe("ConfigError")
      expect(result.message).toBe("not found")
    }))

  // Errors must integrate with Cause for structured failure reporting
  it("errors render in Cause.pretty", () => {
    const error = new AwsApiError({ operation: "listPRs", profile: "prod", region: "eu-west-1", cause: "timeout" })
    const cause = Cause.fail(error)
    const pretty = Cause.pretty(cause)
    expect(pretty).toContain("AwsApiError")
  })
})
