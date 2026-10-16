import type { CodeReviewThreadTarget } from "@knpkv/codecommit-web/host"
import { expect, it, vi } from "vitest"
import { makeCodeReviewNavigation } from "../src/code-review-navigation.js"
import { canonicalCodeSelection } from "../src/code-selection.js"
import { codeModule } from "../src/module-contract.js"
import { readModuleRoute } from "../src/module-navigation.js"
import type { ModulePageMount } from "../src/modules.js"

const ref = "00000000-0000-4000-8000-000000000001"
const thread = { source: "agent", id: "finding]#\"雪 /" } satisfies CodeReviewThreadTarget

it("keeps each exact Code route, queue/ref and complete source/id while switching finding links to Review", () => {
  for (
    const page of ["pull-requests", "reviews", "diffs"] satisfies ReadonlyArray<"pull-requests" | "reviews" | "diffs">
  ) {
    const prior = canonicalCodeSelection(
      new URLSearchParams({ filter: "all", search: "example", offset: "50", ref, view: "conversation" }),
      page
    )
    const before = JSON.stringify(prior.selection)
    const navigate = vi.fn<ModulePageMount["navigate"]>()
    const adapter = makeCodeReviewNavigation({ page, selection: { ...prior.selection, ref }, navigate })
    const href = adapter.hrefForThread(thread)
    const url = new URL(href, "https://hub.invalid/")
    expect(url.hash).toBe(`#code/${page}`)
    expect(readModuleRoute(url, [codeModule])).toEqual(
      expect.objectContaining({ _tag: "Success", success: { module: "code", page } })
    )
    expect(url.searchParams.get("ref")).toBe(ref)
    expect(url.searchParams.get("filter")).toBe(prior.selection.filter)
    expect(url.searchParams.get("search")).toBe("example")
    expect(url.searchParams.get("offset")).toBe("50")
    const next = canonicalCodeSelection(url.searchParams, page)
    expect(next.selection.view).toBe("review")
    expect(next.selection.thread).toEqual(thread)
    expect(next.repaired).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
    adapter.onOpenThread(thread)
    expect(navigate).toHaveBeenCalledExactlyOnceWith(href, "push", null)
    expect(JSON.stringify(prior.selection)).toBe(before)
  }
})

it("projects only source/id from a full structural thread, keeping message/finding content out of the URL", () => {
  const selection = canonicalCodeSelection(new URLSearchParams({ ref }), "pull-requests").selection
  const adapter = makeCodeReviewNavigation({
    page: "pull-requests",
    selection: { ...selection, ref },
    navigate: () => {}
  })
  const fullThread = {
    ...thread,
    messages: [{ text: "Recorded private prose" }],
    finding: { claim: "Recorded private claim" }
  }
  const url = new URL(adapter.hrefForThread(fullThread), "https://hub.invalid/")
  expect(url.searchParams.get("thread")).toBe(JSON.stringify(thread))
  expect(url.href).not.toContain("private")
  expect(canonicalCodeSelection(url.searchParams, "pull-requests").selection.thread).toEqual(thread)
})

it("reactivates an already-selected finding without pushing the same canonical URL again", () => {
  const selection = canonicalCodeSelection(
    new URLSearchParams({ ref, file: "1", thread: JSON.stringify(thread) }),
    "pull-requests"
  ).selection
  const navigate = vi.fn<ModulePageMount["navigate"]>()
  const adapter = makeCodeReviewNavigation({ page: "pull-requests", selection: { ...selection, ref }, navigate })
  adapter.onOpenThread(thread)
  expect(navigate).not.toHaveBeenCalled()
  const other = { source: "agent", id: "another-finding" } satisfies CodeReviewThreadTarget
  adapter.onOpenThread(other)
  expect(navigate).toHaveBeenCalledExactlyOnceWith(adapter.hrefForThread(other), "push", null)
})
