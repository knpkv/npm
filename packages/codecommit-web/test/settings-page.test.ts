// @vitest-environment happy-dom

import { describe, expect, it } from "@effect/vitest"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router"

import { SettingsPage } from "../src/client/components/settings-page.js"

Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true })

describe("SettingsPage", () => {
  it("models URL-backed settings destinations as navigation links", async () => {
    const host = document.createElement("div")
    const root = createRoot(host)
    await act(async () =>
      root.render(
        createElement(
          MemoryRouter,
          { initialEntries: ["/settings/about"] },
          createElement(
            Routes,
            null,
            createElement(Route, { path: "/settings/:tab", element: createElement(SettingsPage) })
          )
        )
      )
    )

    const links = Array.from(host.querySelectorAll<HTMLAnchorElement>("nav[aria-label=\"Settings\"] a"))
    expect(links).toHaveLength(10)
    expect(links.some((link) => link.textContent?.includes("Relay"))).toBe(true)
    expect(links.find((link) => link.textContent?.includes("About"))?.getAttribute("aria-current")).toBe("page")
    expect(host.querySelector("[role=\"tablist\"], [role=\"tab\"], [role=\"tabpanel\"]")).toBeNull()
    expect(host.querySelector("section[aria-label=\"About settings\"]")?.textContent).toContain("Keyboard shortcuts")

    await act(async () => root.unmount())
  })
})
