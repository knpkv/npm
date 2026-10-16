// @vitest-environment happy-dom
import { expect, it } from "@effect/vitest"
import type { ReviewFinding, ReviewFindingRow, ReviewThread, ReviewWorkspaceThreads } from "@knpkv/review"
import { createElement, useLayoutEffect, useState } from "react"
import { ReviewFindingCard } from "../src/client/components/review-finding-card.js"
import { ReviewFindingsIndexView } from "../src/client/components/review-findings-index-view.js"
import { reviewThreadElementId, type ReviewThreadTarget } from "../src/client/review-thread-target.js"
import { click, mountFixture } from "./pr-view-fixtures.js"

const scope = "opaque-reference-review"
const row = (
  id: string,
  severity: ReviewFinding["severity"],
  overrides: Partial<ReviewFinding> = {}
): ReviewFindingRow => {
  const finding = {
    severity,
    axis: null,
    confidence: null,
    claim: `Recorded ${id}`,
    summary: null,
    why: "Recorded evidence",
    recommendation: "",
    verification: "",
    requirement: null,
    patch: null,
    disposition: { _tag: "Open" },
    ...overrides
  } satisfies ReviewFinding
  const thread = {
    id,
    source: "agent",
    finding,
    anchor: { _tag: "Unanchored" },
    resolved: false,
    messages: []
  } satisfies ReviewThread
  return { finding, thread }
}
const primary = [row("blocking", "P0"), row("should-fix", "P1")]
const secondary = [row("minor", "P2"), row("informational", "P3"), row("optional", "P4")]
const findings = { primary, secondary } satisfies Pick<ReviewWorkspaceThreads, "primary" | "secondary">
const hrefForThread = (thread: ReviewThreadTarget) => `#${reviewThreadElementId(scope, thread)}`

it("includes recorded discussions in the unified Threads index and filters only its navigation rows", async () => {
  const discussion = {
    id: "human",
    source: "codecommit",
    finding: null,
    anchor: { _tag: "Unanchored" },
    resolved: false,
    messages: [{
      id: "message",
      author: "Example author",
      createdAt: 1_000,
      text: "Recorded human comment",
      deleted: false
    }]
  } satisfies ReviewThread
  const complete = {
    ...findings,
    total: { _tag: "Exact", n: 6 },
    conversations: [discussion]
  } satisfies ReviewWorkspaceThreads
  const fixture = await mountFixture(createElement(ReviewFindingsIndexView, {
    findings: complete,
    threads: complete,
    scope,
    hrefForThread,
    secondary: { open: false, onOpenChange: () => {} }
  }))
  expect(fixture.host.querySelector("h2")?.textContent).toBe("Threads")
  expect(fixture.host.textContent).toContain("6 threads")
  expect(fixture.host.textContent).toContain("Recorded human comment")
  await click(fixture.host, "Comments 1")
  expect(fixture.host.querySelectorAll("a")).toHaveLength(1)
  expect(fixture.host.querySelector("a")?.getAttribute("href")).toBe(hrefForThread(discussion))
  await fixture.render(createElement(ReviewFindingsIndexView, {
    findings: complete,
    threads: { ...complete, total: { _tag: "AtLeast", n: 6 } },
    scope,
    hrefForThread,
    secondary: { open: false, onOpenChange: () => {} }
  }))
  expect(fixture.host.textContent).not.toContain("6 threads")
  expect([...fixture.host.querySelectorAll("[aria-pressed]")].map((element) => element.textContent)).toEqual([
    "All",
    "Findings",
    "Comments"
  ])
})

it("shows primary findings first and hides secondary links behind their counted, controlled toggle", async () => {
  const before = JSON.stringify(findings)
  const Harness = () => {
    const [open, onOpenChange] = useState(false)
    return createElement(ReviewFindingsIndexView, { findings, scope, hrefForThread, secondary: { open, onOpenChange } })
  }
  const fixture = await mountFixture(createElement(Harness))
  const toggle = fixture.host.querySelector("button")
  const groupId = toggle?.getAttribute("aria-controls")
  expect(groupId).not.toBeNull()
  const group = groupId === null || groupId === undefined ? null : document.getElementById(groupId)
  expect(toggle?.textContent).toBe("P2 and below (3)")
  expect(toggle?.getAttribute("aria-expanded")).toBe("false")
  expect(toggle?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true")
  expect(group?.hasAttribute("hidden")).toBe(true)
  expect(group?.querySelectorAll("a")).toHaveLength(3)
  expect([...fixture.host.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual(
    [...primary, ...secondary].map(({ thread }) => hrefForThread(thread))
  )
  toggle?.focus()
  await click(fixture.host, "P2 and below (3)")
  expect(fixture.host.querySelector("button")).toBe(toggle)
  expect(document.activeElement).toBe(toggle)
  expect(toggle?.getAttribute("aria-expanded")).toBe("true")
  expect(group?.hasAttribute("hidden")).toBe(false)
  await click(fixture.host, "P2 and below (3)")
  expect(group?.hasAttribute("hidden")).toBe(true)
  expect(document.activeElement).toBe(toggle)
  expect(JSON.stringify(findings)).toBe(before)
})

it("frames secondary-only results from the ref and leaves both-empty wording to the parent", async () => {
  const fixture = await mountFixture(createElement(ReviewFindingsIndexView, {
    findings: { primary: [], secondary },
    scope,
    hrefForThread,
    secondary: { open: false, onOpenChange: () => {} }
  }))
  expect(fixture.host.querySelector("h2")?.textContent).toBe("Findings")
  expect(fixture.host.textContent).not.toContain("No blocking or should-fix findings")
  expect(fixture.host.querySelector("button")?.textContent).toBe("P2 and below (3)")
  await fixture.render(createElement(ReviewFindingsIndexView, {
    findings: { primary: [], secondary: [] },
    scope,
    hrefForThread,
    secondary: { open: false, onOpenChange: () => {} }
  }))
  expect(fixture.host.childElementCount).toBe(0)
})

it("keeps recorded status and anchor words in navigation without adding write or review controls", async () => {
  const dismissed = row("dismissed", "P1", {
    axis: "Security",
    confidence: "high",
    disposition: { _tag: "Dismissed", reason: "already_fixed", note: "recorded note" }
  })
  const anchored = {
    ...dismissed,
    thread: {
      ...dismissed.thread,
      anchor: { _tag: "Line", path: "src/retry.ts", line: 8, side: "before", outdated: true },
      resolved: true
    }
  } satisfies ReviewFindingRow
  const fixture = await mountFixture(createElement(ReviewFindingsIndexView, {
    findings: { primary: [anchored], secondary: [] },
    scope,
    hrefForThread,
    secondary: { open: false, onOpenChange: () => {} }
  }))
  for (
    const text of [
      "Security",
      "High confidence",
      "src/retry.ts:8",
      "Before change",
      "Outdated",
      "Dismissed: Already fixed elsewhere, ‘recorded note’",
      "Thread resolved"
    ]
  ) {
    expect(fixture.host.querySelector("a")?.textContent).toContain(text)
  }
  expect(fixture.host.querySelector("button, input, textarea, form")).toBeNull()
})

it("encodes punctuation, Unicode, source and workspace scope into distinct selector-safe targets", async () => {
  const target = { source: "agent", id: "finding]#\"雪 /" } satisfies ReviewThreadTarget
  const id = reviewThreadElementId(scope, target)
  expect(id).toMatch(/^review-thread-[0-9a-f]+$/)
  expect(reviewThreadElementId(scope, target)).toBe(id)
  expect(reviewThreadElementId("other-workspace", target)).not.toBe(id)
  expect(reviewThreadElementId(scope, { ...target, source: "codecommit" })).not.toBe(id)
  expect(reviewThreadElementId(scope, { ...target, id: `${target.id}x` })).not.toBe(id)
  const value = row(target.id, "P1")
  const fixture = await mountFixture(createElement(
    "div",
    null,
    createElement(ReviewFindingsIndexView, {
      findings: { primary: [value], secondary: [] },
      scope,
      hrefForThread,
      secondary: { open: false, onOpenChange: () => {} }
    }),
    createElement(ReviewFindingCard, { row: value, scope })
  ))
  expect(fixture.host.querySelector("a")?.getAttribute("href")).toBe(`#${id}`)
  expect(fixture.host.querySelector(`#${id}`)).toBe(fixture.host.querySelector("article"))
})

it("lets the host expand a deep-linked secondary group before focusing its shared card target", async () => {
  const target = secondary[2]
  expect(target).toBeDefined()
  if (target === undefined) return
  const requestedId = reviewThreadElementId(scope, target.thread)
  const Harness = () => {
    const [open, onOpenChange] = useState(false)
    const [selected, setSelected] = useState<string | null>(null)
    useLayoutEffect(() => {
      if (selected !== null && open) document.getElementById(selected)?.focus()
    }, [open, selected])
    return createElement(
      "div",
      null,
      createElement("button", {
        type: "button",
        onClick: () => {
          onOpenChange(true)
          setSelected(requestedId)
        }
      }, "Follow secondary deep link"),
      createElement(ReviewFindingsIndexView, { findings, scope, hrefForThread, secondary: { open, onOpenChange } }),
      createElement("div", { hidden: !open }, createElement(ReviewFindingCard, { row: target, scope }))
    )
  }
  const fixture = await mountFixture(createElement(Harness))
  await click(fixture.host, "Follow secondary deep link")
  const card = document.getElementById(requestedId)
  expect(card?.closest("[hidden]")).toBeNull()
  expect(document.activeElement).toBe(card)
  expect(fixture.host.querySelector("[aria-expanded=\"true\"]")?.textContent).toBe("P2 and below (3)")
})

it("derives human initials, status labels and reply counts only from recorded messages", async () => {
  const message = { id: "root", author: "  Reviewer", createdAt: 1_000, text: "Recorded root", deleted: false }
  const discussion = {
    id: "human-status",
    source: "codecommit",
    finding: null,
    resolved: false,
    anchor: { _tag: "Line", path: "example.ts", line: 7, side: "after", outdated: true },
    messages: [message, { ...message, id: "reply", author: "Contributor", text: "Recorded reply" }]
  } satisfies ReviewThread
  const fixture = await mountFixture(createElement(ReviewFindingsIndexView, {
    findings: { primary: [], secondary: [] },
    threads: { total: { _tag: "Exact", n: 1 }, conversations: [discussion] },
    scope,
    hrefForThread,
    secondary: { open: false, onOpenChange: () => {} }
  }))
  const link = fixture.host.querySelector("a")
  expect(link?.querySelector("[data-comment-initial]")?.textContent).toBe("R")
  expect(link?.querySelector("[data-comment-initial]")?.getAttribute("aria-hidden")).toBe("true")
  expect(link?.querySelector("[data-comment-status]")?.textContent).toBe("CommentOutdated")
  expect(link?.querySelector("[data-comment-status]")?.nextElementSibling?.textContent).toBe("Recorded root")
  expect(link?.querySelector("[data-comment-replies]")?.textContent).toBe("1 reply")
  expect(link?.querySelector("[data-comment-replies]")?.parentElement).toBe(link?.querySelector("code")?.parentElement)
  for (const messages of [[], [message], [message, { ...message, id: "reply1" }, { ...message, id: "reply2" }]]) {
    await fixture.render(createElement(ReviewFindingsIndexView, {
      findings: { primary: [], secondary: [] },
      threads: { total: { _tag: "AtLeast", n: 1 }, conversations: [{ ...discussion, messages }] },
      scope,
      hrefForThread,
      secondary: { open: false, onOpenChange: () => {} }
    }))
    expect(fixture.host.querySelector("[data-comment-replies]")?.textContent ?? null).toBe(
      messages.length > 1 ? "2 replies" : null
    )
    expect(fixture.host.querySelectorAll("[data-comment-initial]")).toHaveLength(messages.length === 0 ? 0 : 1)
    expect(fixture.host.textContent).not.toContain("1 thread")
  }
})

/** Recorded statuses have the same visual word/icon treatment as their target card, without controls. */
it("gives a recorded pushed fix its status glyph and keeps Open rows unlabelled", async () => {
  const pushed = row("pushed", "P1", { disposition: { _tag: "FixedVerify", commit: "recorded-head" } })
  const open = row("open", "P1")
  const fixture = await mountFixture(createElement(ReviewFindingsIndexView, {
    findings: { primary: [pushed, open], secondary: [] },
    scope,
    hrefForThread,
    secondary: { open: false, onOpenChange: () => {} }
  }))
  const links = fixture.host.querySelectorAll("a")
  expect(links[0]?.textContent).toContain("Fix pushed in recorded-head, waiting for re-review")
  expect(links[0]?.querySelector("svg")).not.toBeNull()
  expect(links[1]?.querySelector("svg")).toBeNull()
  expect(fixture.host.querySelector("button")).toBeNull()
})

/** Dismissal is a recorded neutral status with an explicit minus, not an inferred Open label. */
it("gives recorded dismissal its intentional neutral minus mark", async () => {
  const dismissed = row("dismissed", "P1", { disposition: { _tag: "Dismissed", reason: "false_positive", note: null } })
  const fixture = await mountFixture(createElement(ReviewFindingsIndexView, {
    findings: { primary: [dismissed], secondary: [] },
    scope,
    hrefForThread,
    secondary: { open: false, onOpenChange: () => {} }
  }))
  expect(fixture.host.querySelector("a")?.textContent).toContain("Dismissed: False positive")
  expect(fixture.host.querySelector("a svg")).not.toBeNull()
  expect(fixture.host.querySelector("button")).toBeNull()
})
