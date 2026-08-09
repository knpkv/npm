import { describe, expect, it } from "@effect/vitest"
import { isAwsAuthenticationNotification } from "../src/tui/notification-auth.js"

describe("isAwsAuthenticationNotification", () => {
  it("recognizes the session-expiry message emitted by PR refresh", () => {
    expect(isAwsAuthenticationNotification("Failed to get caller identity — session may have expired")).toBe(true)
  })

  it("does not offer login for an unrelated provider failure", () => {
    expect(isAwsAuthenticationNotification("Failed to list pull requests: repository unavailable")).toBe(false)
  })
})
