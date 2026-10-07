// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  RLY_STATE_LABEL_DEFAULT_VARIANTS,
  RLY_STATE_LABEL_VARIANTS,
  StateLabel
} from "../../src/primitives/StateLabel.js"
import { render } from "./render.js"

describe("StateLabel", () => {
  it("expresses state with both a word and redundant icon", () => {
    const label = render(<StateLabel label="Ready" tone="positive" />)
    expect(label?.textContent).toBe("Ready")
    expect(label?.getAttribute("role")).toBeNull()
    expect(label?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true")
    expect(label?.className).toContain(RLY_STATE_LABEL_VARIANTS.tone.positive.className)
    expect(RLY_STATE_LABEL_DEFAULT_VARIANTS).toEqual({ size: "default", tone: "neutral" })
  })

  it("draws a neutral state as its word alone, unless an icon is named", () => {
    expect(render(<StateLabel label="Installed" />)?.querySelector("svg")).toBeNull()
    expect(render(<StateLabel icon="clock" label="Queued" />)?.querySelector("svg")).not.toBeNull()
  })

  it("rejects blank visible labels", () => {
    expect(() => renderToStaticMarkup(<StateLabel label=" " />)).toThrow("visible text")
  })
})
