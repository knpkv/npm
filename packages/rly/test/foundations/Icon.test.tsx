// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Icon, RLY_ICON_DEFAULT_VARIANTS, RLY_ICON_NAMES, RLY_ICON_VARIANTS } from "../../src/foundations/Icon.js"

// @ts-expect-error decorative icons cannot contribute a second accessible label
const labelledDecorativeIcon = <Icon decorative label="Search" name="search" />
// @ts-expect-error informative icons require an accessible label
const unlabelledInformativeIcon = <Icon name="search" />
void [labelledDecorativeIcon, unlabelledInformativeIcon]

const render = (element: React.ReactNode): SVGElement | null => {
  document.body.innerHTML = renderToStaticMarkup(element)
  return document.querySelector("svg")
}

describe("Icon", () => {
  it("publishes a unique UI-only glyph catalog and semantic sizes", () => {
    expect(new Set(RLY_ICON_NAMES).size).toBe(RLY_ICON_NAMES.length)
    expect(RLY_ICON_NAMES).toEqual([
      "arrow-down",
      "arrow-left",
      "arrow-right",
      "arrow-up",
      "check",
      "chevron-down",
      "chevron-left",
      "chevron-right",
      "chevron-up",
      "alert",
      "clock",
      "external-link",
      "file",
      "link",
      "loader",
      "menu",
      "minus",
      "plus",
      "search",
      "user",
      "close"
    ])
    expect(RLY_ICON_VARIANTS.size).toMatchObject({
      small: { pixels: 16 },
      default: { pixels: 20 },
      large: { pixels: 24 }
    })
    expect(RLY_ICON_DEFAULT_VARIANTS).toEqual({ size: "default" })
  })

  it("hides decorative icons and keeps them out of the focus order", () => {
    const icon = render(<Icon decorative name="search" size="small" />)

    expect(icon?.getAttribute("aria-hidden")).toBe("true")
    expect(icon?.getAttribute("aria-label")).toBeNull()
    expect(icon?.getAttribute("focusable")).toBe("false")
    expect(icon?.getAttribute("height")).toBe("16")
    expect(icon?.getAttribute("role")).toBeNull()
    expect(icon?.getAttribute("stroke")).toBe("currentColor")
    expect(icon?.getAttribute("stroke-width")).toBe("1.75")
    expect(icon?.getAttribute("width")).toBe("16")
  })

  it("exposes informative icons through an owned accessible label", () => {
    const icon = render(<Icon label="Open search" name="search" />)

    expect(icon?.getAttribute("aria-hidden")).toBe("true")
    expect(icon?.getAttribute("aria-label")).toBeNull()
    expect(icon?.getAttribute("focusable")).toBe("false")
    expect(icon?.getAttribute("height")).toBe("20")
    expect(icon?.getAttribute("role")).toBeNull()
    expect(icon?.getAttribute("width")).toBe("20")
    expect(document.body.textContent).toContain("Open search")
  })

  it("renders every owned glyph at the requested size", () => {
    for (const name of RLY_ICON_NAMES) {
      const icon = render(<Icon decorative name={name} size="large" />)
      expect(icon?.getAttribute("height"), name).toBe("24")
      expect(icon?.getAttribute("width"), name).toBe("24")
    }
  })

  it("rejects empty informative labels at runtime", () => {
    expect(() => renderToStaticMarkup(<Icon label="" name="alert" />)).toThrow(
      "Informative Icon labels must contain visible text"
    )
    expect(() => renderToStaticMarkup(<Icon label="   " name="alert" />)).toThrow(
      "Informative Icon labels must contain visible text"
    )
  })
})
