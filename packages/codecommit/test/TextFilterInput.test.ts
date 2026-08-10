import { describe, expect, it } from "@effect/vitest"
import {
  cycleSettingsFilterMode,
  parseSettingsFilter,
  settingsFilterActionScope,
  textFilterActionScope,
  type TextFilterInputKey,
  type TextFilterInputState,
  transitionBoundedMultiSelection,
  transitionBoundedSelection,
  transitionSingleLineDraft,
  transitionTextFilterInput
} from "../src/tui/text-filter-input.js"

const applyBatch = (keys: ReadonlyArray<TextFilterInputKey>): TextFilterInputState => {
  let state: TextFilterInputState = { active: false, text: "" }
  for (const key of keys) {
    const transition = transitionTextFilterInput(state, key, true)
    expect(transition.handled).toBe(true)
    state = transition.state
  }
  return state
}

describe("text filter input", () => {
  it("preserves every character when slash, pasted text, and Enter arrive before a render", () => {
    const state = applyBatch([
      { name: "/", char: "/" },
      ...Array.from("fixture", (char) => ({ name: char, char })),
      { name: "return" }
    ])

    expect(state).toEqual({ active: false, text: "fixture" })
  })

  it("submits the full synchronous conversation draft when paste and Return share a batch", () => {
    let draft = "keep"
    let submission: string | null = null
    for (
      const key of [
        ...Array.from(" this finding", (char) => ({ name: char === " " ? "space" : char, char })),
        { name: "return" }
      ]
    ) {
      const transition = transitionSingleLineDraft(draft, key, 2_000)
      draft = transition.draft
      submission = transition.submission ?? submission
    }

    expect(submission).toBe("keep this finding")
    expect(transitionSingleLineDraft("already rendered", { name: "return" }, 2_000).submission).toBe(
      "already rendered"
    )
  })

  it("submits the synchronously selected target when navigation and Return share a batch", () => {
    let cursor = 1
    let submittedIndex: number | null = null
    for (const key of [{ name: "down" }, { name: "return" }]) {
      const transition = transitionBoundedSelection(cursor, key, 3)
      cursor = transition.cursor
      submittedIndex = transition.submittedIndex ?? submittedIndex
    }

    expect(submittedIndex).toBe(2)
    expect(transitionBoundedSelection(1, { name: "return" }, 3).submittedIndex).toBe(1)
    expect(transitionBoundedSelection(2, { name: "down" }, 3).cursor).toBe(2)
    expect(transitionBoundedSelection(0, { name: "up" }, 3).cursor).toBe(0)
  })

  it("submits the synchronously toggled review skills when Space and Return share a batch", () => {
    let state: { cursor: number; selection: ReadonlyArray<string> } = {
      cursor: 0,
      selection: ["pr-review", "pr-diff-review"]
    }
    let submission: ReadonlyArray<string> | null = null
    for (const key of [{ name: "space" }, { name: "return" }]) {
      const transition = transitionBoundedMultiSelection(
        state,
        key,
        ["pr-review", "pr-diff-review"],
        1
      )
      state = { cursor: transition.cursor, selection: transition.selection }
      submission = transition.submission ?? submission
    }

    expect(submission).toEqual(["pr-diff-review"])
    expect(
      transitionBoundedMultiSelection(
        { cursor: 1, selection: ["pr-review", "pr-diff-review"] },
        { name: "return" },
        ["pr-review", "pr-diff-review"],
        1
      ).submission
    ).toEqual(["pr-review", "pr-diff-review"])
    expect(
      transitionBoundedMultiSelection(
        { cursor: 0, selection: ["pr-review"] },
        { name: "space" },
        ["pr-review", "pr-diff-review"],
        1
      ).selection
    ).toEqual(["pr-review"])
  })

  it("keeps settings-filter shortcut letters inside a pasted account search", () => {
    const state = applyBatch([
      { name: "/", char: "/" },
      ...Array.from("dev administrator", (char) => ({ name: char === " " ? "space" : char, char })),
      { name: "return" }
    ])

    expect(state).toEqual({ active: false, text: "dev administrator" })
  })

  it("scopes an immediate bulk action to just-submitted settings filter text", () => {
    const submitted = applyBatch([
      { name: "/", char: "/" },
      ...Array.from("prod", (char) => ({ name: char, char })),
      { name: "return" }
    ])
    const profiles = ["production-admin", "development-admin"]

    expect(textFilterActionScope(submitted, profiles)).toEqual(["production-admin"])
    expect(textFilterActionScope({ active: false, text: "prod" }, profiles)).toEqual(["production-admin"])
    expect(textFilterActionScope({ active: false, text: "" }, profiles)).toBeNull()
  })

  it("scopes settings actions to the parsed status and profile name", () => {
    const accounts = [
      { enabled: true, profile: "production-admin" },
      { enabled: false, profile: "production-readonly" },
      { enabled: true, profile: "development-admin" }
    ]

    expect(settingsFilterActionScope({ active: false, text: "on:prod" }, accounts)).toEqual(["production-admin"])
    expect(settingsFilterActionScope({ active: false, text: "off:prod" }, accounts)).toEqual(["production-readonly"])
    expect(settingsFilterActionScope({ active: false, text: "on:" }, accounts)).toEqual([
      "production-admin",
      "development-admin"
    ])
    expect(settingsFilterActionScope({ active: false, text: "" }, accounts)).toBeNull()
  })

  it("treats only a leading settings mode as a prefix", () => {
    expect(parseSettingsFilter("ON:Prod")).toEqual({ status: "on", name: "prod" })
    expect(parseSettingsFilter("prod-on:secondary")).toEqual({ status: "all", name: "prod-on:secondary" })
  })

  it("cycles settings modes in either filter state without losing profile text", () => {
    expect(cycleSettingsFilterMode("Prod", "right")).toBe("on:Prod")
    expect(cycleSettingsFilterMode("on:Prod", "right")).toBe("off:Prod")
    expect(cycleSettingsFilterMode("off:Prod", "right")).toBe("Prod")
    expect(cycleSettingsFilterMode("Prod", "left")).toBe("off:Prod")
  })

  it("does not consume ordinary navigation when filtering cannot open", () => {
    const state: TextFilterInputState = { active: false, text: "" }
    expect(transitionTextFilterInput(state, { name: "return" }, false)).toEqual({ handled: false, state })
  })

  it("owns deletion and cancellation while active", () => {
    const active: TextFilterInputState = { active: true, text: "review" }
    expect(transitionTextFilterInput(active, { name: "backspace" }, true)).toEqual({
      handled: true,
      state: { active: true, text: "revie" }
    })
    expect(transitionTextFilterInput(active, { name: "escape" }, true)).toEqual({
      handled: true,
      state: { active: false, text: "" }
    })
    expect(transitionTextFilterInput(active, { name: ":", char: ":" }, true)).toEqual({
      handled: true,
      state: { active: true, text: "review:" }
    })
  })
})
