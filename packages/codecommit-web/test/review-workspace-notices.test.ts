// @vitest-environment happy-dom
import { expect, it } from "@effect/vitest"
import type { ReviewWorkspace } from "@knpkv/review"
import { createElement, useRef, useState } from "react"
import { ReviewWorkspaceNotices } from "../src/client/components/review-workspace-notices.js"
import { click, mountFixture } from "./pr-view-fixtures.js"

const identity = {
  namespace: "codecommit",
  subjectId: "opaque-pr",
  revisionId: "revision-1",
  baseRevision: "base-1",
  headRevision: "head-1"
}
const ready: ReviewWorkspace = {
  identity,
  observedAt: 1_000,
  checks: { _tag: "Unknown" },
  run: { _tag: "NotRecorded" },
  conversations: { _tag: "Ready", observedAt: 1_000, threads: [] }
}

it("puts the single combined-failure retry in Threads, with message-only history", async () => {
  const fixture = await mountFixture(createElement("div"))
  for (
    const reason of ["not_cached", "over_limit", "corrupt"] satisfies ReadonlyArray<
      Extract<ReviewWorkspace["conversations"], { readonly _tag: "Unavailable" }>["reason"]
    >
  ) {
    const workspace: ReviewWorkspace = {
      ...ready,
      run: { _tag: "Unavailable", reason: "invalid" },
      conversations: { _tag: "Unavailable", reason }
    }
    await fixture.render(createElement(ReviewWorkspaceNotices, {
      workspace,
      presentation: "review",
      focusTarget: () => null,
      onReadAgain: () => {}
    }))
    const history = fixture.host.querySelector("[aria-label=\"Review summary\"]")
    const threads = fixture.host.querySelector("[aria-label=\"Threads\"]")
    expect(history?.textContent).toContain("The diff is still available.")
    expect(history?.querySelector("button")).toBeNull()
    expect(threads?.querySelector("button")?.textContent).toBe("Read again")
    expect(fixture.host.querySelectorAll("button")).toHaveLength(1)
    expect(fixture.host.textContent).not.toContain("All 0")
    await fixture.render(createElement(ReviewWorkspaceNotices, {
      workspace,
      presentation: "conversation",
      focusTarget: () => null,
      onReadAgain: () => {}
    }))
    expect(fixture.host.querySelector("[aria-label=\"Review summary\"]")?.textContent).toContain(
      "Review history unavailable"
    )
    expect(fixture.host.querySelector("[aria-label=\"Review summary\"] button")).toBeNull()
    expect(fixture.host.querySelectorAll("button")).toHaveLength(1)
    expect(fixture.host.querySelector("[aria-label=\"Conversation\"]")).not.toBeNull()
  }
})

it("keeps a history-only retry in the summary and missing history has no execution action", async () => {
  const fixture = await mountFixture(createElement(ReviewWorkspaceNotices, {
    workspace: { ...ready, run: { _tag: "Unavailable", reason: "io" } },
    presentation: "review",
    focusTarget: () => null,
    onReadAgain: () => {}
  }))
  expect(fixture.host.querySelector("[aria-label=\"Review summary\"] button")?.textContent).toBe("Read again")
  expect(fixture.host.querySelector("[aria-label=\"Threads\"]")).toBeNull()
  await fixture.render(createElement(ReviewWorkspaceNotices, {
    workspace: ready,
    presentation: "review",
    focusTarget: () => null,
    onReadAgain: () => {}
  }))
  expect(fixture.host.textContent).toBe("No agent review yet")
  expect(fixture.host.querySelector("button")).toBeNull()
})

it("keeps a conflict in the list slot without replacing a recorded verdict or exposing its keys", async () => {
  const human = {
    id: "private-conflicting-key",
    source: "codecommit",
    finding: null,
    resolved: false,
    anchor: { _tag: "Unanchored" },
    messages: []
  } satisfies Extract<ReviewWorkspace["conversations"], { readonly _tag: "Ready" }>["threads"][number]
  const workspace: ReviewWorkspace = {
    ...ready,
    run: {
      _tag: "Ready",
      run: {
        id: "recorded-run",
        identity,
        profile: null,
        kind: "review",
        completedAt: 950,
        summary: "Verbatim recorded verdict",
        explanation: null,
        risks: null,
        focus: null,
        rules: null,
        threads: []
      }
    },
    conversations: { _tag: "Ready", observedAt: 1_000, threads: [human, human] }
  }
  const fixture = await mountFixture(
    createElement(
      "div",
      null,
      createElement("p", null, workspace.run._tag === "Ready" ? workspace.run.run.summary : ""),
      createElement(ReviewWorkspaceNotices, {
        workspace,
        presentation: "review",
        focusTarget: () => null,
        onReadAgain: () => {}
      })
    )
  )
  expect(fixture.host.textContent).toContain("Verbatim recorded verdict")
  expect(fixture.host.textContent).toContain("Threads could not be combined")
  expect(fixture.host.textContent).not.toContain("private-conflicting-key")
  expect(fixture.host.querySelector("[aria-label=\"Review summary\"]")).toBeNull()
  expect(fixture.host.querySelectorAll("button")).toHaveLength(1)
})

it("moves the one retry to the actual retained, focusable host before Ready replaces both notices", async () => {
  let reads = 0
  const Harness = () => {
    const target = useRef<HTMLElement>(null)
    const [workspace, setWorkspace] = useState<ReviewWorkspace>({
      ...ready,
      run: { _tag: "Unavailable", reason: "invalid" },
      conversations: { _tag: "Unavailable", reason: "corrupt" }
    })
    return createElement(
      "section",
      { ref: target, tabIndex: -1, "aria-label": "Review workspace" },
      createElement(ReviewWorkspaceNotices, {
        workspace,
        presentation: "review",
        focusTarget: () => target.current,
        onReadAgain: () => {
          reads += 1
          setWorkspace(ready)
        }
      })
    )
  }
  const fixture = await mountFixture(createElement(Harness))
  const target = fixture.host.querySelector("[aria-label=\"Review workspace\"]")
  fixture.host.querySelector("button")?.focus()
  await click(fixture.host, "Read again")
  expect(reads).toBe(1)
  expect(target?.getAttribute("tabindex")).toBe("-1")
  expect(document.activeElement).toBe(target)
  expect(fixture.host.querySelector("button")).toBeNull()
  expect(fixture.host.textContent).toBe("No agent review yet")
})

it("keeps unreadable history message-only in Conversation with one feed retry and a retained focus target", async () => {
  let reads = 0
  const Harness = () => {
    const target = useRef<HTMLElement>(null)
    const [workspace, setWorkspace] = useState<ReviewWorkspace>({
      ...ready,
      run: { _tag: "Unavailable", reason: "io" }
    })
    return createElement(
      "section",
      { ref: target, tabIndex: -1, "aria-label": "Conversation feed" },
      createElement(ReviewWorkspaceNotices, {
        workspace,
        presentation: "conversation",
        focusTarget: () => target.current,
        onReadAgain: () => {
          reads += 1
          setWorkspace(ready)
        }
      })
    )
  }
  const fixture = await mountFixture(createElement(Harness))
  const feed = fixture.host.querySelector("[aria-label=\"Conversation feed\"]")
  const history = feed?.querySelector("[data-review-run-fallback=\"Unavailable\"]")
  expect(history).not.toBeNull()
  expect(history?.textContent).toContain("Review history unavailable")
  expect(history?.textContent).toContain("The diff and comments are still available.")
  expect(history?.querySelector("button")).toBeNull()
  expect(feed?.querySelectorAll("button")).toHaveLength(1)
  expect(feed?.querySelector("button")?.parentElement).toBe(feed)
  fixture.host.querySelector("button")?.focus()
  await click(fixture.host, "Read again")
  expect(reads).toBe(1)
  expect(document.activeElement).toBe(feed)
  expect(feed?.querySelector("button")).toBeNull()
  expect(fixture.host.textContent).not.toContain("No agent review yet")
})
