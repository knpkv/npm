// @vitest-environment happy-dom
import { expect, it } from "@effect/vitest"
import { type ReviewConversations, ReviewHistoryFailureReason } from "@knpkv/review"
import { createElement, useRef, useState } from "react"
import { ReviewRunFallbackView } from "../src/client/components/review-run-fallback-view.js"
import { click, mountFixture } from "./pr-view-fixtures.js"

it("shows missing history as no agent review without execution or invented result controls", async () => {
  const fixture = await mountFixture(createElement(ReviewRunFallbackView, {
    conversations: { _tag: "Ready", observedAt: 1_000, threads: [] },
    reading: { _tag: "NotRecorded" },
    readAgain: { focusTarget: () => null, onReadAgain: () => {} }
  }))
  expect(fixture.host.querySelector("section[aria-label=\"Review summary\"]")).not.toBeNull()
  expect(fixture.host.textContent).toBe("No agent review yet")
  expect(fixture.host.querySelector("button, a")).toBeNull()
  expect(fixture.host.querySelector("[role=\"status\"]")).toBeNull()
})

it("keeps every unreadable-history reason separate from a missing or clean review", async () => {
  const fixture = await mountFixture(createElement(ReviewRunFallbackView, {
    conversations: { _tag: "Ready", observedAt: 1_000, threads: [] },
    reading: { _tag: "NotRecorded" },
    readAgain: { focusTarget: () => null, onReadAgain: () => {} }
  }))
  for (const reason of ReviewHistoryFailureReason.literals) {
    await fixture.render(createElement(ReviewRunFallbackView, {
      conversations: { _tag: "Ready", observedAt: 1_000, threads: [] },
      reading: { _tag: "Unavailable", reason },
      readAgain: { focusTarget: () => null, onReadAgain: () => {} }
    }))
    const status = fixture.host.querySelector("[role=\"status\"]")
    expect(status?.textContent).toBe(
      "Review history unavailableThe recorded agent review could not be read on this host. The diff and comments are still available.Read again"
    )
    expect(status?.textContent).not.toContain(reason)
    expect(fixture.host.textContent).not.toContain("No agent review yet")
    expect(fixture.host.querySelectorAll("button")).toHaveLength(1)
    expect(fixture.host.querySelector("button")?.textContent).toBe("Read again")
  }
})

it("delegates Read again once to the supplied host callback", async () => {
  let reads = 0
  const fixture = await mountFixture(createElement(ReviewRunFallbackView, {
    conversations: { _tag: "Ready", observedAt: 1_000, threads: [] },
    reading: { _tag: "Unavailable", reason: "invalid" },
    readAgain: {
      focusTarget: () => null,
      onReadAgain: () => {
        reads += 1
      }
    }
  }))
  expect(reads).toBe(0)
  await click(fixture.host, "Read again")
  expect(reads).toBe(1)
})

const ReadHarness = ({ outcome }: { readonly outcome: "Ready" | "NotRecorded" | "Unavailable" }) => {
  const target = useRef<HTMLElement>(null)
  const [state, setState] = useState<"Ready" | "NotRecorded" | "Unavailable">("Unavailable")
  return createElement(
    "section",
    { "aria-label": "Retained review workspace", ref: target, tabIndex: -1 },
    state === "Ready"
      ? createElement("h2", null, "Completed review")
      : createElement(ReviewRunFallbackView, {
        conversations: { _tag: "Ready", observedAt: 1_000, threads: [] },
        reading: state === "NotRecorded" ? { _tag: "NotRecorded" } : { _tag: "Unavailable", reason: "invalid" },
        readAgain: { focusTarget: () => target.current, onReadAgain: () => setState(outcome) }
      })
  )
}

it("hands focus to the retained host container before a successful read replaces the entire fallback", async () => {
  for (const outcome of ["Ready", "NotRecorded"] satisfies ReadonlyArray<"Ready" | "NotRecorded">) {
    const fixture = await mountFixture(createElement(ReadHarness, { outcome }))
    const target = fixture.host.querySelector("section[aria-label=\"Retained review workspace\"]")
    const read = fixture.host.querySelector("button")
    read?.focus()
    expect(document.activeElement).toBe(read)
    await click(fixture.host, "Read again")
    expect(fixture.host.querySelector("button")).toBeNull()
    expect(document.activeElement).toBe(target)
    expect(fixture.host.textContent).toBe(outcome === "Ready" ? "Completed review" : "No agent review yet")
    await fixture.unmount()
  }
})

it("keeps focus on the host container when a re-read still leaves history unavailable", async () => {
  const fixture = await mountFixture(createElement(ReadHarness, { outcome: "Unavailable" }))
  const target = fixture.host.querySelector("section[aria-label=\"Retained review workspace\"]")
  fixture.host.querySelector("button")?.focus()
  await click(fixture.host, "Read again")
  expect(document.activeElement).toBe(target)
  expect(fixture.host.querySelector("[role=\"status\"]")?.textContent).toContain("Review history unavailable")
})

it("keeps the retry focused and still reads when the supplied destination is absent or detached", async () => {
  for (const target of [null, document.createElement("section")]) {
    let reads = 0
    const fixture = await mountFixture(createElement(ReviewRunFallbackView, {
      conversations: { _tag: "Ready", observedAt: 1_000, threads: [] },
      reading: { _tag: "Unavailable", reason: "invalid" },
      readAgain: {
        focusTarget: () => target,
        onReadAgain: () => {
          reads += 1
        }
      }
    }))
    const button = fixture.host.querySelector("button")
    button?.focus()
    await click(fixture.host, "Read again")
    expect(document.activeElement).toBe(button)
    expect(reads).toBe(1)
    await fixture.unmount()
  }
})

it("never claims comments are available when that independent reading is unavailable", async () => {
  const fixture = await mountFixture(createElement(ReviewRunFallbackView, {
    reading: { _tag: "Unavailable", reason: "invalid" },
    conversations: { _tag: "Ready", observedAt: 1_000, threads: [] },
    readAgain: { focusTarget: () => null, onReadAgain: () => {} }
  }))
  for (
    const reason of ["not_cached", "over_limit", "corrupt"] satisfies ReadonlyArray<
      Extract<ReviewConversations, { readonly _tag: "Unavailable" }>["reason"]
    >
  ) {
    await fixture.render(createElement(ReviewRunFallbackView, {
      reading: { _tag: "Unavailable", reason: "invalid" },
      conversations: { _tag: "Unavailable", reason },
      readAgain: { focusTarget: () => null, onReadAgain: () => {} }
    }))
    const text = fixture.host.querySelector("[role=\"status\"]")?.textContent
    expect(text).toBe(
      "Review history unavailableThe recorded agent review could not be read on this host. The diff is still available.Read again"
    )
    expect(text).not.toContain("comments are still available")
    expect(text).not.toContain(reason)
  }
  await fixture.render(createElement(ReviewRunFallbackView, {
    reading: { _tag: "Unavailable", reason: "invalid" },
    conversations: { _tag: "Ready", observedAt: 1_000, threads: [] },
    readAgain: { focusTarget: () => null, onReadAgain: () => {} }
  }))
  expect(fixture.host.textContent).toContain("The diff and comments are still available.")
})
