// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { RLY_VERDICT_VARIANTS, Verdict, type RlyVerdictTone } from "../../src/patterns/Verdict.js"
import { render } from "../primitives/render.js"

const tones = ["caution", "critical", "neutral", "positive", "progress"] satisfies ReadonlyArray<RlyVerdictTone>

describe("Verdict", () => {
  it("renders every caller-supplied semantic tone without deriving verdict content", () => {
    for (const tone of tones) {
      const markup = renderToStaticMarkup(
        <Verdict reason={`${tone} supplied reason`} tone={tone} verdict={`${tone} supplied verdict`} />
      )
      expect(markup).toContain(`data-rly-verdict-tone="${tone}"`)
      expect(markup).toContain(RLY_VERDICT_VARIANTS.tone[tone].className)
      expect(markup).toContain(`${tone} supplied verdict`)
      expect(markup).toContain(`${tone} supplied reason`)
      expect(markup).toContain("<svg")
    }
  })

  it("provides a semantic section, heading, reason, and redundant hidden icon", () => {
    const verdict = render(
      <Verdict reason="The current head requires one merge approval." tone="critical" verdict="Approval needed." />
    )
    const heading = verdict?.querySelector<HTMLHeadingElement>("h2")
    const reason = verdict?.querySelector<HTMLParagraphElement>("p")

    expect(verdict?.tagName).toBe("SECTION")
    expect(heading?.textContent).toBe("Approval needed.")
    expect(reason?.textContent).toBe("The current head requires one merge approval.")
    expect(verdict?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true")
  })

  it("keeps the giant verdict class neutral across semantic tones", () => {
    const positive = render(<Verdict reason="Every required check passed." tone="positive" verdict="Ready to ship." />)
    const critical = render(<Verdict reason="One approval remains." tone="critical" verdict="Approval needed." />)
    expect(positive?.querySelector("h2")?.className).toBe(critical?.querySelector("h2")?.className)
    expect(positive?.className).not.toBe(critical?.className)
  })

  it("wraps long caller-supplied content in SSR output", () => {
    const verdict = "Production-approval-remains-required-for-payments-api-with-an-intentionally-long-identifier"
    const reason =
      "The immutable release head 4f9bb31a92cb47cba still needs an explicitly recorded production approver before deployment can begin."
    const markup = renderToStaticMarkup(
      <div style={{ inlineSize: "320px" }}>
        <Verdict reason={reason} tone="caution" verdict={verdict} />
      </div>
    )
    expect(markup).toContain(verdict)
    expect(markup).toContain(reason)
  })

  it("rejects blank visible and explanatory contracts", () => {
    expect(() => renderToStaticMarkup(<Verdict reason="Evidence" tone="positive" verdict=" " />)).toThrow(
      "Verdict verdict"
    )
    expect(() => renderToStaticMarkup(<Verdict reason=" " tone="positive" verdict="Ready" />)).toThrow("Verdict reason")
  })
})
