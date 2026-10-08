import { describe, expect, it } from "@effect/vitest"
import { waitingReadsText } from "../src/client/components/permission-bar.js"

describe("waitingReadsText", () => {
  it("says nothing extra for a single waiting read", () => {
    expect(waitingReadsText({ contexts: ["Get identity for dev"], count: 1 })).toBeNull()
  })

  it("names every waiting read when there are up to three", () => {
    expect(waitingReadsText({ contexts: ["Get identity for dev", "List PRs for dev"], count: 2 })).toBe(
      "2 reads are waiting: Get identity for dev and List PRs for dev."
    )
    expect(waitingReadsText({ contexts: ["A", "B", "C"], count: 3 })).toBe("3 reads are waiting: A, B and C.")
  })

  it("names three, then says how many more", () => {
    expect(waitingReadsText({ contexts: ["A", "B", "C"], count: 5 })).toBe("5 reads are waiting: A, B, C and 2 more.")
  })
})
