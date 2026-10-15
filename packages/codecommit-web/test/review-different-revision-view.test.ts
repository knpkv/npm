// @vitest-environment happy-dom
import { expect, expectTypeOf, it } from "@effect/vitest"

import type { ReviewRun, ReviewRunWorkspaceReading, ReviewThread } from "@knpkv/review"
import { createElement } from "react"
import {
  ReviewDifferentRevisionView,
  type ReviewDifferentRevisionViewProps
} from "../src/client/components/review-different-revision-view.js"
import { mountFixture } from "./pr-view-fixtures.js"

const identity = {
  namespace: "codecommit",
  subjectId: "opaque-reference",
  revisionId: "revision-1",
  baseRevision: "base-1",
  headRevision: "a1b2c3d"
}
const finding = {
  id: "finding-1",
  source: "agent",
  anchor: { _tag: "Unanchored" },
  resolved: false,
  messages: [],
  finding: {
    severity: "P1",
    axis: null,
    confidence: null,
    claim: "Recorded finding",
    summary: null,
    why: "Recorded reason",
    recommendation: "",
    verification: "",
    requirement: null,
    patch: null,
    disposition: { _tag: "Open" }
  }
} satisfies ReviewThread
const run = {
  id: "run-1",
  identity,
  profile: null,
  kind: "review",
  completedAt: 900,
  summary: "Recorded verdict",
  explanation: null,
  risks: null,
  focus: null,
  rules: null,
  threads: [finding]
} satisfies ReviewRun
const text =
  "This recorded review doesn’t match the current diff. Findings are shown separately from current diff lines."

it("accepts only DifferentRevision and states two changed heads without an ancestry or action claim", async () => {
  expectTypeOf<ReviewDifferentRevisionViewProps["reading"]>().toEqualTypeOf<
    Extract<ReviewRunWorkspaceReading, { readonly _tag: "DifferentRevision" }>
  >()
  const reading = {
    _tag: "DifferentRevision",
    run,
    current: { ...identity, headRevision: "e7f8a9b" }
  } satisfies ReviewDifferentRevisionViewProps["reading"]
  const fixture = await mountFixture(createElement(ReviewDifferentRevisionView, { reading }))
  expect(fixture.host.querySelector("[role=\"status\"]")?.textContent).toContain("Review is for a different revision")
  expect(fixture.host.querySelector("p")?.textContent).toBe(`${text} Reviewed a1b2c3d; the branch is now at e7f8a9b.`)
  expect(fixture.host.textContent).not.toContain("New commits")
  expect(fixture.host.querySelector("button, a, input, textarea")).toBeNull()
})

it("uses the universal caution for base-only, revision-only and absent-base differences with no false head sentence", async () => {
  const fixture = await mountFixture(createElement("div"))
  for (
    const current of [
      { ...identity, baseRevision: "base-2" },
      { ...identity, revisionId: "revision-2" },
      { ...identity, baseRevision: null }
    ]
  ) {
    await fixture.render(
      createElement(ReviewDifferentRevisionView, { reading: { _tag: "DifferentRevision", run, current } })
    )
    expect(fixture.host.textContent).toContain("Review is for a different revision")
    expect(fixture.host.querySelector("p")?.textContent).toBe(text)
    expect(fixture.host.textContent).not.toContain("the branch is now at")
    expect(fixture.host.querySelector("button, a")).toBeNull()
  }
})

it("keeps a clean or Explain mismatch visible without claiming absent findings are shown elsewhere", async () => {
  const fixture = await mountFixture(createElement("div"))
  for (
    const value of [
      { ...run, threads: [] },
      { ...run, kind: "explain", explanation: "Recorded explanation", threads: [] }
    ] satisfies ReadonlyArray<ReviewRun>
  ) {
    await fixture.render(createElement(ReviewDifferentRevisionView, {
      reading: { _tag: "DifferentRevision", run: value, current: { ...identity, headRevision: "e7f8a9b" } }
    }))
    expect(fixture.host.textContent).toContain("Review is for a different revision")
    expect(fixture.host.querySelector("p")?.textContent).toBe(
      "This recorded review doesn’t match the current diff. Reviewed a1b2c3d; the branch is now at e7f8a9b."
    )
    expect(fixture.host.textContent).not.toContain("Findings are shown")
  }
})
