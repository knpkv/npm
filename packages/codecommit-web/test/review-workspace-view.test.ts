// @vitest-environment happy-dom
import { expect, it } from "@effect/vitest"
import type { ReviewFinding, ReviewThread, ReviewWorkspace } from "@knpkv/review"
import { act, createElement, useRef, useState } from "react"
import { ReviewWorkspaceView } from "../src/client/components/review-workspace-view.js"
import { click, mountFixture } from "./pr-view-fixtures.js"

const finding = {
  severity: "P1",
  axis: null,
  confidence: null,
  claim: "Recorded claim",
  summary: null,
  why: "Recorded evidence",
  recommendation: "",
  verification: "",
  requirement: null,
  patch: null,
  disposition: { _tag: "Open" }
} satisfies ReviewFinding
const agent = {
  id: "finding-1",
  source: "agent",
  finding,
  anchor: { _tag: "Unanchored" },
  resolved: false,
  messages: [{ id: "reply-1", author: "reviewer", createdAt: 1_000, text: "Recorded reply", deleted: false }]
} satisfies ReviewThread
const human = {
  id: "comment-1",
  source: "codecommit",
  finding: null,
  resolved: false,
  anchor: { _tag: "Line", path: "src/example.ts", line: 2, side: "before", outdated: true },
  messages: [{ id: "root-1", author: "contributor", createdAt: 1_000, text: "Recorded human comment", deleted: false }]
} satisfies ReviewThread
const identity = {
  namespace: "codecommit",
  subjectId: "opaque-reference",
  revisionId: "revision-1",
  baseRevision: "base-1",
  headRevision: "head-1"
}
const workspace = {
  identity,
  observedAt: 1_000,
  checks: { _tag: "Unknown" },
  run: {
    _tag: "Ready",
    run: {
      id: "run-1",
      identity,
      kind: "review",
      completedAt: 1_000,
      profile: null,
      summary: "Recorded verdict",
      explanation: null,
      risks: null,
      focus: null,
      rules: null,
      threads: [agent]
    }
  },
  conversations: { _tag: "Ready", observedAt: 1_000, threads: [human] }
} satisfies ReviewWorkspace
const defaults = {
  workspace,
  presentation: "review",
  scope: "host-workspace",
  secondary: { open: false, onOpenChange: () => {} },
  hrefForThread: (_thread: Pick<ReviewThread, "source" | "id">, id: string) => `#${id}`,
  focusTarget: () => null,
  onReadAgain: () => {},
  diff: createElement("p", { "data-immutable-diff": true }, "Immutable diff")
} satisfies Parameters<typeof ReviewWorkspaceView>[0]

it("composes the recorded verdict, finding evidence/replies, human anchor and supplied immutable diff without actions", async () => {
  const fixture = await mountFixture(createElement(ReviewWorkspaceView, defaults))
  for (
    const text of [
      "Recorded verdict",
      "Recorded claim",
      "Recorded evidence",
      "Recorded reply",
      "Recorded human comment",
      "src/example.ts:2",
      "Before change",
      "Outdated"
    ]
  ) expect(fixture.host.textContent).toContain(text)
  expect(fixture.host.querySelector("[data-immutable-diff]")).not.toBeNull()
  expect(fixture.host.querySelector("textarea, input, img")).toBeNull()
  expect(
    [...fixture.host.querySelectorAll("button")].every((button) =>
      button.closest("[aria-label=\"Thread list filters\"]") !== null
    )
  ).toBe(true)
  const href = fixture.host.querySelector("a")?.getAttribute("href")
  expect(href).toBeDefined()
  expect(fixture.host.querySelector(href ?? "#missing")?.querySelector("h3")?.textContent).toBe(finding.claim)
})

it("keeps verdict and diff on a thread conflict while replacing all joined rows and counts with one retry", async () => {
  const fixture = await mountFixture(createElement(ReviewWorkspaceView, {
    ...defaults,
    workspace: { ...workspace, conversations: { _tag: "Ready", observedAt: 1_000, threads: [human, human] } }
  }))
  expect(fixture.host.textContent).toContain("Recorded verdict")
  expect(fixture.host.textContent).toContain("Threads could not be combined")
  expect(fixture.host.querySelector("[data-immutable-diff]")).not.toBeNull()
  expect(fixture.host.querySelectorAll("button")).toHaveLength(1)
  for (const text of ["Recorded claim", "Recorded human comment", "By severity"]) {
    expect(fixture.host.textContent).not.toContain(text)
  }
})

it("keeps different-revision findings separate and displays the mismatch beside the original recorded verdict", async () => {
  const fixture = await mountFixture(createElement(ReviewWorkspaceView, {
    ...defaults,
    workspace: { ...workspace, identity: { ...identity, headRevision: "head-2" } }
  }))
  expect(fixture.host.textContent).toContain("Review is for a different revision")
  expect(fixture.host.textContent).toContain("Reviewed head-1; the branch is now at head-2.")
  expect(fixture.host.textContent).toContain("Recorded claim")
  expect(fixture.host.querySelector("[data-review-summary=\"recorded\"]")?.textContent).toContain("head head-1")
})

it("renders Conversation from recorded messages without summary/diff and scopes both retained presentations separately", async () => {
  const fixture = await mountFixture(
    createElement(
      "div",
      null,
      createElement(ReviewWorkspaceView, defaults),
      createElement(ReviewWorkspaceView, { ...defaults, presentation: "conversation" })
    )
  )
  const conversation = fixture.host.querySelector("[data-review-presentation=\"conversation\"]")
  expect(conversation?.textContent).toContain("Recorded reply")
  expect(conversation?.textContent).toContain("Recorded human comment")
  expect(conversation?.querySelector("[data-review-summary], [data-immutable-diff]")).toBeNull()
  const ids = [...fixture.host.querySelectorAll("[id]")].map((element) => element.id)
  expect(new Set(ids).size).toBe(ids.length)
})

it("keeps empty-message finding threads on Review and renders only real discussions with a finding reference in Conversation", async () => {
  const emptyThread = {
    ...agent,
    id: "empty-finding",
    finding: { ...finding, claim: "No-discussion claim" },
    messages: []
  }
  const withBoth: ReviewWorkspace = {
    ...workspace,
    run: { _tag: "Ready", run: { ...workspace.run.run, threads: [agent, emptyThread] } }
  }
  const fixture = await mountFixture(
    createElement(
      "div",
      null,
      createElement(ReviewWorkspaceView, { ...defaults, workspace: withBoth }),
      createElement(ReviewWorkspaceView, { ...defaults, workspace: withBoth, presentation: "conversation" })
    )
  )
  const conversation = fixture.host.querySelector("[data-review-presentation=\"conversation\"]")
  expect(conversation?.textContent).not.toContain("No-discussion claim")
  expect(conversation?.textContent).toContain("Recorded claim")
  expect(conversation?.textContent).toContain("Recorded reply")
  expect(conversation?.textContent).not.toContain("Recorded evidence")
  expect(conversation?.querySelector("h4, pre")).toBeNull()
  const reference = conversation?.querySelector("a")
  expect(reference?.textContent).toContain("P1")
  const target = reference?.getAttribute("href")
  expect(target).toBeDefined()
  expect(
    fixture.host.querySelector(target ?? "#missing")?.closest("[data-review-presentation]")?.getAttribute(
      "data-review-presentation"
    )
  ).toBe("review")
  expect(conversation?.textContent).toContain("Agent summary")
  expect(conversation?.textContent).toContain("Recorded verdict")
})

it("counts only listed unresolved discussions, excludes the summary and omits a zero count", async () => {
  const fixture = await mountFixture(createElement(ReviewWorkspaceView, { ...defaults, presentation: "conversation" }))
  expect(fixture.host.querySelector("header small")?.textContent).toBe("Unresolved 2")
  await fixture.render(createElement(ReviewWorkspaceView, {
    ...defaults,
    presentation: "conversation",
    workspace: {
      ...workspace,
      run: { _tag: "Ready", run: { ...workspace.run.run, threads: [{ ...agent, messages: [] }] } },
      conversations: { _tag: "Ready", observedAt: 1_000, threads: [{ ...human, resolved: true }] }
    }
  }))
  expect(fixture.host.textContent).toContain("Agent summary")
  expect(fixture.host.textContent).not.toContain("Unresolved")
  expect(fixture.host.querySelector("h2")?.textContent).toBe("Conversation")
  expect(fixture.host.querySelector("[data-review-agent-summary] time")?.getAttribute("datetime")).toBe(
    new Date(1_000).toISOString()
  )
  expect(fixture.host.querySelector("[data-review-agent-summary] time")?.getAttribute("title")).not.toBe("")
  await fixture.render(createElement(ReviewWorkspaceView, {
    ...defaults,
    presentation: "conversation",
    workspace: { ...workspace, run: { _tag: "NotRecorded" } }
  }))
  expect(fixture.host.querySelector("[data-review-agent-summary]")).toBeNull()
})

it("omits an exact unresolved count when comments or history are unavailable", async () => {
  const fixture = await mountFixture(createElement("div"))
  for (
    const value of [
      { ...workspace, conversations: { _tag: "Unavailable", reason: "corrupt" } },
      { ...workspace, run: { _tag: "Unavailable", reason: "invalid" } }
    ] satisfies ReadonlyArray<ReviewWorkspace>
  ) {
    await fixture.render(
      createElement(ReviewWorkspaceView, { ...defaults, presentation: "conversation", workspace: value })
    )
    expect(fixture.host.textContent).not.toContain("Unresolved 1")
    expect(fixture.host.querySelector("header small")).toBeNull()
  }
})

it("hands the single combined retry to the host element retained across Loading and successful replacement", async () => {
  const Harness = () => {
    const target = useRef<HTMLElement>(null)
    const [reading, setReading] = useState<ReviewWorkspace | null>({
      ...workspace,
      run: { _tag: "Unavailable", reason: "invalid" },
      conversations: { _tag: "Unavailable", reason: "corrupt" }
    })
    return createElement(
      "section",
      { ref: target, tabIndex: -1, "aria-label": "Retained review owner" },
      reading === null ?
        createElement("button", { onClick: () => setReading(workspace) }, "Resolve read") :
        createElement(ReviewWorkspaceView, {
          ...defaults,
          workspace: reading,
          focusTarget: () => target.current,
          onReadAgain: () => setReading(null)
        })
    )
  }
  const fixture = await mountFixture(createElement(Harness))
  const target = fixture.host.querySelector("[aria-label=\"Retained review owner\"]")
  expect(fixture.host.querySelectorAll("button")).toHaveLength(1)
  fixture.host.querySelector("button")?.focus()
  await click(fixture.host, "Read again")
  expect(document.activeElement).toBe(target)
  await click(fixture.host, "Resolve read")
  expect(document.activeElement).toBe(target)
  expect(fixture.host.textContent).toContain("Recorded verdict")
})

it("uses the host route-preserving href and deliberate selection without intercepting modified clicks", async () => {
  const opened: Array<string> = []
  const href = "#code/reviews?ref=opaque-reference&finding=agent%3Afinding-1"
  const fixture = await mountFixture(createElement(ReviewWorkspaceView, {
    ...defaults,
    hrefForThread: () => href,
    onOpenThread: (_thread, id) => {
      opened.push(id)
      fixture.host.querySelector<HTMLElement>(`#${id}`)?.focus()
    }
  }))
  const link = fixture.host.querySelector("a")
  expect(link?.getAttribute("href")).toBe(href)
  const ordinary = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
  await act(async () => link?.dispatchEvent(ordinary))
  expect(ordinary.defaultPrevented).toBe(true)
  expect(opened).toHaveLength(1)
  expect(document.activeElement?.id).toBe(opened[0])
  const modified = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true })
  await act(async () => link?.dispatchEvent(modified))
  expect(modified.defaultPrevented).toBe(false)
  expect(opened).toHaveLength(1)
})

it("keeps exactly one Conversation heading and one retry when the discussion list owns a failure notice", async () => {
  for (
    const reading of [
      { ...workspace, conversations: { _tag: "Unavailable", reason: "corrupt" } },
      {
        ...workspace,
        run: { _tag: "Unavailable", reason: "invalid" },
        conversations: { _tag: "Unavailable", reason: "not_cached" }
      },
      { ...workspace, conversations: { _tag: "Ready", observedAt: 1_000, threads: [human, human] } }
    ] satisfies ReadonlyArray<ReviewWorkspace>
  ) {
    const fixture = await mountFixture(
      createElement(ReviewWorkspaceView, { ...defaults, workspace: reading, presentation: "conversation" })
    )
    expect([...fixture.host.querySelectorAll("h2")].filter((heading) => heading.textContent === "Conversation"))
      .toHaveLength(1)
    expect([...fixture.host.querySelectorAll("button")].filter((button) => button.textContent === "Read again"))
      .toHaveLength(1)
  }
})

/** The missing comments notice belongs to the existing index, before its available finding rows. */
it("keeps one Threads heading with the comments notice after filters and one retry", async () => {
  for (
    const reason of ["not_cached", "over_limit", "corrupt"] satisfies ReadonlyArray<
      Extract<ReviewWorkspace["conversations"], { readonly _tag: "Unavailable" }>["reason"]
    >
  ) {
    const fixture = await mountFixture(createElement(ReviewWorkspaceView, {
      ...defaults,
      workspace: { ...workspace, conversations: { _tag: "Unavailable", reason } }
    }))
    const headings = [...fixture.host.querySelectorAll("h2")].filter((h) => h.textContent === "Threads")
    expect(headings).toHaveLength(1)
    const filters = fixture.host.querySelector("[aria-label=\"Thread list filters\"]")
    const index = filters?.closest("section")
    const notice = index?.querySelector("[data-review-threads-fallback]")
    expect(notice).not.toBeNull()
    expect(filters?.nextElementSibling).toBe(notice)
    expect(notice?.querySelector("button")?.textContent).toBe("Read again")
    expect(index?.textContent).toContain("Recorded claim")
    expect(index?.textContent).not.toContain("All 0")
    expect([...fixture.host.querySelectorAll("button")].filter((b) => b.textContent === "Read again")).toHaveLength(1)
  }
})

/** Outdated placement is recorded; only Review's separate card receives the fallback presentation. */
it("marks only recorded outdated discussions without changing Conversation or current anchors", async () => {
  const review = await mountFixture(createElement(ReviewWorkspaceView, defaults))
  const outdated = review.host.querySelector("article[data-review-thread-outdated]")
  expect(outdated).not.toBeNull()
  expect(outdated?.parentElement?.querySelector(":scope > [data-code-review-diff]")).not.toBeNull()
  expect(outdated?.querySelector("[data-review-thread-status=outdated]")?.textContent).toBe("Outdated")
  expect(outdated?.textContent).toContain("Recorded human comment")

  const current = await mountFixture(createElement(ReviewWorkspaceView, {
    ...defaults,
    workspace: {
      ...workspace,
      conversations: {
        ...workspace.conversations,
        threads: [{ ...human, anchor: { ...human.anchor, outdated: false } }]
      }
    }
  }))
  expect(current.host.querySelector("article[data-review-thread-outdated]")).toBeNull()
  expect(current.host.textContent).toContain("Recorded human comment")

  const conversation = await mountFixture(
    createElement(ReviewWorkspaceView, { ...defaults, presentation: "conversation" })
  )
  const feed = conversation.host.querySelector("article[data-review-thread-outdated]")
  expect(feed).not.toBeNull()
  expect(feed?.parentElement?.querySelector(":scope > [data-code-review-diff]")).toBeNull()
  expect(feed?.textContent).toContain("Recorded human comment")
})
