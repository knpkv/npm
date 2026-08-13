import { describe, expect, it } from "@effect/vitest"

import {
  pullRequestRowDecision,
  pullRequestRowTimeLabel,
  pullRequestRowTimestamp
} from "../src/client/components/pr-row-presentation.js"

describe("pull request row presentation", () => {
  it("uses neutral actions for terminal pull requests regardless of stale mergeability", () => {
    expect(pullRequestRowDecision({ approvedBy: [], isMergeable: false, status: "CLOSED" })).toEqual({
      actionLabel: "View pull request",
      summary: "Closed"
    })
    expect(pullRequestRowDecision({ approvedBy: [], isMergeable: false, status: "MERGED" })).toEqual({
      actionLabel: "View pull request",
      summary: "Merged"
    })
  })

  it("keeps conflict language for an open non-mergeable pull request", () => {
    expect(pullRequestRowDecision({ approvedBy: [], isMergeable: false, status: "OPEN" })).toEqual({
      actionLabel: "Inspect conflict",
      summary: "Merge blocked"
    })
  })

  it("matches the machine timestamp to the visible event", () => {
    const creationDate = new Date("2026-08-01T09:00:00.000Z")
    const lastModifiedDate = new Date("2026-08-11T17:30:00.000Z")
    const pr = { creationDate, lastModifiedDate }

    expect(pullRequestRowTimestamp(pr, true)).toBe(lastModifiedDate)
    expect(pullRequestRowTimestamp(pr, false)).toBe(creationDate)
    expect(pullRequestRowTimeLabel(pr, true, new Date("2026-08-11T18:30:00.000Z"))).toBe("Updated 1h ago")
    expect(pullRequestRowTimeLabel(pr, false, new Date("2026-08-11T18:30:00.000Z"))).toBe(
      "Opened 01.08.2026"
    )
  })
})
