import { expect, it } from "@effect/vitest"
import { canonicalCodeSelection } from "../src/code-selection.js"

it("preserves exact opaque targets and queue selectors", () => {
  const ref = "00000000-0000-4000-8000-000000000001"
  const result = canonicalCodeSelection(
    new URLSearchParams(`filter=all&search=example&offset=50&ref=${ref}&file=2`),
    "diffs"
  )
  expect(result.selection).toEqual({ filter: "all", search: "example", offset: 50, ref, file: 2 })
  expect(result.repaired).toBe(false)
})

it("repairs malformed selectors independently and drops another module's query", () => {
  const result = canonicalCodeSelection(
    new URLSearchParams("filter=all&offset=-1&search=example&approvalHost=ALPHA&ref=raw-locator&file=1000"),
    "pull-requests"
  )
  expect(result.selection).toEqual({ filter: "all", search: "example", offset: 0, ref: null, file: null })
  expect(result.repaired).toBe(true)
  expect(result.search.toString()).toBe("filter=all&search=example&offset=0")
})

it("refuses ambiguous duplicates and uses cached approvals as the Reviews default", () => {
  const result = canonicalCodeSelection(
    new URLSearchParams("filter=open&filter=all&search=a&search=b&offset=50&offset=100"),
    "reviews"
  )
  expect(result.selection).toEqual({ filter: "reviews", search: "", offset: 0, ref: null, file: null })
  expect(result.repaired).toBe(true)
})

it("never requests a file without a target or retains a file on a summary page", () => {
  for (const page of ["pull-requests", "diffs"] satisfies ReadonlyArray<"pull-requests" | "diffs">) {
    expect(canonicalCodeSelection(new URLSearchParams("file=1"), page).selection.file).toBeNull()
  }
})
