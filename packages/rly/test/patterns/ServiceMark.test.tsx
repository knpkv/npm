// @vitest-environment happy-dom

import { describe, expect, it } from "vitest"
import {
  RLY_SERVICE_MARK_DEFAULT_VARIANTS,
  RLY_SERVICE_MARK_VARIANTS,
  type RlyService,
  ServiceMark
} from "../../src/patterns/ServiceMark.js"
import { render } from "../primitives/render.js"

const services = [
  { name: "CodeCommit", service: "codecommit" },
  { name: "CodePipeline", service: "codepipeline" },
  { name: "Jira", service: "jira" },
  { name: "Confluence", service: "confluence" },
  { name: "Clockify", service: "clockify" }
] satisfies ReadonlyArray<{ readonly name: string; readonly service: RlyService }>

describe("ServiceMark", () => {
  it("renders every supported provider with a full visible and accessible name", () => {
    for (const fixture of services) {
      const mark = render(<ServiceMark service={fixture.service} />)
      if (mark === null) throw new Error(`ServiceMark did not render ${fixture.name}`)
      const glyph = mark.querySelector("svg")
      if (glyph === null) throw new Error(`ServiceMark did not render the ${fixture.name} glyph`)

      expect(mark.getAttribute("role")).toBe("img")
      expect(mark.getAttribute("aria-label")).toBe(fixture.name)
      expect(mark.textContent).toBe(fixture.name)
      expect(mark.getAttribute("data-rly-service")).toBe(fixture.service)
      expect(mark.className).toContain(RLY_SERVICE_MARK_VARIANTS.service[fixture.service].className)
      expect(glyph.getAttribute("aria-hidden")).toBe("true")
      expect(glyph.outerHTML).toContain("currentColor")
    }
  })

  it("publishes only service identity and meaningful density variants", () => {
    expect(Object.keys(RLY_SERVICE_MARK_VARIANTS.service)).toEqual([
      "codecommit",
      "codepipeline",
      "jira",
      "confluence",
      "clockify"
    ])
    expect(Object.keys(RLY_SERVICE_MARK_VARIANTS.size)).toEqual(["compact", "default"])
    expect(RLY_SERVICE_MARK_DEFAULT_VARIANTS).toEqual({ size: "default" })

    const compact = render(<ServiceMark service="jira" size="compact" />)
    expect(compact?.className).toContain(RLY_SERVICE_MARK_VARIANTS.size.compact.className)
    expect(compact?.getAttribute("aria-label")).toBe("Jira")
  })
})
