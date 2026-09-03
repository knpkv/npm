import { describe, expect, it } from "@effect/vitest"
import { decodeWorkNavigationSelection, workNavigationHref } from "../src/navigation.js"

describe("Work navigation", () => {
  it("builds the canonical same-origin goal URL", () => {
    expect(workNavigationHref({ goalId: "goal-review", window: "now" })).toBe(
      "/?tab=work&window=now&goal=goal-review"
    )
  })

  it("decodes a goal and snapshot window without accepting malformed values", () => {
    expect(decodeWorkNavigationSelection("?tab=work&window=week&goal=goal-review")).toEqual({
      goalId: "goal-review",
      window: "week"
    })
    expect(decodeWorkNavigationSelection("?tab=work&window=invalid&goal=")).toEqual({
      goalId: null,
      window: "now"
    })
  })
})
