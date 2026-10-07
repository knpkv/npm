// @vitest-environment happy-dom

import { act, type ReactElement, type ReactNode, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PortalProvider } from "../../src/foundations/PortalProvider.js"
import { type RlyTheme, ThemeProvider, useStoredTheme } from "../../src/foundations/ThemeProvider.js"
import { RLY_SELECT_VARIANTS } from "../../src/primitives/Select.js"
import { ThemeSelect } from "../../src/primitives/ThemeSelect.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const roots: Array<Root> = []

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe("ThemeSelect", () => {
  it("shows a visible Appearance label by default", () => {
    const markup = renderToStaticMarkup(<ThemeSelect onValueChange={() => undefined} value="system" />)
    expect(markup).toContain(">Appearance</label>")
    expect(markup).toContain('role="combobox"')
    expect(markup).toContain("aria-labelledby=")
    expect(markup).toContain(">System<")
  })

  it("is dense by default, so it lines up with the header actions beside it", () => {
    const markup = renderToStaticMarkup(
      <ThemeSelect labelVisibility="hidden" onValueChange={() => undefined} value="system" />
    )
    expect(markup).toContain(RLY_SELECT_VARIANTS.size.dense.className)
    expect(markup).not.toContain(RLY_SELECT_VARIANTS.size.compact.className)
  })

  it("names a hidden-label control through aria-label for compact headers", () => {
    const markup = renderToStaticMarkup(
      <ThemeSelect label="Theme" labelVisibility="hidden" onValueChange={() => undefined} value="dark" />
    )
    expect(markup).not.toContain("<label")
    expect(markup).toContain('aria-label="Theme"')
    expect(markup).toContain(">Dark<")
  })

  it("reports the chosen theme by name", async () => {
    Reflect.set(HTMLElement.prototype, "scrollIntoView", vi.fn())
    const chosen: Array<RlyTheme> = []
    const Controlled = (): ReactElement => {
      const [theme, setTheme] = useState<RlyTheme>("system")
      return (
        <ThemeSelect
          labelVisibility="hidden"
          onValueChange={(next) => {
            chosen.push(next)
            setTheme(next)
          }}
          value={theme}
        />
      )
    }
    const host = document.createElement("div")
    const portal = document.createElement("div")
    document.body.append(host, portal)
    const root = createRoot(host)
    roots.push(root)
    await act(async () =>
      root.render(
        <PortalProvider container={portal}>
          <Controlled />
        </PortalProvider>
      )
    )

    const trigger = host.querySelector<HTMLButtonElement>('[role="combobox"]')
    trigger?.focus()
    await act(async () => trigger?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })))
    const options = Array.from(portal.querySelectorAll('[role="option"]'), (option) => option.textContent)
    expect(options).toEqual(["System", "Light", "Dark"])
    const dark = portal.querySelector<HTMLElement>('[role="option"]:nth-of-type(3)')
    await act(async () => dark?.focus())
    await act(async () => dark?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })))
    expect(chosen).toEqual(["dark"])
    expect(trigger?.textContent).toContain("Dark")
  })

  it("opens with every theme in the README's Shell wiring, which owns its portal target", async () => {
    Reflect.set(HTMLElement.prototype, "scrollIntoView", vi.fn())
    const browserStorage = (): Storage => window.localStorage
    // Mirrors the Shell example in packages/rly/README.md.
    const Shell = ({ children }: { readonly children: ReactNode }): ReactElement => {
      const [theme, setTheme] = useStoredTheme("readme_theme", browserStorage)
      return (
        <ThemeProvider theme={theme}>
          <PortalProvider>
            <ThemeSelect labelVisibility="hidden" onValueChange={setTheme} value={theme} />
            {children}
          </PortalProvider>
        </ThemeProvider>
      )
    }
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => root.render(<Shell>page</Shell>))
    const trigger = host.querySelector<HTMLButtonElement>('[role="combobox"]')
    trigger?.focus()
    await act(async () => trigger?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })))
    const options = Array.from(host.querySelectorAll('[role="option"]'), (option) => option.textContent)
    expect(options).toEqual(["System", "Light", "Dark"])
    localStorage.clear()
  })
})
