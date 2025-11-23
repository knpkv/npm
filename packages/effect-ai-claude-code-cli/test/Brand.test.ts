/**
 * Tests for branded types.
 */

import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Brand from "../src/Brand.js"

describe("SessionId", () => {
  it("should accept valid UUID v4", () => {
    const valid = "631f187f-fd79-41d9-9cae-cb255c96acfd"
    const result = Schema.decodeSync(Brand.SessionIdSchema)(valid)
    expect(result).toBe(valid)
  })

  it("should accept valid UUID v4 with uppercase", () => {
    const valid = "631F187F-FD79-41D9-9CAE-CB255C96ACFD"
    const result = Schema.decodeSync(Brand.SessionIdSchema)(valid)
    // UUID validation accepts uppercase
    expect(result).toBe(valid)
  })

  it("should reject invalid format (not a UUID)", () => {
    expect(() => {
      Schema.decodeSync(Brand.SessionIdSchema)("not-a-uuid")
    }).toThrow()
  })

  it("should reject empty string", () => {
    expect(() => {
      Schema.decodeSync(Brand.SessionIdSchema)("")
    }).toThrow()
  })

  it("should accept UUID with any version", () => {
    const uuid_v1 = "550e8400-e29b-11d4-a716-446655440000"
    const result = Schema.decodeSync(Brand.SessionIdSchema)(uuid_v1)
    // Schema.UUID accepts all UUID versions
    expect(result).toBe(uuid_v1)
  })

  it("should reject malformed UUID", () => {
    const malformed = "631f187f-fd79-41d9-9cae-cb255c96acf"
    expect(() => {
      Schema.decodeSync(Brand.SessionIdSchema)(malformed)
    }).toThrow()
  })

  it("should reject UUID with extra characters", () => {
    const extra = "631f187f-fd79-41d9-9cae-cb255c96acfd-extra"
    expect(() => {
      Schema.decodeSync(Brand.SessionIdSchema)(extra)
    }).toThrow()
  })

  it("should work with unsafe constructor", () => {
    const sessionId = Brand.unsafeSessionId("test-id")
    expect(sessionId).toBe("test-id")
  })

  it("should work with Brand.refined for valid UUID", () => {
    const valid = "631f187f-fd79-41d9-9cae-cb255c96acfd"
    const result = Brand.SessionId(valid)
    expect(result).toBe(valid)
  })
})
