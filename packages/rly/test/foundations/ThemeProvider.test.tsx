// @vitest-environment happy-dom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import { RLY_THEME_NAMES, ThemeProvider } from "../../src/foundations/ThemeProvider.js"

afterEach(() => {
  document.body.replaceChildren()
})

describe("ThemeProvider", () => {
  it("publishes only the controlled theme names", () => {
    expect(RLY_THEME_NAMES).toEqual(["system", "light", "dark"])
  })

  it("renders safely during SSR without reading browser preferences", () => {
    expect(renderToStaticMarkup(<ThemeProvider theme="system">Content</ThemeProvider>)).toContain('data-theme="system"')
  })

  it("changes its boundary only when the controlled value changes", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)

    await act(async () => root.render(<ThemeProvider theme="light">Content</ThemeProvider>))
    const boundary = host.querySelector("[data-rly-root]")
    expect(boundary?.getAttribute("data-theme")).toBe("light")

    await act(async () => root.render(<ThemeProvider theme="dark">Content</ThemeProvider>))
    expect(host.querySelector("[data-rly-root]")).toBe(boundary)
    expect(boundary?.getAttribute("data-theme")).toBe("dark")
    await act(async () => root.unmount())
  })
})
