import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"

import { presentPortfolio } from "../../src/client/portfolio/presentPortfolio.js"
import { ReadinessFinding } from "../../src/domain/readiness/projections.js"
import { makePortfolioSnapshot } from "./portfolioFixtures.js"

describe("portfolio presenter", () => {
  it("lists each source connection with its health in words, never assuming a connection works", () => {
    expect(presentPortfolio(makePortfolioSnapshot("connected-empty")).sources).toEqual([
      {
        detail: "Checked 14 Jul 2026, 10:04 UTC",
        detailDateTime: "2026-07-14T10:04:00.000Z",
        healthLabel: "Healthy",
        healthTone: "positive",
        id: "01890f6f-6d6a-7cc0-98d2-000000000091",
        name: "CodeCommit",
        service: "codecommit"
      }
    ])
    expect(presentPortfolio(makePortfolioSnapshot("unavailable")).sources).toEqual([
      expect.objectContaining({
        detail: "Jira did not answer the latest health check.",
        healthLabel: "Unavailable",
        healthTone: "critical",
        name: "Jira"
      })
    ])
    expect(presentPortfolio(makePortfolioSnapshot("disabled")).sources).toEqual([
      expect.objectContaining({ healthLabel: "Disabled", healthTone: "neutral", name: "Jira" })
    ])
    expect(presentPortfolio(makePortfolioSnapshot("empty")).sources).toEqual([])
  })

  it("names a degraded source's reason and an unchecked source without a time", () => {
    const snapshot = makePortfolioSnapshot("connected-empty")
    const withHealth = (health: (typeof snapshot.plugins)[number]["health"]) =>
      presentPortfolio({ ...snapshot, plugins: snapshot.plugins.map((plugin) => ({ ...plugin, health })) }).sources
    expect(withHealth(null)).toEqual([
      expect.objectContaining({ detail: null, detailDateTime: null, healthLabel: "Not checked", healthTone: "neutral" })
    ])
    const checkedAt = snapshot.generatedAt
    expect(
      withHealth({
        _tag: "degraded",
        checkedAt,
        failureClass: "timeout",
        retryAt: null,
        safeMessage: "Slow responses."
      })
    ).toEqual([
      expect.objectContaining({
        detail: "Slow responses.",
        detailDateTime: null,
        healthLabel: "Degraded",
        healthTone: "caution"
      })
    ])
  })

  const heldCases: ReadonlyArray<{
    readonly finding: typeof ReadinessFinding.Encoded
    readonly label: string
    readonly reason: string
  }> = [
    {
      finding: { code: "relationship-missing", subject: { _tag: "fact", factId: "pipeline.gate" }, evidenceIds: [] },
      label: "Needs a manual approval gate",
      reason: "A required manual approval gate is missing."
    },
    {
      finding: { code: "input-incomplete", subject: { _tag: "candidate" }, evidenceIds: [] },
      label: "Waiting for complete source data",
      reason: "Some required source data is missing or incomplete."
    },
    {
      finding: { code: "relationship-unverified", subject: { _tag: "candidate" }, evidenceIds: [] },
      label: "Needs links",
      reason: "A delivery link still needs verification."
    },
    {
      finding: { code: "source-stale", subject: { _tag: "candidate" }, evidenceIds: [] },
      label: "Needs fresh source data",
      reason: "A required source is stale."
    },
    {
      finding: { code: "documentation-missing", subject: { _tag: "candidate" }, evidenceIds: [] },
      label: "Needs release documentation",
      reason: "Required release documentation is missing."
    }
  ]

  it.each(heldCases)("labels held releases as $label from the typed finding", ({ finding, label, reason }) => {
    const snapshot = makePortfolioSnapshot("six-state")
    const held = snapshot.releases.find(({ readiness }) => readiness?.verdict === "held")
    if (held?.readiness === null || held === undefined) return expect.fail("Expected the held fixture")
    const presented = presentPortfolio({
      ...snapshot,
      releases: [{
        ...held,
        collaborators: [],
        collaboratorCount: 0,
        readiness: { ...held.readiness, primaryFinding: Schema.decodeUnknownSync(ReadinessFinding)(finding) }
      }]
    }).releases[0]
    expect(presented?.release.verdict).toBe(label)
    expect(presented?.readinessReason).toBe(reason)
    expect(presented?.readinessVerdict).toBe("held")
  })

  it("holds a previously ready assessment while its evidence is being recomputed", () => {
    const snapshot = makePortfolioSnapshot("six-state")
    const ready = snapshot.releases.find(({ readiness }) => readiness?.verdict === "ready")
    if (ready?.readiness === null || ready === undefined) return expect.fail("Expected the ready fixture")
    const presented = presentPortfolio({
      ...snapshot,
      releases: [{
        ...ready,
        collaborators: [],
        collaboratorCount: 0,
        readiness: { ...ready.readiness, authority: "pending" }
      }]
    }).releases[0]
    expect(presented?.readinessVerdict).toBe("held")
    expect(presented?.release.verdict).toBe("Held")
    expect(presented?.stages.every(({ state }) => state === "Not evaluated")).toBe(true)
  })

  it("shows a recorded evaluation failure and keeps the previous ready result held", () => {
    const snapshot = makePortfolioSnapshot("six-state")
    const ready = snapshot.releases.find(({ readiness }) => readiness?.verdict === "ready")
    if (ready?.readiness === null || ready === undefined) return expect.fail("Expected the ready fixture")
    const presented = presentPortfolio({
      ...snapshot,
      releases: [{
        ...ready,
        collaborators: [],
        collaboratorCount: 0,
        readiness: { ...ready.readiness, authority: "pending" },
        readinessFailure: {
          operation: "publish",
          diagnosticCode: "readiness-publication-failed",
          invalidationRevision: 1,
          failedAt: snapshot.generatedAt,
          retryAt: snapshot.generatedAt
        }
      }]
    }).releases[0]
    expect(presented?.readinessReason).toBe("Readiness evaluation failed. Retry pending.")
    expect(presented?.readinessVerdict).toBe("held")
    expect(presented?.release.verdict).toBe("Held")
  })

  it("holds a targetless release and links directly to pipeline target configuration", () => {
    const snapshot = makePortfolioSnapshot()
    const presented = presentPortfolio({
      ...snapshot,
      releases: snapshot.releases.map((release) => ({
        ...release,
        targetConfiguration: { state: "unconfigured", targets: [], verdict: "held", reason: "no-target-environment" }
      }))
    })
    expect(presented.releases[0]?.readinessVerdict).toBe("held")
    expect(presented.releases[0]?.release.verdict).toBe("No target environment")
    expect(presented.releases[0]?.readinessReason).toBe("Choose a target environment in Settings.")
    expect(presented.releases[0]?.targetSettingsPath).toBe(`/w/${snapshot.workspaceId}/settings#release-targets`)
    expect(presented.releases[0]?.stages.every(({ tone }) => tone === "neutral")).toBe(true)
  })

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
      { id: "service", label: "Service", value: "payments-api" },
      { id: "issues", label: "Jira", value: "0" },
      { id: "pull-requests", label: "PRs", value: "0" },
      { id: "pipelines", label: "Pipelines", value: "0" },
      { id: "gaps", label: "Gaps", value: "0" }
    ])
    expect(release.release).toMatchObject({
      owner: release.collaborators[0],
      approver: release.collaborators[1],
      state: "unknown",
      verdict: "Readiness not evaluated"
    })
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
