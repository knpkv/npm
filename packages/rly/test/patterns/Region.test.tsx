// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Region, RLY_REGION_VARIANTS } from "../../src/patterns/Region.js"

describe("Region", () => {
  it("names the section by its heading, with the count inside the name", () => {
    const markup = renderToStaticMarkup(
      <Region count={3} headingId="queue" title="Queue">
        rows
      </Region>
    )
    expect(markup).toContain('aria-labelledby="queue"')
    expect(markup).toMatch(/<h2[^>]*id="queue"[^>]*tabindex="-1"[^>]*>Queue <span[^>]*>3<\/span><\/h2>/)
  })

  it("renders actions only when given, and the requested heading level", () => {
    const bare = renderToStaticMarkup(
      <Region headingLevel={3} title="Checks">
        x
      </Region>
    )
    expect(bare).toContain("<h3")
    expect(bare).not.toContain("<h2")
    const withActions = renderToStaticMarkup(
      <Region actions={<button type="button">Refresh</button>} title="Queue">
        x
      </Region>
    )
    expect(withActions).toContain(">Refresh</button>")
  })

  it("applies the tray surface only when asked", () => {
    expect(renderToStaticMarkup(<Region title="Queue">x</Region>)).toContain(RLY_REGION_VARIANTS.tone.default.className)
    expect(
      renderToStaticMarkup(
        <Region title="Findings" tone="tray">
          x
        </Region>
      )
    ).toContain(RLY_REGION_VARIANTS.tone.tray.className)
  })

  it("refuses an empty title", () => {
    expect(() => renderToStaticMarkup(<Region title=" ">x</Region>)).toThrow()
  })
})
