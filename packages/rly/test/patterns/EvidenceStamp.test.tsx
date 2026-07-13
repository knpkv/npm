// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { EvidenceStamp } from "../../src/patterns/EvidenceStamp.js"
import type { RlyFreshnessState } from "../../src/patterns/FreshnessStamp.js"
import type { RlyService } from "../../src/patterns/ServiceMark.js"
import { render } from "../primitives/render.js"

const evidence = [
  { freshness: "current", service: "codecommit" },
  { freshness: "cached", service: "codepipeline" },
  { freshness: "stale", service: "jira" },
  { freshness: "missing", service: "confluence" },
  { freshness: "unavailable", service: "clockify" }
] satisfies ReadonlyArray<{ readonly freshness: RlyFreshnessState; readonly service: RlyService }>

describe("EvidenceStamp", () => {
  it("keeps every evidence source separate from its explicit freshness", () => {
    for (const fixture of evidence) {
      const stamp = render(
        <EvidenceStamp
          freshness={fixture.freshness}
          freshnessDateTime="2026-07-13T14:00:00Z"
          freshnessTime="Checked 2 minutes ago"
          reference={`evidence/${fixture.service}/revision/sha256:49e8c718d805c92c59d73b86cf9a8f4e`}
          service={fixture.service}
        />
      )
      if (stamp === null) throw new Error(`EvidenceStamp did not render ${fixture.service}`)
      const source = stamp.querySelector("[data-rly-evidence-source]")
      const freshness = stamp.querySelector("[data-rly-evidence-freshness]")
      const reference = stamp.querySelector("code")
      if (source === null || freshness === null || reference === null) {
        throw new Error(`EvidenceStamp concepts did not render for ${fixture.service}`)
      }

      expect(source.getAttribute("data-rly-evidence-source")).toBe(fixture.service)
      expect(freshness.getAttribute("data-rly-evidence-freshness")).toBe(fixture.freshness)
      expect(source.contains(freshness)).toBe(false)
      expect(freshness.contains(source)).toBe(false)
      expect(reference.textContent).toContain(`evidence/${fixture.service}/revision/sha256:`)
      expect(stamp.textContent).toContain("Evidence source")
      expect(stamp.textContent).toContain("Freshness")
    }
  })

  it("renders freshness without time when none is supplied", () => {
    const stamp = render(<EvidenceStamp freshness="cached" reference="CC-PR-482/revision/17" service="codecommit" />)
    expect(stamp?.querySelector("time")).toBeNull()
    expect(stamp?.textContent).toContain("Cached")
  })

  it("rejects a blank evidence reference", () => {
    expect(() => renderToStaticMarkup(<EvidenceStamp freshness="missing" reference=" " service="jira" />)).toThrow(
      "EvidenceStamp reference"
    )
  })
})
