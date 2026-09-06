import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { WorkGoalId } from "../src/model.js"
import {
  decodeWorkBoardNavigationGoal,
  decodeWorkNavigationSelection,
  encodeWorkBoardNavigationGoal,
  workNavigationHref
} from "../src/navigation.js"

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

  it("round-trips bounded board state through the existing goal navigation slot", () => {
    const encoded = encodeWorkBoardNavigationGoal({
      detailsOpen: true,
      goalId: "goal-review",
      statusFilter: "blocked",
      visibleGoalCount: 20
    })

    expect(decodeWorkBoardNavigationGoal(encoded)).toEqual({
      detailsOpen: true,
      goalId: "goal-review",
      statusFilter: "blocked",
      visibleGoalCount: 20
    })
    expect(decodeWorkNavigationSelection(workNavigationHref({ goalId: encoded, window: "week" }).slice(1))).toEqual({
      goalId: encoded,
      window: "week"
    })
    expect(decodeWorkBoardNavigationGoal("goal-review")).toBeNull()
  })

  it("rejects malformed reserved board-navigation goals", () => {
    const malformed = encodeWorkBoardNavigationGoal({
      detailsOpen: true,
      goalId: null,
      statusFilter: "blocked",
      visibleGoalCount: 10
    }).replace("status=blocked", "status=unknown")
    expect(
      decodeWorkNavigationSelection(workNavigationHref({ goalId: malformed, window: "now" }).slice(1))
    ).toEqual({ goalId: null, window: "now" })
  })

  it("does not reserve valid goal IDs that resemble the board token", () => {
    const goalId = "__work_board_v1__real-goal"
    expect(decodeWorkNavigationSelection(workNavigationHref({ goalId, window: "now" }).slice(1))).toEqual({
      goalId,
      window: "now"
    })
  })

  it("keeps the board token namespace outside the WorkGoalId contract", () => {
    const encoded = encodeWorkBoardNavigationGoal({
      detailsOpen: false,
      goalId: null,
      statusFilter: "all",
      visibleGoalCount: 10
    })
    expect(Schema.is(WorkGoalId)(encoded)).toBe(false)
  })
})
