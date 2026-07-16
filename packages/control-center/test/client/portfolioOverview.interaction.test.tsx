// @vitest-environment happy-dom

import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router"
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

  it("uses native, URL-backed filters that survive direct load and browser history", async () => {
    const portfolio = presentPortfolio(makePortfolioSnapshot("six-state"))
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    mountedRoot = root
    const view = (
      <BrowserSessionProvider>
        <PortfolioOverviewView
          onPreviewRelease={vi.fn()}
          onRetry={vi.fn()}
          state={{
            _tag: "ready",
            connection: { _tag: "connected" },
            isSnapshotStale: false,
            portfolio
          }}
        />
      </BrowserSessionProvider>
    )
    const router = createMemoryRouter([{ path: "*", element: view }], {
      initialEntries: ["/w/01890f6f-6d6a-7cc0-98d2-000000000001/overview?status=shipped"]
    })

    await act(async () => root.render(<RouterProvider router={router} />))

    expect(host.querySelectorAll("[data-portfolio-release-id]")).toHaveLength(1)
    expect(host.querySelector('[data-rly-release-state="shipped"]')).not.toBeNull()
    const attention = [...host.querySelectorAll<HTMLAnchorElement>("a")].find((anchor) =>
      anchor.textContent?.startsWith("Need attention")
    )
    if (attention === undefined) throw new Error("Expected the Need attention filter")
    expect(attention.getAttribute("href")).toContain("status=attention")
    attention.focus()
    expect(document.activeElement).toBe(attention)

    await act(async () => attention.click())
    expect(router.state.location.search).toBe("?status=attention")
    expect(host.querySelectorAll("[data-portfolio-release-id]")).toHaveLength(2)
    expect(host.querySelector('[data-rly-release-state="blocked"]')).not.toBeNull()
    expect(host.querySelector('[data-rly-release-state="held"]')).not.toBeNull()

    await act(async () => {
      await router.navigate(-1)
    })
    expect(router.state.location.search).toBe("?status=shipped")
    expect(host.querySelectorAll("[data-portfolio-release-id]")).toHaveLength(1)
    expect(host.querySelector('[data-rly-release-state="shipped"]')).not.toBeNull()
  })

  it("keeps the selected filter and focus stable as live data changes membership", async () => {
    const portfolio = presentPortfolio(makePortfolioSnapshot("six-state"))
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    mountedRoot = root
    const renderPortfolio = (nextPortfolio: typeof portfolio) =>
      root.render(
        <MemoryRouter initialEntries={["/?status=attention"]}>
          <BrowserSessionProvider>
            <PortfolioOverviewView
              onPreviewRelease={vi.fn()}
              onRetry={vi.fn()}
              state={{
                _tag: "ready",
                connection: { _tag: "connected" },
                isSnapshotStale: false,
                portfolio: nextPortfolio
              }}
            />
          </BrowserSessionProvider>
        </MemoryRouter>
      )

    await act(async () => renderPortfolio(portfolio))
    const attention = [...host.querySelectorAll<HTMLAnchorElement>("a")].find((anchor) =>
      anchor.textContent?.startsWith("Need attention")
    )
    if (attention === undefined) throw new Error("Expected the selected filter")
    attention.focus()
    expect(host.querySelectorAll("[data-portfolio-release-id]")).toHaveLength(2)

    const withoutBlocked = {
      ...portfolio,
      releases: portfolio.releases.filter(({ readinessVerdict }) => readinessVerdict !== "blocked")
    }
    await act(async () => renderPortfolio(withoutBlocked))

    const currentAttention = [...host.querySelectorAll<HTMLAnchorElement>("a")].find((anchor) =>
      anchor.textContent?.startsWith("Need attention")
    )
    expect(currentAttention?.getAttribute("aria-current")).toBe("page")
    expect(currentAttention?.textContent).toContain("1")
    expect(document.activeElement).toBe(currentAttention)
    expect(host.querySelectorAll("[data-portfolio-release-id]")).toHaveLength(1)
    expect(host.querySelector('[data-rly-release-state="held"]')).not.toBeNull()
  })
})
