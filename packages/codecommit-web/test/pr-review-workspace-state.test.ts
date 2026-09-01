import { describe, expect, it } from "@effect/vitest"

import { resolveRelayReviewProfile } from "../src/client/components/pr-review-workspace.js"

const profiles = [
  { id: "thorough", label: "Thorough" },
  { id: "security", label: "Security" }
]

describe("Relay review profile selection", () => {
  it("uses the default only before an explicit selection exists", () => {
    expect(resolveRelayReviewProfile(profiles, null, profiles[0])).toEqual(profiles[0])
    expect(resolveRelayReviewProfile(profiles, "security", profiles[0])).toEqual(profiles[1])
    expect(resolveRelayReviewProfile(profiles, "removed", profiles[0])).toBeUndefined()
  })
})
