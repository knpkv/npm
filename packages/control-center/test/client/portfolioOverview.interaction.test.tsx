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
})

describe("PortfolioOverviewView interactions", () => {
  it("announces the visible collaborator count while expanding and collapsing", async () => {
    const portfolio = presentPortfolio(makePortfolioSnapshot())
    const release = portfolio.releases[0]
    if (release === undefined) throw new Error("Expected one release presentation")
    const host = document.createElement("div")
    const root = createRoot(host)
    mountedRoot = root

    await act(async () =>
      root.render(
        <MemoryRouter>
          <BrowserSessionProvider>
            <PortfolioOverviewView
              onRetry={vi.fn()}
              state={{
                _tag: "ready",
                portfolio: {
                  ...portfolio,
                  releases: [
                    {
                      ...release,
                      collaboratorCount: 4,
                      collaborators: [
                        ...release.collaborators,
                        { avatarFallback: "GH", id: "grace:observer", name: "Grace Hopper", role: "Observer" },
                        {
                          avatarFallback: "KT",
                          id: "katherine:reviewer",
                          name: "Katherine Johnson",
                          role: "Reviewer"
                        }
                      ]
                    }
                  ]
                }
              }}
            />
          </BrowserSessionProvider>
        </MemoryRouter>
      )
    )

    expect(host.querySelector('[aria-label="payments-api collaborators, showing 3 of 4"]')).not.toBeNull()
    const expand = host.querySelector<HTMLButtonElement>('button[aria-label="Show 1 more people"]')
    if (expand === null) throw new Error("Expected collaborator expansion control")
    await act(async () => expand.click())

    expect(host.querySelector('[aria-label="payments-api collaborators, showing 4 of 4"]')).not.toBeNull()
    const collapse = host.querySelector<HTMLButtonElement>('button[aria-label="Show fewer people"]')
    if (collapse === null) throw new Error("Expected collaborator collapse control")
    await act(async () => collapse.click())

    expect(host.querySelector('[aria-label="payments-api collaborators, showing 3 of 4"]')).not.toBeNull()
  })
})
