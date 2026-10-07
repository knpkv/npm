import { describe, expect, it } from "@effect/vitest"
import { Cause } from "effect"
import { failureStatus } from "../src/server.js"

// The handler used to answer every failure 400 without a trace; a stalled publish is a timeout.
describe("failureStatus", () => {
  it("answers a stalled publish with 408 and any other failure with 400", () => {
    expect(failureStatus(new Cause.TimeoutError())).toBe(408)
    expect(failureStatus({ _tag: "SchemaError" })).toBe(400)
    expect(failureStatus({ _tag: "HttpServerError" })).toBe(400)
  })
})
