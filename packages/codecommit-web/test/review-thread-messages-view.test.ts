// @vitest-environment happy-dom
import { expect, it } from "@effect/vitest"
import type { ReviewMessage } from "@knpkv/review"
import { DateTime, Option } from "effect"
import { createElement } from "react"
import { ReviewThreadMessagesView } from "../src/client/components/review-thread-messages-view.js"
import { mountFixture } from "./pr-view-fixtures.js"

const timeZone = Option.getOrThrow(DateTime.zoneMakeNamed("UTC"))
const root = {
  id: "root",
  author: "Reviewer",
  createdAt: Date.parse("2026-10-05T14:02:27Z"),
  text: "**Recorded** comment.",
  deleted: false
} satisfies ReviewMessage
const reply = {
  ...root,
  id: "reply",
  author: "Contributor",
  createdAt: Date.parse("2026-10-05T14:05:00Z"),
  text: "Live reply."
}

it("keeps a deleted root's author/time and live replies, without rendering retained deleted text as Markdown", async () => {
  const deleted = { ...root, deleted: true, text: "**Old deleted words**" }
  const fixture = await mountFixture(createElement(ReviewThreadMessagesView, { messages: [deleted, reply], timeZone }))
  const posts = [...fixture.host.querySelectorAll("[data-review-message-id]")]
  expect(posts).toHaveLength(2)
  expect(posts.map((post) => post.getAttribute("data-review-message-id"))).toEqual(["root", "reply"])
  expect(posts[0]?.textContent).toContain("Reviewer")
  expect(posts[0]?.textContent).toContain("14:02")
  expect(posts[0]?.querySelector("[data-deleted=\"true\"]")?.textContent).toBe("Comment deleted")
  expect(posts[0]?.textContent).not.toContain("Old deleted words")
  expect(posts[0]?.querySelector("blockquote, s, del, svg, img")).toBeNull()
  expect(posts[1]?.textContent).toContain("Contributor")
  expect(posts[1]?.textContent).toContain("Live reply.")
})

it("uses the shipped safe Markdown behavior and preserves literal code without executable HTML or URL schemes", async () => {
  const text =
    "**Evidence**\n\n`<script>literal</script>`\n\n<script>danger()</script>\n\n[unsafe](javascript:danger())"
  const fixture = await mountFixture(
    createElement(ReviewThreadMessagesView, { messages: [{ ...root, text }], timeZone })
  )
  expect(fixture.host.querySelector("p strong")?.textContent).toBe("Evidence")
  expect(fixture.host.querySelector("code")?.textContent).toBe("<script>literal</script>")
  expect(fixture.host.querySelector("script, [onerror], [onclick], a[href^='javascript:']")).toBeNull()
})

it("shows HH:MM with full date metadata in the validated viewer zone", async () => {
  const fixture = await mountFixture(createElement(ReviewThreadMessagesView, { messages: [root], timeZone }))
  const time = fixture.host.querySelector("time")
  expect(time?.textContent).toBe("14:02")
  expect(time?.getAttribute("datetime")).toBe("2026-10-05T14:02:27.000Z")
  expect(time?.title).toBe("5 Oct 2026, 14:02")
})

it("renders names/time/body only, with no avatar, placeholder, reply box or actions", async () => {
  const fixture = await mountFixture(createElement(ReviewThreadMessagesView, { messages: [root, reply], timeZone }))
  expect(fixture.host.querySelectorAll("[data-review-message-id]")).toHaveLength(2)
  expect(fixture.host.querySelector("button, input, textarea, form, img, svg")).toBeNull()
  expect(fixture.host.textContent).not.toContain("Reply")
  await fixture.render(createElement(ReviewThreadMessagesView, { messages: [], timeZone }))
  expect(fixture.host.childElementCount).toBe(0)
})
