// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { DecisionBar, RLY_DECISION_BAR_VARIANTS } from "../../src/patterns/DecisionBar.js"

const noop = () => undefined
const bar = (props: Partial<Parameters<typeof DecisionBar>[0]> = {}) =>
  renderToStaticMarkup(
    <DecisionBar onApprove={noop} onReject={noop} state={{ _tag: "ready" }} target="Merge #412" {...props} />
  )

describe("DecisionBar", () => {
  it("names the target on screen and in both actions", () => {
    const markup = bar({ clock: "4m left" })
    expect(markup).toContain("Merge #412, <span")
    expect(markup).toContain('aria-label="Approve: Merge #412"')
    expect(markup).toContain('aria-label="Reject: Merge #412"')
    expect(markup).not.toContain("aria-disabled")
  })

  it("keeps off actions focusable and points them at the reason", () => {
    const markup = bar({ state: { _tag: "off", reason: "Hub unreachable." } })
    expect(markup).not.toContain(" disabled=")
    expect(markup.match(/aria-disabled="true"/g)).toHaveLength(2)
    const reasonId = /<p[^>]*id="([^"]+)"[^>]*>Hub unreachable\.<\/p>/.exec(markup)?.[1]
    expect(reasonId).toBeDefined()
    expect(markup.match(new RegExp(`aria-describedby="${reasonId}"`, "g"))).toHaveLength(2)
  })

  it("says it is waiting for the server while sending, without disabling natively", () => {
    const markup = bar({ state: { _tag: "sending", action: "reject" } })
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain("Reject sent; waiting for the server&#x27;s answer.")
    expect(markup).not.toContain(" disabled=")
  })

  it("applies the sticky placement only when asked", () => {
    expect(bar()).toContain(RLY_DECISION_BAR_VARIANTS.placement.inline.className)
    expect(bar({ placement: "sticky" })).toContain(RLY_DECISION_BAR_VARIANTS.placement.sticky.className)
  })

  it("refuses an empty target", () => {
    expect(() => bar({ target: "" })).toThrow()
  })
})
