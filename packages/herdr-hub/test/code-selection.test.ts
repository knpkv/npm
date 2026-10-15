import { expect, it } from "@effect/vitest"
import { canonicalCodeSelection, codeSelectionForReference } from "../src/code-selection.js"

it("preserves exact opaque targets and queue selectors", () => {
  const ref = "00000000-0000-4000-8000-000000000001"
  const result = canonicalCodeSelection(
    new URLSearchParams(`filter=all&search=example&offset=50&ref=${ref}&file=2`),
    "diffs"
  )
  expect(result.selection).toEqual({
    filter: "all",
    search: "example",
    offset: 50,
    ref,
    file: 2,
    view: "review",
    thread: null
  })
  expect(result.repaired).toBe(false)
})

it("repairs malformed selectors independently and drops another module's query", () => {
  const result = canonicalCodeSelection(
    new URLSearchParams("filter=all&offset=-1&search=example&approvalHost=ALPHA&ref=raw-locator&file=1000"),
    "pull-requests"
  )
  expect(result.selection).toEqual({
    filter: "all",
    search: "example",
    offset: 0,
    ref: null,
    file: null,
    view: "review",
    thread: null
  })
  expect(result.repaired).toBe(true)
  expect(result.search.toString()).toBe("filter=all&search=example&offset=0")
})

it("refuses ambiguous duplicates and uses cached approvals as the Reviews default", () => {
  const result = canonicalCodeSelection(
    new URLSearchParams("filter=open&filter=all&search=a&search=b&offset=50&offset=100"),
    "reviews"
  )
  expect(result.selection).toEqual({
    filter: "reviews",
    search: "",
    offset: 0,
    ref: null,
    file: null,
    view: "review",
    thread: null
  })
  expect(result.repaired).toBe(true)
})

it("keeps a valid review view and source/id target under the opaque PR and exact Code page", () => {
  const ref = "00000000-0000-4000-8000-000000000001"
  const thread = { source: "agent", id: "finding]#\"雪 /" }
  const query = new URLSearchParams({
    filter: "all",
    search: "example",
    offset: "50",
    ref,
    view: "conversation",
    thread: JSON.stringify(thread)
  })
  for (
    const page of ["pull-requests", "reviews", "diffs"] satisfies ReadonlyArray<"pull-requests" | "reviews" | "diffs">
  ) {
    const result = canonicalCodeSelection(query, page)
    expect(result.selection.ref).toBe(ref)
    expect(result.selection.view).toBe("conversation")
    expect(result.selection.thread).toEqual(thread)
    expect(result.search.get("thread")).toBe(JSON.stringify(thread))
    expect(result.search.get("view")).toBe("conversation")
  }
})

it("repairs review view and target independently, preserving valid queue/ref selectors", () => {
  const ref = "00000000-0000-4000-8000-000000000001"
  const valid = { source: "codecommit", id: "comment-1" }
  for (
    const target of [
      "not-json",
      JSON.stringify({ ...valid, id: "" }),
      JSON.stringify({ ...valid, source: "other" }),
      JSON.stringify({ ...valid, extra: "refused" }),
      JSON.stringify({ ...valid, id: "x".repeat(257) })
    ]
  ) {
    const result = canonicalCodeSelection(
      new URLSearchParams({
        filter: "all",
        search: "example",
        offset: "50",
        ref,
        view: "conversation",
        thread: target
      }),
      "pull-requests"
    )
    expect(result.selection).toEqual({
      filter: "all",
      search: "example",
      offset: 50,
      ref,
      file: null,
      view: "conversation",
      thread: null
    })
    expect(result.repaired).toBe(true)
  }
  const badView = canonicalCodeSelection(
    new URLSearchParams({ ref, view: "invalid", thread: JSON.stringify(valid) }),
    "pull-requests"
  )
  expect(badView.selection.thread).toEqual(valid)
  expect(badView.selection.view).toBe("review")
  expect(badView.repaired).toBe(true)
  for (const target of [null, "raw-provider-locator"]) {
    const query = new URLSearchParams({ view: "guide", thread: JSON.stringify(valid) })
    if (target !== null) query.set("ref", target)
    const result = canonicalCodeSelection(query, "pull-requests")
    expect(result.selection.view).toBe("review")
    expect(result.selection.thread).toBeNull()
    expect(result.repaired).toBe(true)
  }
})

it("refuses duplicated review selectors independently without dropping a valid view or target", () => {
  const ref = "00000000-0000-4000-8000-000000000001"
  const thread = { source: "agent", id: "finding-1" }
  const duplicateThread = new URLSearchParams({ ref, view: "conversation", thread: JSON.stringify(thread) })
  duplicateThread.append("thread", JSON.stringify(thread))
  const result = canonicalCodeSelection(duplicateThread, "pull-requests")
  expect(result.selection.view).toBe("conversation")
  expect(result.selection.thread).toBeNull()
  expect(result.repaired).toBe(true)
  const duplicateView = new URLSearchParams({ ref, view: "conversation", thread: JSON.stringify(thread) })
  duplicateView.append("view", "guide")
  const next = canonicalCodeSelection(duplicateView, "pull-requests")
  expect(next.selection.view).toBe("review")
  expect(next.selection.thread).toEqual(thread)
  expect(next.repaired).toBe(true)
})

it("resets review selectors only when a PR transition changes the subject", () => {
  const ref = "00000000-0000-4000-8000-000000000001"
  const target = "00000000-0000-4000-8000-000000000002"
  const query = new URLSearchParams({
    ref,
    view: "conversation",
    thread: JSON.stringify({ source: "agent", id: "F1" })
  })
  const selection = canonicalCodeSelection(query, "pull-requests").selection
  expect(codeSelectionForReference(selection, ref)).toEqual(selection)
  expect(codeSelectionForReference(selection, target)).toEqual({
    ...selection,
    ref: target,
    view: "review",
    thread: null
  })
})

it("repairs uninstalled Guide only through the shared boundary without losing valid subject or diff context", () => {
  const ref = "00000000-0000-4000-8000-000000000001"
  const result = canonicalCodeSelection(
    new URLSearchParams({
      filter: "all",
      search: "example",
      offset: "50",
      ref,
      file: "2",
      view: "guide",
      thread: JSON.stringify({ source: "agent", id: "F1" })
    }),
    "diffs"
  )
  expect(result.selection).toEqual({
    filter: "all",
    search: "example",
    offset: 50,
    ref,
    file: 2,
    view: "review",
    thread: null
  })
  expect(result.search.has("view")).toBe(false)
  expect(result.search.has("thread")).toBe(false)
  expect(result.repaired).toBe(true)
})

it("never requests a file without a target", () => {
  for (const page of ["pull-requests", "diffs"] satisfies ReadonlyArray<"pull-requests" | "diffs">) {
    expect(canonicalCodeSelection(new URLSearchParams("file=1"), page).selection.file).toBeNull()
  }
})
