import { expect, it } from "@effect/vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { PlanView } from "../src/presentation/PlanView.js"
import { planFixtures } from "./consumer/plan-fixtures.js"

for (const fixture of planFixtures) {
  it(`Plan ${fixture.name} exposes Retry only for a CI transport failure`, () => {
    const html = renderToStaticMarkup(createElement(PlanView, { state: fixture.state, onReadAgain: () => undefined }))
    expect(html.includes(">Retry<")).toBe(fixture.state._tag === "Unreachable")
    expect(html).not.toMatch(/>Apply<|>Preview changes<|>Run<|>Retry plan</)
    expect(html).not.toContain("values:")
    if (fixture.state._tag !== "Ready" && fixture.state._tag !== "Failed") {
      expect(html).not.toContain("compatibilityDate")
      expect(html).not.toContain("ac-plan-table")
    }
    if (fixture.state._tag === "Unverified") expect(html).not.toContain("receipt")
  })
}
it("uses a caution label for updates, neutral for no change, and exposes full truncated types", () => {
  const fixture = planFixtures[0]
  if (fixture === undefined) throw new TypeError("fixture missing")
  const html = renderToStaticMarkup(createElement(PlanView, { state: fixture.state, onReadAgain: () => undefined }))
  expect(html).toContain("title=\"DurableObjectNamespace\"")
  expect(html).toContain("Update")
  expect(html).toContain("No change")
  expect(html).toContain("compatibilityDate")
  expect(html).toContain("noopener noreferrer")
})

it("base freshness names the CI-observed mismatch without claiming ancestry or the current tip", () => {
  const fixture = planFixtures.find((entry) => entry.name === "7e")
  if (fixture === undefined) throw new TypeError("base fixture missing")
  const html = renderToStaticMarkup(createElement(PlanView, { state: fixture.state, onReadAgain: () => undefined }))
  expect(html).toContain("This plan may be out of date")
  expect(html).toContain("Its base doesn’t match the latest main commit CI has seen.")
  expect(html).not.toMatch(/behind|current main|current tip/)
  for (const [name, text] of [["7d", "Published 2 days ago."], ["7j", "A newer plan run failed."]]) {
    const other = planFixtures.find((entry) => entry.name === name)
    if (other === undefined) throw new TypeError("warning fixture missing")
    const otherHtml = renderToStaticMarkup(
      createElement(PlanView, { state: other.state, onReadAgain: () => undefined })
    )
    expect(otherHtml).toContain(text)
    expect(otherHtml).not.toContain("latest main commit CI has seen")
  }
})
