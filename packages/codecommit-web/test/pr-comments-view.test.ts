// @vitest-environment happy-dom
import { describe, expect, it, vi } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { createElement } from "react"
import { PRCommentsView, type PRCommentsViewProps } from "../src/client/components/pr-comments-view.js"
import { reviewCommentNavigationTarget } from "../src/client/review-comment-navigation.js"
import { click, makeLocation, mountFixture, now } from "./pr-view-fixtures.js"

const props = (): PRCommentsViewProps => ({
  comments: AsyncResult.success([]),
  navigation: null,
  now,
  visible: false,
  onCountChange: vi.fn(),
  onNavigateToDiff: vi.fn()
})
describe("PRCommentsView", () => {
  it("renders initial, failure and empty conversation states from supplied results", async () => {
    const inputs = props()
    const fixture = await mountFixture(createElement(PRCommentsView, { ...inputs, comments: AsyncResult.initial() }))
    expect(fixture.host.textContent).toContain("Loading comments")
    await fixture.render(
      createElement(PRCommentsView, {
        ...inputs,
        comments: AsyncResult.failure<ReadonlyArray<ReturnType<typeof makeLocation>>>(Cause.die("Unavailable"))
      })
    )
    expect(fixture.host.textContent).toContain("Comments unavailable")
    await fixture.render(createElement(PRCommentsView, inputs))
    expect(fixture.host.textContent).toContain("No comments")
    expect(inputs.onCountChange).toHaveBeenCalledWith({ commentIds: [], count: 0 })
  })

  it("sanitizes Markdown and reports deleted subtrees in counts and IDs while keeping them invisible", async () => {
    const inputs = props()
    const location = makeLocation({
      comments: [
        {
          root: {
            id: "visible",
            author: "reviewer",
            content: "**Safe copy** [unsafe](javascript:alert(1)) <script>bad()</script>",
            creationDate: "2026-10-05T12:30:00Z",
            deleted: false
          },
          replies: []
        },
        {
          root: {
            id: "deleted",
            author: "reviewer",
            content: "Deleted root",
            creationDate: "2026-10-04T12:00:00Z",
            deleted: true
          },
          replies: [{
            root: {
              id: "hidden-reply",
              author: "contributor",
              content: "Hidden reply",
              creationDate: "2026-10-04T13:00:00Z",
              deleted: false
            },
            replies: []
          }]
        }
      ]
    })
    const { host, render } = await mountFixture(
      createElement(PRCommentsView, { ...inputs, comments: AsyncResult.success([location]) })
    )
    expect(host.querySelector("strong")?.textContent).toBe("reviewer")
    expect(host.textContent).toContain("Safe copy")
    expect(host.querySelector("a[href^=\"javascript:\"]")).toBeNull()
    expect(host.querySelector("script")).toBeNull()
    expect(host.textContent).not.toContain("Deleted root")
    expect(host.textContent).not.toContain("Hidden reply")
    expect(host.querySelector("time")?.textContent).toContain("3h ago")
    expect(inputs.onCountChange).toHaveBeenCalledWith({ commentIds: ["deleted", "hidden-reply", "visible"], count: 3 })
    await render(createElement(PRCommentsView, { ...inputs, comments: AsyncResult.success([location]), visible: true }))
    expect(inputs.onCountChange).toHaveBeenCalledOnce()
  })

  it("repeated diff jumps preserve immutable coordinates and active comments focus only when visible", async () => {
    const location = makeLocation()
    const thread = location.comments[0]
    expect(thread).toBeDefined()
    if (thread === undefined) return
    const target = reviewCommentNavigationTarget(location, thread.root)
    expect(target).not.toBeNull()
    if (target === null) return
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined)
    const inputs = {
      ...props(),
      comments: AsyncResult.success([location]),
      navigation: { destination: "comment", requestId: 1, target }
    } satisfies PRCommentsViewProps
    const { host, render } = await mountFixture(createElement(PRCommentsView, inputs))
    expect(scroll).not.toHaveBeenCalled()
    await render(createElement(PRCommentsView, { ...inputs, visible: true }))
    expect(document.activeElement).toBe(host.querySelector("article"))
    expect(scroll).toHaveBeenCalledOnce()
    await click(host, "View in diff")
    await click(host, "View in diff")
    expect(inputs.onNavigateToDiff).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        beforeCommitId: "base",
        afterCommitId: "head",
        filePath: "src/retry.ts",
        lineNumber: 12,
        side: "after",
        commentId: "c1"
      })
    )
    expect(inputs.onNavigateToDiff).toHaveBeenNthCalledWith(2, target)
    scroll.mockRestore()
  })
})
