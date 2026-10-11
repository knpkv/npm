// @vitest-environment happy-dom
import { describe, expect, it } from "@effect/vitest"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { createElement } from "react"
import { PRLifecycleView } from "../src/client/components/pr-lifecycle-view.js"
import { makeLocation, makePullRequest, mountFixture } from "./pr-view-fixtures.js"

describe("PRLifecycleView", () => {
  it("retains merge, earliest review and mean feedback durations, including deleted threads", async () => {
    const pr = makePullRequest({ status: "MERGED", lastModifiedDate: new Date("2026-10-04T12:00:00Z") })
    const location = makeLocation({
      comments: [{
        root: {
          id: "review",
          author: "reviewer",
          content: "Deleted feedback",
          deleted: true,
          creationDate: "2026-10-03T14:00:00Z"
        },
        replies: [{
          root: {
            id: "reply",
            author: "contributor",
            content: "Addressed",
            deleted: false,
            creationDate: "2026-10-03T15:00:00Z"
          },
          replies: []
        }]
      }]
    })
    const { host } = await mountFixture(
      createElement("dl", null, createElement(PRLifecycleView, { pr, comments: AsyncResult.success([location]) }))
    )
    expect([...host.querySelectorAll("dt")].map((el) => el.textContent)).toEqual([
      "Time to merge",
      "Time to first review",
      "Time to address feedback"
    ])
    expect([...host.querySelectorAll("dd")].map((el) => el.textContent)).toEqual(["1d", "2h", "1h"])
  })

  it("uses a non-author sign-off as review fallback only when approval and approvers are known", async () => {
    const pr = makePullRequest({ approvedBy: ["reviewer"], lastModifiedDate: new Date("2026-10-03T16:00:00Z") })
    const comments = AsyncResult.success([])
    const { host, render } = await mountFixture(
      createElement("dl", null, createElement(PRLifecycleView, { pr, comments }))
    )
    expect(host.textContent).toBe("Time to first review4h")
    for (
      const overrides of [{ approvalUnknown: { _tag: "NotPermitted" } }, { approversUnknown: true }, {
        approvedBy: ["contributor"]
      }] satisfies ReadonlyArray<Parameters<typeof makePullRequest>[0]>
    ) {
      await render(
        createElement(
          "dl",
          null,
          createElement(PRLifecycleView, { pr: makePullRequest({ ...pr, ...overrides }), comments })
        )
      )
      expect(host.textContent).toBe("")
    }
    await render(createElement("dl", null, createElement(PRLifecycleView, { pr, comments: AsyncResult.initial() })))
    expect(host.textContent).toBe("")
  })
})
