import { describe, expect, it } from "vitest"

import {
  filterPortfolioReleases,
  portfolioFilterFromSearch,
  portfolioFilterOptions,
  portfolioFilterSearch
} from "../../src/client/portfolio/portfolioFilters.js"
import { presentPortfolio } from "../../src/client/portfolio/presentPortfolio.js"
import { makePortfolioSnapshot } from "./portfolioFixtures.js"

describe("portfolio filters", () => {
  const releases = presentPortfolio(makePortfolioSnapshot("six-state")).releases

  it("presents the exact six domain states and their authoritative stage data", () => {
    expect(releases.map(({ readinessVerdict }) => readinessVerdict)).toEqual([
      "blocked",
      "ready",
      "deploying",
      "building",
      "shipped",
      "held"
    ])
    expect(releases.map(({ release }) => release.verdict)).toEqual([
      "Can't ship",
      "Can ship",
      "Deploying",
      "Building",
      "Shipped",
      "Needs links"
    ])
    expect(releases[2]?.stages[2]).toMatchObject({
      name: "Production",
      reason: "64% complete",
      state: "Deploying",
      tone: "progress"
    })
  })

  it("keeps labels, counts, and rows coherent from one release set", () => {
    expect(portfolioFilterOptions(releases)).toEqual([
      { count: 6, id: "all", label: "All" },
      { count: 2, id: "attention", label: "Need attention" },
      { count: 2, id: "deploying", label: "Deploying" },
      { count: 1, id: "shipped", label: "Shipped" }
    ])
    expect(filterPortfolioReleases(releases, "attention").map(({ readinessVerdict }) => readinessVerdict)).toEqual([
      "blocked",
      "held"
    ])
    expect(filterPortfolioReleases(releases, "deploying").map(({ readinessVerdict }) => readinessVerdict)).toEqual([
      "deploying",
      "building"
    ])
    expect(filterPortfolioReleases(releases, "shipped").map(({ readinessVerdict }) => readinessVerdict)).toEqual([
      "shipped"
    ])
  })

  it("round-trips canonical URL state while retaining unrelated query parameters", () => {
    expect(portfolioFilterFromSearch("?status=attention&panel=agent")).toBe("attention")
    expect(portfolioFilterFromSearch("?status=unknown")).toBe("all")
    expect(portfolioFilterSearch("?panel=agent", "deploying")).toBe("?panel=agent&status=deploying")
    expect(portfolioFilterSearch("?panel=agent&status=shipped", "all")).toBe("?panel=agent")
  })

  it("recovers to an explicit empty result without changing the active filter", () => {
    const withoutShipped = releases.filter(({ readinessVerdict }) => readinessVerdict !== "shipped")
    expect(filterPortfolioReleases(withoutShipped, "shipped")).toEqual([])
    expect(portfolioFilterOptions(withoutShipped).find(({ id }) => id === "shipped")?.count).toBe(0)
  })
})
