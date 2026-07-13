// @vitest-environment happy-dom

import { act, createRef } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it } from "vitest"
import { RLY_TEXT_DEFAULT_VARIANTS, RLY_TEXT_VARIANTS, Text } from "../../src/primitives/Text.js"
import { render } from "./render.js"

const listItemRef = createRef<HTMLLIElement>()
// @ts-expect-error visual heading variants require explicit document semantics
const headingWithoutElement = <Text variant="page-title">Title</Text>
// @ts-expect-error a span host cannot forward a list-item ref
const mismatchedSpanRef = <Text as="span" children="Label" ref={listItemRef} />
// @ts-expect-error variant-dependent implicit hosts deliberately do not accept refs
const implicitHostRef = <Text ref={createRef<HTMLParagraphElement>()}>Body</Text>
const exactListItemRef = (
  <Text as="li" ref={createRef<HTMLLIElement>()}>
    Item
  </Text>
)
void [headingWithoutElement, mismatchedSpanRef, implicitHostRef, exactListItemRef]

describe("Text", () => {
  it("uses body semantics and publishes the expected axes by default", () => {
    const text = render(<Text>Readable copy</Text>)
    expect(text?.tagName).toBe("P")
    expect(text?.textContent).toBe("Readable copy")
    expect(RLY_TEXT_DEFAULT_VARIANTS).toEqual({ tone: "primary", variant: "body" })
    expect(Object.keys(RLY_TEXT_VARIANTS.variant)).toHaveLength(9)
  })

  it("keeps visual title roles separate from heading rank", () => {
    const text = render(
      <Text as="h2" tone="secondary" variant="section-title">
        Checks
      </Text>
    )
    expect(text?.tagName).toBe("H2")
    expect(text?.className).toContain(RLY_TEXT_VARIANTS.variant["section-title"].className)
    expect(text?.className).toContain(RLY_TEXT_VARIANTS.tone.secondary.className)
  })

  it("forwards its ref to the selected host element", () => {
    const host = document.createElement("div")
    const root = createRoot(host)
    const ref = createRef<HTMLTimeElement>()
    act(() =>
      root.render(
        <Text as="time" dateTime="2026-07-13" ref={ref}>
          Today
        </Text>
      )
    )
    expect(ref.current?.tagName).toBe("TIME")
    expect(ref.current?.dateTime).toBe("2026-07-13")
    act(() => root.unmount())
  })
})
