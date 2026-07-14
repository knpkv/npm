import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import { describe, expect, it, vi } from "vitest"

import { BrowserSessionProvider } from "../../src/client/BrowserSession.js"
import {
  PortfolioOverviewView,
  type PortfolioOverviewState,
  selectPortfolioOverviewState
} from "../../src/client/portfolio/PortfolioOverview.js"
import { presentPortfolio } from "../../src/client/portfolio/presentPortfolio.js"
import {
  type PortfolioConnectionState,
  type PortfolioSnapshotLoadState,
  resolvePortfolioFailure
} from "../../src/client/portfolio/usePortfolioSnapshot.js"
import { makePortfolioSnapshot } from "./portfolioFixtures.js"

const livePortfolioState: Pick<
  Extract<PortfolioOverviewState, { readonly _tag: "ready" }>,
  "connection" | "isSnapshotStale"
> = {
  connection: { _tag: "connected" },
  isSnapshotStale: false
}

type LiveStatusCase = readonly [PortfolioConnectionState, boolean, string, string]

const liveStatusCases: ReadonlyArray<LiveStatusCase> = [
  [{ _tag: "connected" }, false, "Live", "Snapshot up to date."],
  [{ _tag: "connecting" }, false, "Connecting", "Connecting to live updates."],
  [{ _tag: "reconnecting", attempt: 2 }, true, "Reconnecting", "it may be stale."],
  [{ _tag: "offline" }, true, "Offline", "it may be stale."],
  [{ _tag: "connected" }, true, "Updating", "Refreshing the authoritative snapshot."]
]

const renderOverview = (state: PortfolioOverviewState): string =>
  renderToStaticMarkup(
    <MemoryRouter>
      <BrowserSessionProvider>
        <PortfolioOverviewView onRetry={vi.fn()} state={state} />
      </BrowserSessionProvider>
    </MemoryRouter>
  )

describe("PortfolioOverviewView", () => {
  it("reserves stable, accessible geometry while releases load", () => {
    const markup = renderOverview({ _tag: "loading" })
    expect(markup).toContain("Every release. One view.")
    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-label="Loading releases"')
    expect(markup).not.toContain("No releases yet")
  })

  it("explains the authenticated empty portfolio without fake metrics", () => {
    const markup = renderOverview({
      _tag: "ready",
      ...livePortfolioState,
      portfolio: presentPortfolio(makePortfolioSnapshot("empty"))
    })
    expect(markup).toContain("No releases yet")
    expect(markup).toContain("Sync a connected service")
    expect(markup).not.toContain("Ready to ship")
  })

  it("renders one factual dossier with people, lifecycle, readiness, and service provenance", () => {
    const markup = renderOverview({
      _tag: "ready",
      ...livePortfolioState,
      portfolio: presentPortfolio(makePortfolioSnapshot())
    })
    expect(markup).toContain('data-portfolio-release-id="01890f6f-6d6a-7cc0-98d2-000000000011"')
    expect(markup).toContain("payments-api")
    expect(markup).toContain("Copper Finch")
    expect(markup).toContain("Candidate")
    expect(markup).toContain("Readiness not evaluated")
    expect(markup).toContain("No readiness evidence has been evaluated yet.")
    expect(markup).not.toContain("disconnected")
    expect(markup).toContain("Build")
    expect(markup).toContain("Verify")
    expect(markup).toContain("Production")
    expect(markup).toContain("Avery Bell")
    expect(markup).toContain("Release owner")
    expect(markup).toContain("Mara Singh")
    expect(markup).toContain("Release approver")
    expect(markup).toContain('aria-label="Jira"')
    expect(markup).toContain("Payments Jira")
    expect(markup).toContain("Healthy")
    expect(markup).toContain("Current")
    expect(markup).not.toContain("Preview release")
  })

  it.each(liveStatusCases)(
    "announces %s state politely while preserving release data",
    (connection, isSnapshotStale, label, detail) => {
      const markup = renderOverview({
        _tag: "ready",
        connection,
        isSnapshotStale,
        portfolio: presentPortfolio(makePortfolioSnapshot())
      })
      expect(markup).toContain('role="status"')
      expect(markup).toContain('aria-live="polite"')
      expect(markup).toContain('aria-atomic="true"')
      expect(markup).toContain(label)
      expect(markup).toContain(detail)
      expect(markup).toContain("payments-api")
    }
  )

  it("does not call an opened transport live before protocol catch-up", () => {
    const markup = renderOverview({
      _tag: "ready",
      connection: { _tag: "connecting" },
      isSnapshotStale: false,
      portfolio: presentPortfolio(makePortfolioSnapshot())
    })

    expect(markup).toContain("Connecting")
    expect(markup).not.toContain("Snapshot up to date.")
  })

  it("keeps the dossier visible beneath an accessible stale-source warning", () => {
    const markup = renderOverview({
      _tag: "ready",
      ...livePortfolioState,
      portfolio: presentPortfolio(makePortfolioSnapshot("stale"))
    })
    expect(markup).toContain('role="status"')
    expect(markup).toContain("Showing preserved source facts")
    expect(markup).toContain("Jira did not answer the latest health check.")
    expect(markup).toContain("payments-api")
    expect(markup).toContain("Stale")
  })

  it("keeps recovered facts visible while naming a disabled source truthfully", () => {
    const markup = renderOverview({
      _tag: "ready",
      ...livePortfolioState,
      portfolio: presentPortfolio(makePortfolioSnapshot("disabled"))
    })
    expect(markup).toContain("payments-api")
    expect(markup).toContain("Disabled")
    expect(markup).toContain("Showing preserved source facts")
    expect(markup).toContain("This source connection is disabled.")
    expect(markup).not.toContain(">Healthy<")
  })

  it("renders one person holding two roles as two explicit, valid responsibility entries", () => {
    const markup = renderOverview({
      _tag: "ready",
      ...livePortfolioState,
      portfolio: presentPortfolio(makePortfolioSnapshot("dual-role"))
    })
    expect(markup.match(/Avery Bell/gu)).toHaveLength(2)
    expect(markup).toContain("Release owner")
    expect(markup).toContain("Release approver")
  })

  it("states when the compact overview omits collaborators beyond its payload cap", () => {
    const markup = renderOverview({
      _tag: "ready",
      ...livePortfolioState,
      portfolio: presentPortfolio(makePortfolioSnapshot("capped"))
    })
    expect(markup).toContain("Showing 2 of 51 collaborators in this overview.")
    expect(markup).toContain("payments-api collaborators, showing 2 of 51")
  })

  it("announces only the collaborators visible while the people strip is collapsed", () => {
    const portfolio = presentPortfolio(makePortfolioSnapshot())
    const release = portfolio.releases[0]
    if (release === undefined) throw new Error("Expected one release presentation")
    const markup = renderOverview({
      _tag: "ready",
      ...livePortfolioState,
      portfolio: {
        ...portfolio,
        releases: [
          {
            ...release,
            collaboratorCount: 4,
            collaborators: [
              ...release.collaborators,
              { avatarFallback: "GH", id: "grace:observer", name: "Grace Hopper", role: "Observer" },
              { avatarFallback: "KT", id: "katherine:reviewer", name: "Katherine Johnson", role: "Reviewer" }
            ]
          }
        ]
      }
    })
    expect(markup).toContain("payments-api collaborators, showing 3 of 4")
    expect(markup).toContain("Show 1 more people")
  })

  it("gives unavailable reads one clear retry action and keeps session-only views private", () => {
    const failureMarkup = renderOverview({ _tag: "failed", failure: "unavailable" })
    const expiredMarkup = renderOverview({ _tag: "failed", failure: "session-expired" })
    const sessionMarkup = renderOverview({ _tag: "session", reason: "anonymous" })
    expect(failureMarkup).toContain('role="alert"')
    expect(failureMarkup).toContain("Overview unavailable")
    expect(failureMarkup).toContain("Try again")
    expect(expiredMarkup).toContain('href="/pair"')
    expect(expiredMarkup).toContain("Pair this browser")
    expect(sessionMarkup).toContain("Release facts stay private")
    expect(sessionMarkup).toContain('href="/pair"')
    expect(sessionMarkup).toContain("Pair this browser")
    expect(sessionMarkup).not.toContain("payments-api")
  })

  it("never presents a snapshot owned by a different or removed browser session", () => {
    const snapshot = makePortfolioSnapshot()
    const loaded: Extract<PortfolioSnapshotLoadState, { readonly _tag: "loaded" }> = {
      _tag: "loaded",
      awaitingResetSnapshot: false,
      connection: { _tag: "connected" },
      isSnapshotStale: false,
      minimumRefreshCursor: null,
      sessionKey: "session-a",
      snapshot
    }
    expect(selectPortfolioOverviewState(loaded, "session-b")).toEqual({
      _tag: "loading"
    })
    expect(selectPortfolioOverviewState(loaded, null)).toEqual({
      _tag: "session",
      reason: "anonymous"
    })
  })

  it("invalidates exactly the session whose portfolio read was rejected", () => {
    const invalidateSession = vi.fn()
    const rejected = resolvePortfolioFailure({
      failure: { _tag: "UnauthorizedApiError" },
      onSessionExpired: invalidateSession,
      sessionKey: "session-a"
    })
    const unavailable = resolvePortfolioFailure({
      failure: { _tag: "ServiceUnavailableApiError" },
      onSessionExpired: invalidateSession,
      sessionKey: "session-b"
    })

    expect(rejected).toEqual({ _tag: "failed", failure: "session-expired", sessionKey: "session-a" })
    expect(unavailable).toEqual({ _tag: "failed", failure: "unavailable", sessionKey: "session-b" })
    expect(invalidateSession).toHaveBeenCalledOnce()
    expect(invalidateSession).toHaveBeenCalledWith("session-a")
    expect(selectPortfolioOverviewState(rejected, null)).toEqual({ _tag: "session", reason: "anonymous" })
  })

  it("distinguishes session checks, blocked access, server failure, and unavailable storage", () => {
    const checking = renderOverview({ _tag: "session", reason: "checking" })
    const blocked = renderOverview({ _tag: "session", reason: "blocked" })
    const unavailable = renderOverview({ _tag: "session", reason: "unavailable" })
    const storage = renderOverview({ _tag: "session", reason: "storage-unavailable" })
    expect(checking).toContain("Checking this browser")
    expect(blocked).toContain("Portfolio access blocked")
    expect(unavailable).toContain("Control Center unavailable")
    expect(storage).toContain("Session storage unavailable")
    expect(storage.match(/role="alert"/gu)).toHaveLength(1)
    expect(`${checking}${blocked}${unavailable}${storage}`).not.toContain("Pair this browser</a>")
  })
})
