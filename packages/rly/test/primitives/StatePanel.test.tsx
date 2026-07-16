// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Button } from "../../src/primitives/Button.js"
import {
  RLY_STATE_PANEL_DEFAULT_VARIANTS,
  RLY_STATE_PANEL_VARIANTS,
  StatePanel
} from "../../src/primitives/StatePanel.js"
import { render } from "./render.js"

describe("StatePanel", () => {
  it("does not invent heading or live-region semantics by default", () => {
    const panel = render(<StatePanel description="All checks completed." title="Ready" tone="positive" />)
    expect(panel?.getAttribute("role")).toBeNull()
    expect(panel?.getAttribute("aria-live")).toBeNull()
    expect(panel?.querySelector("h1, h2, h3, h4, h5, h6")).toBeNull()
    expect(panel?.textContent).toContain("All checks completed.")
    expect(panel?.className).toContain(RLY_STATE_PANEL_VARIANTS.tone.positive.className)
    expect(RLY_STATE_PANEL_DEFAULT_VARIANTS).toEqual({ tone: "neutral" })
  })

  it("maps announcement urgency to established live-region roles", () => {
    const polite = render(<StatePanel announce="polite" title="Checking" tone="progress" />)
    expect(polite?.getAttribute("role")).toBe("status")
    expect(polite?.getAttribute("aria-live")).toBe("polite")

    const assertive = render(
      <StatePanel action={<Button>Review</Button>} announce="assertive" title="Blocked" tone="critical" />
    )
    expect(assertive?.getAttribute("role")).toBe("alert")
    expect(assertive?.getAttribute("aria-live")).toBe("assertive")
    expect(assertive?.querySelector("button")?.textContent).toBe("Review")
  })

  it("rejects blank titles", () => {
    expect(() => renderToStaticMarkup(<StatePanel title=" " />)).toThrow("visible text")
  })
})
