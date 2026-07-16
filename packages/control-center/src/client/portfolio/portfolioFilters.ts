import type { PortfolioReleasePresentation } from "./presentPortfolio.js"

/** Stable URL and presentation identifiers for the four portfolio views. */
export type PortfolioFilter = "all" | "attention" | "deploying" | "shipped"

export interface PortfolioFilterOption {
  readonly count: number
  readonly id: PortfolioFilter
  readonly label: string
}

const FILTER_LABELS: Readonly<Record<PortfolioFilter, string>> = {
  all: "All",
  attention: "Need attention",
  deploying: "Deploying",
  shipped: "Shipped"
}

const FILTER_IDS: ReadonlyArray<PortfolioFilter> = ["all", "attention", "deploying", "shipped"]

/** Decode the URL-owned filter, recovering to All for missing or unknown values. */
export const portfolioFilterFromSearch = (search: string): PortfolioFilter => {
  const value = new URLSearchParams(search).get("status")
  return value === "attention" || value === "deploying" || value === "shipped" ? value : "all"
}

/** Keep unrelated query state while producing a canonical filter search string. */
export const portfolioFilterSearch = (search: string, filter: PortfolioFilter): string => {
  const parameters = new URLSearchParams(search)
  if (filter === "all") parameters.delete("status")
  else parameters.set("status", filter)
  const encoded = parameters.toString()
  return encoded.length === 0 ? "" : `?${encoded}`
}

const releaseMatchesFilter = (release: PortfolioReleasePresentation, filter: PortfolioFilter): boolean => {
  switch (filter) {
    case "all":
      return true
    case "attention":
      return release.readinessVerdict === "blocked" ||
        release.readinessVerdict === "held" ||
        release.readinessVerdict === "unknown"
    case "deploying":
      return release.readinessVerdict === "deploying" || release.readinessVerdict === "building"
    case "shipped":
      return release.readinessVerdict === "shipped"
  }
}

/** Select rows from authoritative verdicts rather than copied display labels. */
export const filterPortfolioReleases = (
  releases: ReadonlyArray<PortfolioReleasePresentation>,
  filter: PortfolioFilter
): ReadonlyArray<PortfolioReleasePresentation> => releases.filter((release) => releaseMatchesFilter(release, filter))

/** Recompute all visible counts from the same live release set used for rows. */
export const portfolioFilterOptions = (
  releases: ReadonlyArray<PortfolioReleasePresentation>
): ReadonlyArray<PortfolioFilterOption> =>
  FILTER_IDS.map((id) => ({
    count: filterPortfolioReleases(releases, id).length,
    id,
    label: FILTER_LABELS[id]
  }))

/** Human-readable label for recoverable filter empty states. */
export const portfolioFilterLabel = (filter: PortfolioFilter): string => FILTER_LABELS[filter]
