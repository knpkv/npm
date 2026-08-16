import { describe, expect, it } from "@effect/vitest"
import type { ReviewProfileConfig } from "@knpkv/codecommit-core/ConfigService.js"
import { reviewProfileSkillLimit } from "@knpkv/codecommit-core/ReviewProfile.js"
import {
  isReviewProfileSkillSelectionDisabled,
  updateReviewProfileSkills
} from "../src/client/components/settings-relay.js"

const profileWith = (skillIds: ReadonlyArray<string>): ReviewProfileConfig => ({
  id: "thorough",
  name: "Thorough review",
  kind: "review",
  skillIds
})

describe("Relay review profile skill selection", () => {
  it("keeps the editor payload within the persisted skill limit", () => {
    const selected = Array.from({ length: reviewProfileSkillLimit }, (_, index) => `skill-${String(index + 1)}`)
    const full = profileWith(selected)

    expect(isReviewProfileSkillSelectionDisabled(full, "skill-25")).toBe(true)
    expect(isReviewProfileSkillSelectionDisabled(full, "skill-1")).toBe(false)
    expect(updateReviewProfileSkills(full, "skill-25", true)).toBe(full)

    const withRoom = updateReviewProfileSkills(full, "skill-1", false)
    expect(withRoom.skillIds).toHaveLength(reviewProfileSkillLimit - 1)
    expect(isReviewProfileSkillSelectionDisabled(withRoom, "skill-25")).toBe(false)
    expect(updateReviewProfileSkills(withRoom, "skill-25", true).skillIds).toEqual([...selected.slice(1), "skill-25"])
  })
})
