// @vitest-environment happy-dom

import { act, createRef } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  IconButton,
  RLY_ICON_BUTTON_DEFAULT_VARIANTS,
  RLY_ICON_BUTTON_VARIANTS
} from "../../src/primitives/IconButton.js"
import { render } from "./render.js"

// @ts-expect-error icon-only actions require an accessible label
const unlabelled = <IconButton icon="menu" />
// @ts-expect-error visible children would violate icon-only action semantics
const childLabel = <IconButton children="Menu" icon="menu" label="Open menu" />
void [unlabelled, childLabel]

describe("IconButton", () => {
  it("owns its accessible name and target variants", () => {
    const button = render(<IconButton icon="menu" label="Open menu" />)
    expect(button?.getAttribute("aria-label")).toBe("Open menu")
    expect(button?.getAttribute("type")).toBe("button")
    expect(button?.className).toContain(RLY_ICON_BUTTON_VARIANTS.size.default.className)
    expect(RLY_ICON_BUTTON_DEFAULT_VARIANTS).toEqual({ size: "default", variant: "secondary" })
  })

  it("becomes busy and disabled without losing its name", () => {
    const button = render(<IconButton icon="menu" label="Open menu" loading />)
    expect(button?.hasAttribute("disabled")).toBe(true)
    expect(button?.getAttribute("aria-busy")).toBe("true")
    expect(button?.getAttribute("aria-label")).toBe("Open menu")
  })

  it("forwards native button state, refs, and activation", () => {
    const host = document.createElement("div")
    const root = createRoot(host)
    const ref = createRef<HTMLButtonElement>()
    let activations = 0

    act(() =>
      root.render(
        <IconButton
          aria-pressed="true"
          icon="check"
          label="Toggle approval"
          onClick={() => {
            activations += 1
          }}
          ref={ref}
        />
      )
    )
    act(() => ref.current?.click())
    expect(ref.current?.getAttribute("aria-pressed")).toBe("true")
    expect(activations).toBe(1)
    act(() => root.unmount())
  })

  it("rejects blank accessible labels", () => {
    expect(() => renderToStaticMarkup(<IconButton icon="menu" label=" " />)).toThrow("visible text")
  })
})
