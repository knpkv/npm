import { describe, expect, it } from "vitest"

import { presentPortfolio } from "../../src/client/portfolio/presentPortfolio.js"
import { makePortfolioSnapshot } from "./portfolioFixtures.js"

describe("portfolio presenter", () => {
  it("maps authoritative release, people, source, and identity facts without inventing readiness", () => {
    const presented = presentPortfolio(makePortfolioSnapshot())
    const release = presented.releases[0]
    if (release === undefined) throw new Error("Expected one presented release")

    expect(release.serviceName).toBe("payments-api")
    expect(release.version).toBe("2.18.0-rc.1")
    expect(release.relay).toEqual({
      algorithm: "relay/v1",
      codename: "Copper Finch",
      symbolIndices: [6, 3, 7]
    })
    expect(release.lifecycleLabel).toBe("Candidate")
    expect(release.lifecycleTone).toBe("neutral")
    expect(release.readinessReason).toBe("No readiness evidence has been evaluated yet.")
    expect(release.stages.map(({ name, state, tone }) => ({ name, state, tone }))).toEqual([
      { name: "Build", state: "Not evaluated", tone: "neutral" },
      { name: "Verify", state: "Not evaluated", tone: "neutral" },
      { name: "Production", state: "Not evaluated", tone: "neutral" }
    ])
    expect(release.stages.every(({ reason }) => reason === "No readiness evidence has been evaluated yet.")).toBe(true)
    expect(release.collaborators).toEqual([
      {
        avatarFallback: "AB",
        id: "01890f6f-6d6a-7cc0-98d2-000000000021:release-owner",
        name: "Avery Bell",
        role: "Release owner"
      },
      {
        avatarFallback: "MS",
        id: "01890f6f-6d6a-7cc0-98d2-000000000022:release-approver",
        name: "Mara Singh",
        role: "Release approver"
      }
    ])
    expect(release.collaboratorCount).toBe(2)
    expect(release.source).toMatchObject({
      displayName: "Payments Jira",
      freshness: "current",
      healthLabel: "Healthy",
      healthTone: "positive",
      service: "jira",
      warning: null
    })
    expect(release.facts).toEqual([
      { id: "targets", label: "Targets", value: "1" },
      { id: "source-revisions", label: "Source revisions", value: "1" }
    ])
  })

  it("keeps cached release facts visible when the current source is stale or unhealthy", () => {
    const stale = presentPortfolio(makePortfolioSnapshot("stale")).releases[0]
    const unhealthy = presentPortfolio(makePortfolioSnapshot("unhealthy")).releases[0]
    if (stale === undefined || unhealthy === undefined) throw new Error("Expected preserved release presentations")

    expect(stale.source.freshness).toBe("stale")
    expect(stale.source.healthLabel).toBe("Unavailable")
    expect(stale.source.warning).toBe("Jira did not answer the latest health check.")
    expect(stale.serviceName).toBe("payments-api")
    expect(unhealthy.source.freshness).toBe("current")
    expect(unhealthy.source.healthLabel).toBe("Unavailable")
    expect(unhealthy.source.warning).toBe("Jira did not answer the latest health check.")
  })

  it("presents an administratively disabled source before historical runtime health", () => {
    const release = presentPortfolio(makePortfolioSnapshot("disabled")).releases[0]
    if (release === undefined) throw new Error("Expected one disabled-source release")

    expect(release.source.freshness).toBe("stale")
    expect(release.source.healthLabel).toBe("Disabled")
    expect(release.source.healthTone).toBe("neutral")
    expect(release.source.warning).toBe("This source connection is disabled.")
    expect(release.serviceName).toBe("payments-api")
  })

  it("treats a missing authoritative plugin summary as an unhealthy source", () => {
    const release = presentPortfolio(makePortfolioSnapshot("missing-source")).releases[0]
    if (release === undefined) throw new Error("Expected one release with missing source metadata")

    expect(release.source.service).toBeNull()
    expect(release.source.healthLabel).toBe("Unavailable")
    expect(release.source.healthTone).toBe("critical")
    expect(release.source.warning).toBe("The source connection is missing from the current portfolio snapshot.")
  })

  it("uses role-qualified presentation identities when one person holds both release roles", () => {
    const release = presentPortfolio(makePortfolioSnapshot("dual-role")).releases[0]
    if (release === undefined) throw new Error("Expected one dual-role release")

    expect(release.collaborators.map(({ id }) => id)).toEqual([
      "01890f6f-6d6a-7cc0-98d2-000000000021:release-owner",
      "01890f6f-6d6a-7cc0-98d2-000000000021:release-approver"
    ])
    expect(new Set(release.collaborators.map(({ id }) => id)).size).toBe(2)
  })

  it("presents an empty collaborator lane without manufacturing a person", () => {
    const release = presentPortfolio(makePortfolioSnapshot("unassigned")).releases[0]
    if (release === undefined) throw new Error("Expected one unassigned release")
    expect(release.collaborators).toEqual([])
  })

  it("does not invent a source-observation time when freshness is unavailable", () => {
    const release = presentPortfolio(makePortfolioSnapshot("unavailable")).releases[0]
    if (release === undefined) throw new Error("Expected one unavailable release")
    expect(release.source.freshness).toBe("unavailable")
    expect(release.source.freshnessDateTime).toBeNull()
    expect(release.source.freshnessTime).toBeNull()
  })
})
