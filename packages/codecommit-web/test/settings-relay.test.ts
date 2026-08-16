// @vitest-environment happy-dom

import { describe, expect, it } from "@effect/vitest"
import type { ReviewProfileConfig } from "@knpkv/codecommit-core/ConfigService.js"
import { reviewProfileSkillLimit } from "@knpkv/codecommit-core/ReviewProfile.js"
import * as Schema from "effect/Schema"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import {
  isReviewProfileSkillSelectionDisabled,
  ReviewProfileSkillPicker,
  updateReviewProfileSkills
} from "../src/client/components/settings-relay.js"
import { ReviewSkillResponse } from "../src/server/Api.js"

Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true })

const profileWith = (skillIds: ReadonlyArray<string>): ReviewProfileConfig => ({
  id: "thorough",
  name: "Thorough review",
  kind: "review",
  skillIds
})

describe("Relay review profile skill selection", () => {
  it("accepts only skill ids that a persisted profile can store", () => {
    const skill = { name: "Boundary skill", description: "Boundary fixture", source: "environment" }
    expect(Schema.is(ReviewSkillResponse)({ ...skill, id: "x".repeat(256) })).toBe(true)
    expect(Schema.is(ReviewSkillResponse)({ ...skill, id: "x".repeat(257) })).toBe(false)
  })

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

  it("renders a removed environment skill so a full profile can deselect it", async () => {
    const profile = profileWith([
      "env:plugins:removed",
      ...Array.from({ length: reviewProfileSkillLimit - 1 }, (_, index) => `skill-${String(index + 1)}`)
    ])
    const onSkillChange = vi.fn<(skillId: string, enabled: boolean) => void>()
    const host = document.createElement("div")
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(createElement(ReviewProfileSkillPicker, {
          onSkillChange,
          profile,
          skills: [{ id: "skill-1", name: "Current skill", description: "Still installed", source: "environment" }]
        }))
      )

      const unavailable = Array.from(host.querySelectorAll("label")).find((label) =>
        label.textContent?.includes("env:plugins:removed")
      )
      const checkbox = unavailable?.querySelector<HTMLInputElement>("input")
      expect(unavailable?.textContent).toContain("unavailable")
      expect(checkbox?.checked).toBe(true)
      expect(checkbox?.disabled).toBe(false)
      await act(async () => checkbox?.click())
      expect(onSkillChange).toHaveBeenCalledWith("env:plugins:removed", false)

      const current = Array.from(host.querySelectorAll("label")).find((label) =>
        label.textContent?.includes("Current skill")
      )
      expect(current?.textContent).toContain("Still installed · environment")
    } finally {
      await act(async () => root.unmount())
    }
  })
})
