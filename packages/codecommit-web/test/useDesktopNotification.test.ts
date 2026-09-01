import { describe, expect, it } from "@effect/vitest"
import { desktopNotificationPath } from "../src/client/hooks/useDesktopNotification.js"

describe("desktop notification navigation", () => {
  it("retains the legacy PR route when coordinates are absent", () => {
    expect(desktopNotificationPath({ awsAccountId: "123", pullRequestId: "42" }))
      .toBe("/accounts/123/prs/42")
  })

  it("uses the exact route when all coordinates are present", () => {
    expect(desktopNotificationPath({
      awsAccountId: "123",
      pullRequestId: "42",
      repositoryName: "payments",
      accountRegion: "eu-west-1"
    })).toBe("/accounts/123/prs/42?repository=payments&region=eu-west-1")
  })

  it("falls back to notifications without PR identity", () => {
    expect(desktopNotificationPath({})).toBe("/notifications")
  })
})
