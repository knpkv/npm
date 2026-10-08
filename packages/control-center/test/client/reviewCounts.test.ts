import { describe, expect, it } from "vitest"

import { reviewCountsLabel } from "../../src/client/entities/reviewCounts.js"

describe("reviewCountsLabel", () => {
  it("names zero, one and many in words people read", () => {
    expect(reviewCountsLabel(0, 0)).toBe("0 suggestions · 0 notes")
    expect(reviewCountsLabel(1, 1)).toBe("1 suggestion · 1 note")
    expect(reviewCountsLabel(2, 2)).toBe("2 suggestions · 2 notes")
  })
})
