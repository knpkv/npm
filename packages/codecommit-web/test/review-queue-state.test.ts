import { describe, expect, it } from "@effect/vitest"
import { PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { Schema } from "effect"

import type { FilterEntry } from "../src/client/atoms/ui.js"
import {
  groupQueueFilters,
  isWithinQueueDateBounds,
  matchesQueueFilter,
  openSubStatuses,
  queueFilterOptions,
  resolveQueueFacet,
  resolveQueueMode
} from "../src/client/components/review-queue-state.js"

const pullRequest = Schema.decodeSync(PullRequest)({
  id: "42",
  title: "feat(queue): align account filtering",
  author: "andrey",
  repositoryName: "codecommit-web",
  creationDate: new Date("2026-08-01T00:00:00Z"),
  lastModifiedDate: new Date("2026-08-02T00:00:00Z"),
  link: "https://example.invalid/pull-request/42",
  account: { profile: "production", region: "eu-west-1" },
  status: "OPEN",
  sourceBranch: "feature/queue",
  destinationBranch: "main",
  isMergeable: true,
  isApproved: false,
  approvedBy: [],
  commentedBy: []
})

describe("resolveQueueMode", () => {
  it("shows Review when an old URL contains both review and hot flags", () => {
    expect(resolveQueueMode({ filters: [], hot: true, review: true }, "andrey")).toBe("review")
  })

  it("keeps ordinary updated queues in Hot mode", () => {
    expect(resolveQueueMode({ filters: [], hot: true, review: false }, "andrey")).toBe("hot")
  })

  it("recognizes the current-user author filter as Mine", () => {
    expect(
      resolveQueueMode(
        { filters: [{ key: "author", value: "andrey" }], hot: false, review: false },
        "andrey"
      )
    ).toBe("mine")
  })
})

describe("resolveQueueFacet", () => {
  it("recognizes the composite open-status group as All open", () => {
    expect(
      resolveQueueFacet({
        filters: [...openSubStatuses].map((value) => ({ key: "status", value })),
        review: false
      })
    ).toBe("open")
  })

  it("recognizes one exact summary status while ignoring unrelated filters", () => {
    expect(
      resolveQueueFacet({
        filters: [
          { key: "account", value: "production" },
          { key: "status", value: "approved" },
          { key: "status", value: "stale" }
        ],
        review: false
      })
    ).toBe("approved")
  })

  it("does not claim a summary facet for ambiguous status mixtures", () => {
    expect(
      resolveQueueFacet({
        filters: [
          { key: "status", value: "approved" },
          { key: "status", value: "pending" }
        ],
        review: false
      })
    ).toBeUndefined()
    expect(
      resolveQueueFacet({
        filters: [
          { key: "status", value: "approved" },
          { key: "status", value: "merged" }
        ],
        review: false
      })
    ).toBeUndefined()
    expect(
      resolveQueueFacet({
        filters: [
          { key: "status", value: "open" },
          { key: "status", value: "closed" }
        ],
        review: false
      })
    ).toBeUndefined()
  })
})

describe("isWithinQueueDateBounds", () => {
  it("applies one-sided bounds independently", () => {
    const timestamp = Date.UTC(2026, 0, 15)
    expect(isWithinQueueDateBounds(timestamp, Date.UTC(2026, 0, 1), undefined)).toBe(true)
    expect(isWithinQueueDateBounds(timestamp, Date.UTC(2026, 1, 1), undefined)).toBe(false)
    expect(isWithinQueueDateBounds(timestamp, undefined, Date.UTC(2026, 1, 1))).toBe(true)
    expect(isWithinQueueDateBounds(timestamp, undefined, Date.UTC(2026, 0, 1))).toBe(false)
  })

  it("ignores malformed URL bounds", () => {
    expect(isWithinQueueDateBounds(Date.UTC(2026, 0, 15), Number.NaN, Number.NaN)).toBe(true)
  })
})

describe("shared queue filter contract", () => {
  it("matches every account option that it exposes", () => {
    const options = queueFilterOptions([pullRequest]).account
    expect(options).toEqual(["production"])
    expect(options.every((value) => matchesQueueFilter(pullRequest, { key: "account", value }))).toBe(true)
  })

  it("does not invent an unknown account outside the decoded domain", () => {
    expect(queueFilterOptions([pullRequest]).account).not.toContain("unknown")
    expect(matchesQueueFilter(pullRequest, { key: "account", value: "unknown" })).toBe(false)
  })
})

describe("approval filters with no approval rules", () => {
  // A pull request without rules is its own approval status: filterable, and kept by the composite
  // All open group instead of falling out of the approval axis.
  it("matches status not-required, and stays in the composite All open group", () => {
    const noRules = Schema.decodeSync(PullRequest)({
      ...Schema.encodeSync(PullRequest)(pullRequest),
      isApproved: true,
      approvalRules: []
    })
    expect(matchesQueueFilter(noRules, { key: "status", value: "not-required" })).toBe(true)
    expect(matchesQueueFilter(noRules, { key: "status", value: "approved" })).toBe(false)
    expect(queueFilterOptions([noRules]).status).toContain("not-required")
    const allOpen = [...openSubStatuses].map((value): FilterEntry => ({ key: "status", value }))
    expect(resolveQueueFacet({ filters: allOpen, review: false })).toBe("open")
    expect(
      [...groupQueueFilters(allOpen).values()].every((group) =>
        group.some((entry) => matchesQueueFilter(noRules, entry))
      )
    ).toBe(true)
  })
})

describe("approval filters with an unknown approval", () => {
  it("lists an unknown approval as neither approved nor pending", () => {
    const unknown = Schema.decodeSync(PullRequest)({
      ...Schema.encodeSync(PullRequest)(pullRequest),
      isApproved: true,
      approvalUnknown: { _tag: "NotPermitted" }
    })
    expect(matchesQueueFilter(unknown, { key: "status", value: "approved" })).toBe(false)
    expect(matchesQueueFilter(unknown, { key: "status", value: "pending" })).toBe(false)
  })

  // An unknown approval is its own status, so it can be filtered for, and the composite "All open"
  // (every open sub-status) still includes it rather than dropping it from the approval axis.
  it("matches status unknown, and stays in the composite All open group", () => {
    const unknown = Schema.decodeSync(PullRequest)({
      ...Schema.encodeSync(PullRequest)(pullRequest),
      isApproved: true,
      approvalUnknown: { _tag: "NotPermitted" }
    })
    expect(matchesQueueFilter(unknown, { key: "status", value: "unknown" })).toBe(true)
    expect(matchesQueueFilter(pullRequest, { key: "status", value: "unknown" })).toBe(false)
    expect(queueFilterOptions([unknown]).status).toContain("unknown")
    const allOpen = [...openSubStatuses].map((value): FilterEntry => ({ key: "status", value }))
    expect(resolveQueueFacet({ filters: allOpen, review: false })).toBe("open")
    const listed = [...groupQueueFilters(allOpen).values()].every((group) =>
      group.some((entry) => matchesQueueFilter(unknown, entry))
    )
    expect(listed).toBe(true)
  })
})
