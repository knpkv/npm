// @vitest-environment happy-dom

import { describe, expect, it } from "vitest"
import { Button } from "../../src/primitives/Button.js"
import { Notice, RLY_NOTICE_DEFAULT_VARIANTS, RLY_NOTICE_VARIANTS } from "../../src/primitives/Notice.js"
import { render } from "./render.js"

describe("Notice", () => {
  it("renders an inline message without inventing live-region semantics", () => {
    const notice = render(<Notice>Setting saved. Rescan sessions to update suggestions.</Notice>)
    expect(notice?.tagName).toBe("DIV")
    expect(notice?.getAttribute("role")).toBeNull()
    expect(notice?.getAttribute("aria-live")).toBeNull()
    expect(notice?.textContent).toBe("Setting saved. Rescan sessions to update suggestions.")
    expect(notice?.className).toContain(RLY_NOTICE_VARIANTS.tone.neutral.className)
    expect(RLY_NOTICE_DEFAULT_VARIANTS).toEqual({ tone: "neutral" })
  })

  it("keeps neutral notices glyph-free unless the caller supplies an icon", () => {
    expect(render(<Notice>Plain context.</Notice>)?.querySelector("svg")).toBeNull()
    expect(render(<Notice icon="clock">Next read at 14:00.</Notice>)?.querySelector("svg")).not.toBeNull()
  })

  it("adds a decorative tone icon so tone never depends on color alone", () => {
    const notice = render(<Notice tone="caution">Jira is read-only for this week.</Notice>)
    const icon = notice?.querySelector("svg")
    expect(icon?.getAttribute("aria-hidden")).toBe("true")
    expect(notice?.className).toContain(RLY_NOTICE_VARIANTS.tone.caution.className)
  })

  it("maps announcement urgency to established live-region roles", () => {
    const polite = render(<Notice announce="polite">Saving</Notice>)
    expect(polite?.getAttribute("role")).toBe("status")
    expect(polite?.getAttribute("aria-live")).toBe("polite")

    const assertive = render(
      <Notice action={<Button size="compact">Retry</Button>} announce="assertive" tone="critical">
        Clockify rejected the entry.
      </Notice>
    )
    expect(assertive?.getAttribute("role")).toBe("alert")
    expect(assertive?.getAttribute("aria-live")).toBe("assertive")
    expect(assertive?.querySelector("button")?.textContent).toBe("Retry")
  })

  it("covers every state tone", () => {
    expect(Object.keys(RLY_NOTICE_VARIANTS.tone)).toEqual(["neutral", "positive", "critical", "caution", "progress"])
  })
})
