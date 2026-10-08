/** A failed dashboard refresh keeps the last good snapshot instead of replacing the hub (QA-130). */
import { describe, expect, it } from "@effect/vitest"
import { Cause, Option } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { dashboardRefreshTime, dashboardRefreshView } from "../src/internal/dashboard-refresh.js"

const bootstrap = { observedAt: 1_000, label: "served with the page" }
const later = { observedAt: 2_000, label: "a later refresh" }

describe("dashboard refresh view", () => {
  it("shows a successful refresh as current", () => {
    expect(dashboardRefreshView(AsyncResult.success(later), bootstrap)).toEqual({
      refreshFailed: false,
      snapshot: later
    })
  })

  it("keeps the served snapshot when the very first refresh fails", () => {
    // The atom has no success of its own yet, so the failure carries no previous one.
    const failed = AsyncResult.failure<typeof bootstrap, string>(Cause.fail("503"))
    expect(dashboardRefreshView(failed, bootstrap)).toEqual({ refreshFailed: true, snapshot: bootstrap })
  })

  it("keeps the last successful refresh when a later one fails", () => {
    const failed = AsyncResult.failureWithPrevious<typeof later, string>(Cause.fail("503"), {
      previous: Option.some(AsyncResult.success(later))
    })
    expect(dashboardRefreshView(failed, bootstrap)).toEqual({ refreshFailed: true, snapshot: later })
  })

  it("shows the served snapshot before any refresh has answered", () => {
    expect(dashboardRefreshView(AsyncResult.initial(true), bootstrap)).toEqual({
      refreshFailed: false,
      snapshot: bootstrap
    })
  })

  it("writes the kept snapshot's time like the rest of the hub", () => {
    expect(dashboardRefreshTime(Date.UTC(2026, 9, 7, 9, 5))).toMatch(/^\d{2}:\d{2}$/)
  })
})
