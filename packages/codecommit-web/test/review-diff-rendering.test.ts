// @vitest-environment happy-dom
import { expect, it } from "@effect/vitest"
import type { CurrentReviewRunReading, ReviewThread } from "@knpkv/review"
import { PatchDiffView } from "@knpkv/rly/diff/patch"
import { Result } from "effect"
import { createElement } from "react"
import { ReviewFindingCard } from "../src/client/components/review-finding-card.js"
import { parseReviewDiffFile } from "../src/client/review-diff-file.js"
import { placeCurrentReviewFindings } from "../src/client/review-diff-placement.js"
import { mountFixture } from "./pr-view-fixtures.js"

const identity = {
  namespace: "codecommit",
  subjectId: "opaque-reference",
  revisionId: "revision-1",
  baseRevision: "base-1",
  headRevision: "head-1"
}
const finding = {
  severity: "P1",
  axis: null,
  confidence: null,
  claim: "Inline recorded finding",
  summary: null,
  why: "Recorded evidence",
  recommendation: "",
  verification: "",
  requirement: null,
  patch: null,
  disposition: { _tag: "Open" }
} satisfies NonNullable<ReviewThread["finding"]>
const threads = [
  {
    id: "second-file",
    source: "agent",
    finding,
    anchor: { _tag: "Line", path: "second.ts", side: "after", line: 1, outdated: false },
    resolved: false,
    messages: []
  },
  {
    id: "no-line",
    source: "agent",
    finding: { ...finding, claim: "Unplaced recorded finding" },
    anchor: { _tag: "Line", path: "second.ts", side: "after", line: 99, outdated: false },
    resolved: false,
    messages: []
  }
] satisfies ReadonlyArray<ReviewThread>
const reading = {
  _tag: "Current",
  run: {
    id: "run",
    identity,
    kind: "review",
    profile: null,
    completedAt: 1_000,
    summary: "Recorded verdict",
    explanation: null,
    risks: null,
    focus: null,
    rules: null,
    threads
  }
} satisfies CurrentReviewRunReading

it("renders the same parsed files used for placement with one inline target and one global fallback", async () => {
  const files = ["first.ts", "second.ts"].map((path, index) => ({
    index,
    result: parseReviewDiffFile(
      { index, path, status: "modified", previousPath: null, beforeMode: "100644", afterMode: "100644" },
      "revision-1",
      { revisionId: "revision-1", fileIndex: index, state: "text", before: "old\n", after: "new\n" }
    )
  }))
  expect(files.every(({ result }) => Result.isSuccess(result))).toBe(true)
  const parsed = files.flatMap(({ index, result }) => Result.isSuccess(result) ? [{ index, file: result.success }] : [])
  const placement = placeCurrentReviewFindings(reading, { identity, files: parsed })
  expect(Result.isSuccess(placement)).toBe(true)
  if (Result.isFailure(placement)) return
  const before = JSON.stringify(parsed)
  const fixture = await mountFixture(
    createElement(
      "div",
      null,
      ...parsed.map(({ file, index }) =>
        createElement(PatchDiffView, {
          key: index,
          id: `file-${index}`,
          file,
          mode: "stacked",
          renderAnnotation: (side, line) =>
            placement.success.placed.filter((row) => row.fileIndex === index && row.side === side && row.line === line)
              .map(({ row }) => createElement(ReviewFindingCard, { key: row.thread.id, row, scope: "recorded-diff" }))
        })
      ),
      createElement(
        "section",
        { "data-fallback": true },
        ...placement.success.unplaced.map((row) =>
          createElement(ReviewFindingCard, { key: row.thread.id, row, scope: "recorded-diff" })
        )
      )
    )
  )
  const inline = fixture.host.querySelector("[data-rly-patch-diff] article")
  expect(inline?.querySelector("h3")?.textContent).toBe("Inline recorded finding")
  expect(inline?.closest("table")?.getAttribute("aria-label")).toBe("Changes in second.ts")
  expect(fixture.host.querySelector("[data-fallback] article h3")?.textContent).toBe("Unplaced recorded finding")
  expect(fixture.host.querySelectorAll("article")).toHaveLength(2)
  const targets = [...fixture.host.querySelectorAll("article[id]")].map((element) => element.id)
  expect(new Set(targets).size).toBe(threads.length)
  expect(JSON.stringify(parsed)).toBe(before)
})
