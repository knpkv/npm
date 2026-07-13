// @vitest-environment happy-dom

import { act, createRef } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it } from "vitest"
import { RLY_SURFACE_DEFAULT_VARIANTS, RLY_SURFACE_VARIANTS, Surface } from "../../src/primitives/Surface.js"
import { render } from "./render.js"

const listItemRef = createRef<HTMLLIElement>()
// @ts-expect-error an aside host cannot forward a list-item ref
const mismatchedAsideRef = <Surface as="aside" children="Context" ref={listItemRef} />
const exactAsideRef = (
  <Surface as="aside" ref={createRef<HTMLElementTagNameMap["aside"]>()}>
    Context
  </Surface>
)
void [mismatchedAsideRef, exactAsideRef]

describe("Surface", () => {
  it("defaults to a primary padded card", () => {
    const surface = render(<Surface>Summary</Surface>)
    expect(surface?.tagName).toBe("DIV")
    expect(surface?.className).toContain(RLY_SURFACE_VARIANTS.tone.primary.className)
    expect(surface?.className).toContain(RLY_SURFACE_VARIANTS.shape.card.className)
    expect(surface?.className).toContain(RLY_SURFACE_VARIANTS.padding.default.className)
    expect(RLY_SURFACE_DEFAULT_VARIANTS).toEqual({ padding: "default", shape: "card", tone: "primary" })
  })

  it("allows callers to own sectioning semantics", () => {
    const surface = render(
      <Surface as="article" padding="none" tone="tertiary">
        Detail
      </Surface>
    )
    expect(surface?.tagName).toBe("ARTICLE")
    expect(surface?.textContent).toBe("Detail")
  })

  it("forwards its ref to the selected structural host", () => {
    const host = document.createElement("div")
    const root = createRoot(host)
    const ref = createRef<HTMLElementTagNameMap["aside"]>()
    act(() =>
      root.render(
        <Surface as="aside" ref={ref}>
          Context
        </Surface>
      )
    )
    expect(ref.current?.tagName).toBe("ASIDE")
    act(() => root.unmount())
  })
})
