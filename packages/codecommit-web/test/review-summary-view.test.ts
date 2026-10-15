// @vitest-environment happy-dom
import { expect, expectTypeOf, it } from "@effect/vitest"

import { ReviewRun, type ReviewThread, reviewWorkspaceThreads, ThreadsConflict } from "@knpkv/review"
import { DateTime, Option, Result, Schema } from "effect"
import { createElement } from "react"
import { ReviewSummaryView, type ReviewSummaryViewProps } from "../src/client/components/review-summary-view.js"
import { mountFixture } from "./pr-view-fixtures.js"

const identity = {
  namespace: "codecommit",
  subjectId: "opaque-pr",
  revisionId: "revision-1",
  baseRevision: "base",
  headRevision: "head"
}
const viewerZone = Option.getOrThrow(DateTime.zoneMakeNamed("UTC"))
it("requires a validated named zone, with an explicit refusal for invalid settings", () => {
  expect(Option.isNone(DateTime.zoneMakeNamed("Invalid/ViewerZone"))).toBe(true)
  expectTypeOf<NonNullable<ReviewSummaryViewProps["timeZone"]>>().toEqualTypeOf<DateTime.TimeZone.Named>()
})
const finding = (severity: "P0" | "P1" | "P2" | "P3" | "P4"): ReviewThread => ({
  id: severity,
  source: "agent",
  anchor: { _tag: "Unanchored" },
  resolved: false,
  messages: [],
  finding: {
    severity,
    axis: null,
    confidence: null,
    claim: `Recorded ${severity} finding`,
    summary: null,
    why: "Recorded reason",
    recommendation: "Recorded recommendation",
    verification: "Recorded verification",
    requirement: null,
    patch: null,
    disposition: { _tag: "Open" }
  }
})
const run = Schema.decodeUnknownSync(ReviewRun)({
  id: "recorded-run",
  identity,
  kind: "review",
  completedAt: Date.parse("2026-10-05T14:02:00Z"),
  summary: "The draft key can restore another agent’s text, and reconnect retries have no upper bound.",
  explanation: null,
  risks: null,
  focus: null,
  rules: null,
  profile: {
    id: "review-profile",
    name: "Saved review profile",
    kind: "review",
    provider: "claude",
    harness: "native-claude",
    model: "Opus",
    skillIds: []
  },
  threads: [finding("P0"), finding("P1"), finding("P2"), finding("P3"), finding("P4")]
})
const joined = (value: ReviewRun) =>
  reviewWorkspaceThreads({
    identity,
    observedAt: value.completedAt,
    checks: { _tag: "Unknown" },
    run: { _tag: "Ready", run: value },
    conversations: { _tag: "Ready", observedAt: value.completedAt, threads: [] }
  })

it("keeps the legacy verdict verbatim, counts separately, and never invents approval or missing fields", async () => {
  const fixture = await mountFixture(
    createElement(ReviewSummaryView, { run, threads: joined(run), timeZone: viewerZone })
  )
  expect(fixture.host.querySelector("blockquote p")?.textContent).toBe(run.summary)
  expect([...fixture.host.querySelectorAll("dt")].map((item) => item.textContent)).toEqual(["P0", "P1", "P2 and below"])
  expect([...fixture.host.querySelectorAll("dd")].map((item) => item.textContent)).toEqual(["1", "1", "3"])
  expect(fixture.host.textContent).toContain("Agent review, not an approval")
  expect(fixture.host.textContent).toContain("Saved review profile, Claude Code, Opus, Code review")
  expect(fixture.host.querySelector("time")?.textContent).toBe("14:02")
  expect(fixture.host.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-05T14:02:00.000Z")
  expect(fixture.host.querySelector("button, input, textarea, a")).toBeNull()
  for (const absent of ["What changed", "By axis", "Confidence", "Risks", "Fix all", "Approve", "Post", "Rules"]) {
    expect(fixture.host.textContent).not.toContain(absent)
  }
})

it("hides every count for conflicting threads while keeping the recorded verdict and provenance", async () => {
  const fixture = await mountFixture(createElement(ReviewSummaryView, {
    run,
    threads: Result.fail(new ThreadsConflict({ source: "agent", id: "private-conflict" })),
    timeZone: viewerZone
  }))
  expect(fixture.host.querySelector("dl")).toBeNull()
  expect(fixture.host.textContent).not.toContain("By severity")
  expect(fixture.host.querySelector("blockquote p")?.textContent).toBe(run.summary)
  expect(fixture.host.textContent).toContain("Reviewed 14:02, head head")
  expect(fixture.host.textContent).not.toContain("private-conflict")
})

it("does not make up a reviewer or engine when their recorded profile is absent", async () => {
  const value = { ...run, kind: "security", profile: null } satisfies ReviewRun
  const fixture = await mountFixture(
    createElement(ReviewSummaryView, { run: value, threads: joined(value), timeZone: viewerZone })
  )
  expect(fixture.host.textContent).toContain("Security review")
  expect(fixture.host.textContent).not.toContain("Saved review profile")
  expect(fixture.host.textContent).not.toContain("Claude Code")
  expect(fixture.host.querySelector("img, svg")).toBeNull()
})

it("preserves Explain output without presenting an empty finding count as a review verdict", async () => {
  const value = {
    ...run,
    kind: "explain",
    profile: null,
    explanation: "Recorded change explanation.",
    threads: []
  } satisfies ReviewRun
  const fixture = await mountFixture(
    createElement(ReviewSummaryView, { run: value, threads: joined(value), timeZone: viewerZone })
  )
  expect(fixture.host.textContent).toContain("Recorded change explanation.")
  expect(fixture.host.querySelector("blockquote p")?.textContent).toBe(run.summary)
  expect(fixture.host.querySelector("dl")).toBeNull()
  expect(fixture.host.querySelector("button")).toBeNull()
})

/** Empty verdicts must not draw quote punctuation or reserve a line before recorded Explain prose. */
it("renders recorded explanation paragraphs without an empty verdict while keeping a nonempty verdict verbatim", async () => {
  const explanation = "First recorded paragraph.\n\nSecond recorded paragraph.\n\nThird recorded paragraph."
  const empty = { ...run, kind: "explain", summary: "", explanation } satisfies ReviewRun
  const fixture = await mountFixture(createElement(ReviewSummaryView, { run: empty, threads: joined(empty) }))
  expect(fixture.host.querySelector("blockquote")).toBeNull()
  expect(
    [...(fixture.host.querySelector("h3")?.parentElement?.children ?? [])]
      .filter((element) => element.tagName === "P")
      .map((paragraph) => paragraph.textContent)
  ).toEqual(explanation.split("\n\n"))
  expect(fixture.host.textContent).toContain("Agent review, not an approval")
  await fixture.render(
    createElement(ReviewSummaryView, { run: { ...empty, summary: run.summary }, threads: joined(empty) })
  )
  expect(fixture.host.querySelector("blockquote p")?.textContent).toBe(run.summary)
})
