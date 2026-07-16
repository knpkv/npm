// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Divider, RLY_DIVIDER_DEFAULT_VARIANTS } from "../../src/primitives/Divider.js"
import { render } from "./render.js"

// @ts-expect-error a semantic divider requires a label
const missingSemanticLabel = <Divider decorative={false} />
// @ts-expect-error decorative dividers cannot expose a label
const labelledDecoration = <Divider decorative label="Steps" />
void [missingSemanticLabel, labelledDecoration]

describe("Divider", () => {
  it("is presentation-only by default", () => {
    const divider = render(<Divider />)
    expect(divider?.getAttribute("role")).toBe("presentation")
    expect(divider?.getAttribute("aria-hidden")).toBe("true")
    expect(RLY_DIVIDER_DEFAULT_VARIANTS).toEqual({ orientation: "horizontal", strength: "subtle" })
  })

  it("supports an explicitly labelled semantic separator", () => {
    const divider = render(<Divider decorative={false} label="Activity details" orientation="vertical" />)
    expect(divider?.getAttribute("role")).toBe("separator")
    expect(divider?.getAttribute("aria-label")).toBe("Activity details")
    expect(divider?.getAttribute("aria-orientation")).toBe("vertical")
  })

  it("rejects blank semantic labels", () => {
    expect(() => renderToStaticMarkup(<Divider decorative={false} label=" " />)).toThrow("must contain visible text")
  })
})
