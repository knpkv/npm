// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import { CatalogEnvironment, resolveCatalogEnvironment } from "../../.storybook/catalog-environment.js"

afterEach(() => {
  document.body.replaceChildren()
})

describe("catalog environment", () => {
  it("uses safe defaults for absent and non-string URL globals", () => {
    expect(resolveCatalogEnvironment({ theme: 42, locale: undefined })).toEqual({
      density: "comfortable",
      forcedColors: "auto",
      locale: "en",
      reducedMotion: "system",
      theme: "system"
    })
  })

  it("projects all toolbar dimensions onto one isolated DOM boundary", () => {
    const values = resolveCatalogEnvironment({
      density: "compact",
      forcedColors: "active",
      locale: "nl",
      reducedMotion: "reduce",
      theme: "dark"
    })
    document.body.innerHTML = renderToStaticMarkup(
      <CatalogEnvironment values={values}>
        <p>Catalog content</p>
      </CatalogEnvironment>
    )

    const environment = document.querySelector("[data-rly-catalog]")
    expect(environment?.getAttribute("data-forced-colors")).toBe("active")
    expect(environment?.getAttribute("data-reduced-motion")).toBe("reduce")
    expect(environment?.getAttribute("data-theme")).toBe("dark")
    expect(environment?.getAttribute("data-rly-density")).toBe("compact")
    expect(environment?.getAttribute("data-rly-forced-colors")).toBe("active")
    expect(environment?.getAttribute("data-rly-reduced-motion")).toBe("reduce")
    expect(environment?.getAttribute("data-rly-theme")).toBe("dark")
    expect(environment?.getAttribute("lang")).toBe("nl")
  })
})
