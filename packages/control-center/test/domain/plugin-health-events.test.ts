import { describe, expect, it } from "@effect/vitest"
import * as Schema from "effect/Schema"

import { PortfolioInvalidatedPayloadV1 } from "../../src/domain/domainEvent.js"
import { failureStreakStartedAt } from "../../src/domain/freshness.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"

describe("portfolio health invalidations", () => {
  it("retains the health outcome without invalidating legacy events", () => {
    const payload = {
      reason: "plugin-health",
      pluginHealth: { healthState: "unavailable", failureClass: "authentication" }
    }
    expect(Schema.decodeUnknownSync(PortfolioInvalidatedPayloadV1)(payload)).toEqual(payload)
    expect(Schema.decodeUnknownSync(PortfolioInvalidatedPayloadV1)({ reason: "plugin-health" }))
      .toEqual({ reason: "plugin-health" })
  })

  it("keeps the first failure time across repeated failures and clears it at recovery", () => {
    const event = (time: string, healthState: "healthy" | "unavailable") => ({
      occurredAt: Schema.decodeUnknownSync(UtcTimestamp)(time),
      payload: Schema.decodeUnknownSync(PortfolioInvalidatedPayloadV1)({
        reason: "plugin-health",
        pluginHealth: { healthState, failureClass: healthState === "healthy" ? null : "authentication" }
      })
    })
    const events = [
      event("2026-07-14T12:02:00.000Z", "unavailable"),
      event("2026-07-14T12:01:00.000Z", "unavailable"),
      event("2026-07-14T12:00:00.000Z", "healthy")
    ]
    const startedAt = failureStreakStartedAt({ events, isComplete: true })
    expect(startedAt === null ? null : Schema.encodeSync(UtcTimestamp)(startedAt))
      .toBe("2026-07-14T12:01:00.000Z")
    expect(failureStreakStartedAt({
      events: [event("2026-07-14T12:03:00.000Z", "healthy"), ...events],
      isComplete: true
    })).toBeNull()
  })

  it("does not infer a failure start across legacy events or a bounded history cutoff", () => {
    const occurredAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-14T12:01:00.000Z")
    const failed = {
      occurredAt,
      payload: Schema.decodeUnknownSync(PortfolioInvalidatedPayloadV1)({
        reason: "plugin-health",
        pluginHealth: { healthState: "unavailable", failureClass: "authentication" }
      })
    }
    const legacy = {
      occurredAt,
      payload: Schema.decodeUnknownSync(PortfolioInvalidatedPayloadV1)({ reason: "plugin-health" })
    }
    expect(failureStreakStartedAt({ events: [failed, legacy], isComplete: true })).toBeNull()
    expect(failureStreakStartedAt({ events: [failed], isComplete: false })).toBeNull()
    expect(failureStreakStartedAt({ events: [failed], isComplete: true })).toEqual(occurredAt)
  })
})
