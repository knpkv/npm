// @vitest-environment happy-dom
import { expect, it } from "@effect/vitest"
import { type ReviewConversations, ThreadsConflict } from "@knpkv/review"
import { createElement, useRef, useState } from "react"
import { ReviewThreadsFallbackView } from "../src/client/components/review-threads-fallback-view.js"
import { click, mountFixture } from "./pr-view-fixtures.js"

const expected = {
  not_cached: ["Comments not cached", "This host has no saved comments for this pull request."],
  over_limit: ["Too many comments to show here", "The saved comments exceed this view’s limits."],
  corrupt: ["Comments unavailable", "The saved comments could not be read on this host."]
} satisfies Record<Extract<ReviewConversations, { readonly _tag: "Unavailable" }>["reason"], ReadonlyArray<string>>

it("uses each comments failure's exact words in Threads and Conversation without inventing counts or controls", async () => {
  const fixture = await mountFixture(createElement("div"))
  for (const presentation of ["review", "conversation"] satisfies ReadonlyArray<"review" | "conversation">) {
    for (
      const reason of ["not_cached", "over_limit", "corrupt"] satisfies ReadonlyArray<
        Extract<ReviewConversations, { readonly _tag: "Unavailable" }>["reason"]
      >
    ) {
      await fixture.render(createElement(ReviewThreadsFallbackView, {
        problem: { _tag: "Unavailable", reason },
        presentation,
        focusTarget: () => null,
        onReadAgain: () => {}
      }))
      const title = presentation === "review" ? "Threads" : "Conversation"
      expect(fixture.host.querySelector("section")?.getAttribute("aria-label")).toBe(title)
      expect(fixture.host.querySelector("h2")?.textContent).toBe(title)
      expect(fixture.host.querySelector("[role=\"status\"]")?.textContent).toBe(
        expected[reason].join("") + "Read again"
      )
      expect(fixture.host.querySelectorAll("button")).toHaveLength(1)
      expect(fixture.host.querySelector("button")?.textContent).toBe("Read again")
      expect(fixture.host.querySelector("input, textarea, ol, ul, dl, [role=group]")).toBeNull()
      expect(fixture.host.textContent).not.toContain("All 0")
    }
  }
})

it("keeps identity conflicts distinct from unreadable or missing comments and never exposes the conflicting key", async () => {
  const fixture = await mountFixture(createElement("div"))
  for (const presentation of ["review", "conversation"] satisfies ReadonlyArray<"review" | "conversation">) {
    await fixture.render(createElement(ReviewThreadsFallbackView, {
      problem: new ThreadsConflict({ source: "agent", id: "conflicting-key" }),
      presentation,
      focusTarget: () => null,
      onReadAgain: () => {}
    }))
    expect(fixture.host.querySelector("[role=\"status\"]")?.textContent).toBe(
      "Threads could not be combinedThe saved review and comments contain conflicting thread records. The diff is still available.Read again"
    )
    expect(fixture.host.textContent).not.toContain("Comments unavailable")
    expect(fixture.host.textContent).not.toContain("conflicting-key")
    expect(fixture.host.querySelectorAll("button")).toHaveLength(1)
  }
})

it("hands retry focus to the retained host before the whole threads notice disappears", async () => {
  let reads = 0
  const Harness = () => {
    const target = useRef<HTMLElement>(null)
    const [ready, setReady] = useState(false)
    return createElement(
      "section",
      { "aria-label": "Retained threads", ref: target, tabIndex: -1 },
      ready ? createElement("h2", null, "Saved comments") : createElement(ReviewThreadsFallbackView, {
        problem: { _tag: "Unavailable", reason: "not_cached" },
        presentation: "review",
        focusTarget: () => target.current,
        onReadAgain: () => {
          reads += 1
          setReady(true)
        }
      })
    )
  }
  const fixture = await mountFixture(createElement(Harness))
  const target = fixture.host.querySelector("section[aria-label=\"Retained threads\"]")
  fixture.host.querySelector("button")?.focus()
  await click(fixture.host, "Read again")
  expect(reads).toBe(1)
  expect(fixture.host.querySelector("button")).toBeNull()
  expect(document.activeElement).toBe(target)
})
