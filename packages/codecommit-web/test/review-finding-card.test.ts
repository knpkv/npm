// @vitest-environment happy-dom
import { expect, it } from "@effect/vitest"
import { type ReviewDisposition, ReviewFinding, ReviewThread } from "@knpkv/review"
import { Schema } from "effect"
import { createElement } from "react"
import { ReviewFindingCard } from "../src/client/components/review-finding-card.js"
import { ReviewFindingsIndexView } from "../src/client/components/review-findings-index-view.js"
import { mountFixture } from "./pr-view-fixtures.js"

const finding = Schema.decodeUnknownSync(ReviewFinding)({
  severity: "P0",
  axis: null,
  confidence: null,
  claim: "Recorded whole-PR finding",
  summary: null,
  why: "Recorded evidence.",
  recommendation: "Recorded recommendation prose.",
  verification: "Recorded verification prose.",
  requirement: null,
  patch: null,
  disposition: { _tag: "Open" }
})
const thread = Schema.decodeUnknownSync(ReviewThread)({
  id: "finding-1",
  source: "agent",
  finding,
  anchor: { _tag: "Unanchored" },
  resolved: false,
  messages: []
})

it("shows the legacy general finding and all recorded prose without making recommendation executable", async () => {
  const fixture = await mountFixture(
    createElement(ReviewFindingCard, { scope: "workspace-card", row: { finding, thread } })
  )
  expect(fixture.host.querySelector("h3")?.textContent).toBe(finding.claim)
  expect(fixture.host.textContent).toContain("Whole pull request")
  expect([...fixture.host.querySelectorAll("h4")].map((element) => element.textContent)).toEqual([
    "Why",
    "Recommendation",
    "How to verify"
  ])
  for (const text of [finding.why, finding.recommendation, finding.verification]) {
    expect(fixture.host.textContent).toContain(text)
  }
  expect(fixture.host.querySelector("pre, button, a, input, textarea, img, svg")).toBeNull()
  for (const absent of ["Suggested patch", "confidence", "Apply", "Dismiss", "Resolve", "Standards", "Spec"]) {
    expect(fixture.host.textContent).not.toContain(absent)
  }
  expect(fixture.host.querySelector("article")?.tabIndex).toBe(-1)
})

it("keeps before-side/outdated anchors explicit without claiming an absent old revision", async () => {
  const anchor = {
    _tag: "Line",
    path: "src/example.ts",
    line: 12,
    side: "before",
    outdated: true
  } satisfies ReviewThread["anchor"]
  const fixture = await mountFixture(
    createElement(ReviewFindingCard, { scope: "workspace-card", row: { finding, thread: { ...thread, anchor } } })
  )
  expect(fixture.host.querySelector("header code")?.textContent).toBe("src/example.ts:12")
  expect(fixture.host.textContent).toContain("Before change")
  expect(fixture.host.textContent).toContain("Outdated")
  expect(fixture.host.textContent).not.toContain("line changed in")
})

it("preserves short summary and longer details under Why, without duplicating identical or empty prose", async () => {
  const fixture = await mountFixture(createElement("div"))
  for (
    const [summary, details, expected] of [
      ["Short summary.", "Longer evidence.", ["Short summary.", "Longer evidence."]],
      ["Same evidence.", "Same evidence.", ["Same evidence."]],
      ["Summary only.", "", ["Summary only."]]
    ] satisfies ReadonlyArray<readonly [string, string, ReadonlyArray<string>]>
  ) {
    const value = { ...finding, summary, why: details, recommendation: "", verification: "" }
    await fixture.render(
      createElement(ReviewFindingCard, {
        scope: "workspace-card",
        row: { finding: value, thread: { ...thread, finding: value } }
      })
    )
    expect(fixture.host.querySelector("h3")?.textContent).toBe(finding.claim)
    expect([...fixture.host.querySelectorAll("h4")].map((element) => element.textContent)).toEqual(["Why"])
    expect([...fixture.host.querySelectorAll("p")].map((element) => element.textContent)).toEqual(expected)
  }
})

it("shows only a real immutable suggested patch, keeping its head and path next to the literal text", async () => {
  const patch = {
    path: "src/example.ts",
    headRevision: "reviewed-head",
    text: "- old\n+ new\n<script>inert text</script>"
  }
  const value = { ...finding, patch, axis: "Security", confidence: "high" } satisfies ReviewFinding
  const anchor = { _tag: "File", path: patch.path, outdated: false } satisfies ReviewThread["anchor"]
  const fixture = await mountFixture(
    createElement(ReviewFindingCard, {
      scope: "workspace-card",
      row: { finding: value, thread: { ...thread, finding: value, anchor } }
    })
  )
  expect(fixture.host.querySelector("pre code")?.textContent).toBe(patch.text)
  expect(fixture.host.textContent).toContain("src/example.ts, head reviewed-head")
  expect(fixture.host.textContent).toContain("Security")
  expect(fixture.host.textContent).toContain("High confidence")
  expect([...fixture.host.querySelectorAll("article > header > *")].map((element) => element.textContent)).toEqual([
    "P0",
    "Security",
    "src/example.ts, High confidence"
  ])
  expect(fixture.host.querySelector("script, button")).toBeNull()
})

it("renders every recorded disposition with exact reason words and no invented actor or controls", async () => {
  const fixture = await mountFixture(createElement("div"))
  for (
    const [disposition, expected] of [
      [{ _tag: "Open" }, null],
      [{ _tag: "FixedVerify", commit: "d4e5f6a" }, "Fix pushed in d4e5f6a, waiting for re-review"],
      [{ _tag: "Resolved" }, "Resolved"],
      [
        { _tag: "Dismissed", reason: "false_positive", note: "Recorded evidence" },
        "Dismissed: False positive, ‘Recorded evidence’"
      ],
      [
        { _tag: "Dismissed", reason: "wont_fix", note: "covered by the retry cap" },
        "Dismissed: Won’t fix, ‘covered by the retry cap’"
      ],
      [{ _tag: "Dismissed", reason: "already_fixed", note: null }, "Dismissed: Already fixed elsewhere"],
      [{ _tag: "Dismissed", reason: "other", note: "" }, "Dismissed: Other"]
    ] satisfies ReadonlyArray<readonly [ReviewDisposition, string | null]>
  ) {
    const value = { ...finding, disposition }
    await fixture.render(
      createElement(ReviewFindingCard, {
        scope: "workspace-card",
        row: { finding: value, thread: { ...thread, finding: value } }
      })
    )
    expect(fixture.host.querySelector("[data-review-disposition]")?.textContent ?? null).toBe(expected)
    if (expected !== null) {
      const label = fixture.host.querySelector("[data-review-disposition]")
      expect(label?.querySelector("svg") !== null).toBe(
        disposition._tag === "FixedVerify" || disposition._tag === "Resolved" || disposition._tag === "Dismissed"
      )
      const status = fixture.host.querySelector("[data-review-disposition]")?.parentElement
      expect(status?.previousElementSibling?.tagName).toBe("HEADER")
      expect(status?.nextElementSibling?.tagName).toBe("H3")
    }
    expect(fixture.host.querySelector("button, input, a")).toBeNull()
    expect(fixture.host.textContent).not.toContain("Dismissed by")
    expect(fixture.host.textContent).not.toContain("Resolved by")
  }
})

it("keeps the recorded Requirement in the prose blocks and omits an absent requirement", async () => {
  const value = { ...finding, requirement: "The draft must belong to this agent." }
  const fixture = await mountFixture(
    createElement(ReviewFindingCard, {
      scope: "workspace-card",
      row: { finding: value, thread: { ...thread, finding: value } }
    })
  )
  const label = [...fixture.host.querySelectorAll("h4")].find((element) => element.textContent === "Requirement")
  expect(label?.parentElement?.querySelector("p")?.textContent).toBe(value.requirement)
  await fixture.render(createElement(ReviewFindingCard, { scope: "workspace-card", row: { finding, thread } }))
  expect(fixture.host.textContent).not.toContain("Requirement")
})

it("names resolved threads once and does not repeat a Resolved disposition", async () => {
  const fixture = await mountFixture(
    createElement(ReviewFindingCard, {
      scope: "workspace-card",
      row: { finding, thread: { ...thread, resolved: true } }
    })
  )
  expect(fixture.host.textContent).toContain("Thread resolved")
  const value = { ...finding, disposition: { _tag: "Resolved" } } satisfies ReviewFinding
  await fixture.render(
    createElement(ReviewFindingCard, {
      scope: "workspace-card",
      row: { finding: value, thread: { ...thread, finding: value, resolved: true } }
    })
  )
  expect(fixture.host.querySelector("[data-review-disposition]")?.textContent).toBe("Resolved")
  expect(fixture.host.textContent).not.toContain("Thread resolved")
})

// Each recorded level uses the same approved words in navigation and its destination card.
it("uses the approved confidence words consistently in the index and card", async () => {
  const fixture = await mountFixture(createElement("div"))
  for (
    const [confidence, expected] of [
      ["high", "High confidence"],
      ["medium", "Medium confidence"],
      ["low", "Low confidence"]
    ] satisfies ReadonlyArray<readonly [NonNullable<ReviewFinding["confidence"]>, string]>
  ) {
    const value = { ...finding, confidence }
    const row = { finding: value, thread: { ...thread, finding: value } }
    await fixture.render(
      createElement(
        "div",
        {},
        createElement(ReviewFindingCard, { scope: "confidence-card", row }),
        createElement(ReviewFindingsIndexView, {
          findings: { primary: [row], secondary: [] },
          scope: "confidence-card",
          hrefForThread: () => "#finding",
          secondary: { open: false, onOpenChange: () => {} }
        })
      )
    )
    expect(fixture.host.querySelector("article header")?.textContent).toContain(expected)
    expect(fixture.host.querySelector("a")?.textContent).toContain(expected)
    expect(fixture.host.textContent).not.toContain("Confidence:")
  }
})
