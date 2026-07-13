// @vitest-environment happy-dom

import { act, createRef } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Button, RLY_BUTTON_DEFAULT_VARIANTS, RLY_BUTTON_VARIANTS } from "../../src/primitives/Button.js"
import { render } from "./render.js"

describe("Button", () => {
  it("owns safe button semantics and visible labels", () => {
    const button = render(<Button leadingIcon="check">Approve</Button>)
    expect(button?.getAttribute("type")).toBe("button")
    expect(button?.textContent).toContain("Approve")
    expect(button?.className).toContain(RLY_BUTTON_VARIANTS.variant.secondary.className)
    expect(RLY_BUTTON_DEFAULT_VARIANTS).toEqual({ size: "default", variant: "secondary" })
  })

  it("preserves content geometry while loading", () => {
    const button = render(
      <Button loading trailingIcon="arrow-right">
        Continue
      </Button>
    )
    expect(button?.hasAttribute("disabled")).toBe(true)
    expect(button?.getAttribute("aria-busy")).toBe("true")
    expect(button?.getAttribute("data-loading")).toBe("true")
    expect(button?.textContent).toContain("Continue")
    expect(button?.querySelectorAll("svg")).toHaveLength(2)
  })

  it("forwards its native ref and suppresses activation while loading", () => {
    const host = document.createElement("div")
    const root = createRoot(host)
    const ref = createRef<HTMLButtonElement>()
    let activations = 0

    act(() =>
      root.render(
        <Button
          loading
          onClick={() => {
            activations += 1
          }}
          ref={ref}
        >
          Checking
        </Button>
      )
    )
    act(() => ref.current?.click())
    expect(ref.current?.disabled).toBe(true)
    expect(activations).toBe(0)

    act(() =>
      root.render(
        <Button
          onClick={() => {
            activations += 1
          }}
          ref={ref}
        >
          Check
        </Button>
      )
    )
    act(() => ref.current?.click())
    expect(ref.current?.disabled).toBe(false)
    expect(activations).toBe(1)
    act(() => root.unmount())
  })

  it("rejects content that cannot provide its visible label", () => {
    expect(() => renderToStaticMarkup(<Button> </Button>)).toThrow("visible content")
    expect(() =>
      renderToStaticMarkup(
        // @ts-expect-error Button intentionally accepts plain visible text only.
        <Button>{false}</Button>
      )
    ).toThrow("visible content")
    expect(() =>
      renderToStaticMarkup(
        // @ts-expect-error Button intentionally rejects empty element trees.
        <Button>{<></>}</Button>
      )
    ).toThrow("visible content")
    expect(() =>
      renderToStaticMarkup(
        // @ts-expect-error Button intentionally rejects empty arrays.
        <Button>{[]}</Button>
      )
    ).toThrow("visible content")
  })
})
