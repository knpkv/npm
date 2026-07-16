// @vitest-environment happy-dom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { BrowserSessionProvider } from "../../src/client/BrowserSession.js"
import { PortfolioOverviewView } from "../../src/client/portfolio/PortfolioOverview.js"
import { presentPortfolio } from "../../src/client/portfolio/presentPortfolio.js"
import { makePortfolioSnapshot } from "./portfolioFixtures.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

let mountedRoot: Root | undefined

afterEach(async () => {
  if (mountedRoot === undefined) return
  await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  document.body.replaceChildren()
})

describe("PortfolioOverviewView interactions", () => {
  it("opens the exact release preview from one explicit native action", async () => {
    const portfolio = presentPortfolio(makePortfolioSnapshot())
    const onPreviewRelease = vi.fn()
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    mountedRoot = root

    await act(async () =>
      root.render(
        <MemoryRouter>
          <BrowserSessionProvider>
            <PortfolioOverviewView
              onPreviewRelease={onPreviewRelease}
              onRetry={vi.fn()}
              state={{
                _tag: "ready",
                connection: { _tag: "connected" },
                isSnapshotStale: false,
                portfolio
              }}
            />
          </BrowserSessionProvider>
        </MemoryRouter>
      )
    )

    const preview = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Preview Copper Finch"
    )
    if (preview === undefined) throw new Error("Expected the release preview action")
    expect(preview.type).toBe("button")
    preview.focus()
    expect(document.activeElement).toBe(preview)
    await act(async () => preview.click())
    expect(onPreviewRelease).toHaveBeenCalledOnce()
    expect(onPreviewRelease).toHaveBeenCalledWith("01890f6f-6d6a-7cc0-98d2-000000000011")
  })
})
