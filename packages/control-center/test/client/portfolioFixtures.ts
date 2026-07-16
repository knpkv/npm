import * as Schema from "effect/Schema"

import { PortfolioSnapshot } from "../../src/api/portfolio.js"
import { ReleaseId } from "../../src/domain/identifiers.js"
import type { ReadinessVerdict } from "../../src/domain/readiness/model.js"
import { deriveReleaseRelay } from "../../src/domain/releaseRelay.js"

export type PortfolioFixtureState =
  | "capped"
  | "current"
  | "disabled"
  | "dual-role"
  | "empty"
  | "missing-source"
  | "six-state"
  | "stale"
  | "unassigned"
  | "unavailable"
  | "unhealthy"

const workspaceId = "01890f6f-6d6a-7cc0-98d2-000000000001"
const pluginConnectionId = "01890f6f-6d6a-7cc0-98d2-000000000091"

const sourceRevision = {
  firstObservedAt: "2026-07-14T10:00:00.000Z",
  lastObservedAt: "2026-07-14T10:02:00.000Z",
  normalizationSchemaVersion: 1,
  pluginConnectionId,
  providerId: "jira",
  revision: "jira-revision-7",
  sourceUrl: null,
  synchronizedAt: "2026-07-14T10:03:00.000Z",
  vendorImmutableId: "release-payments-2.18.0"
}

const currentFreshness = {
  _tag: "current",
  pluginHealth: { _tag: "healthy", checkedAt: "2026-07-14T10:04:00.000Z" },
  provenance: { _tag: "provider", sourceRevision },
  sourceObservedAt: "2026-07-14T10:02:00.000Z",
  staleAfterSeconds: 300,
  synchronizedAt: "2026-07-14T10:03:00.000Z"
}

const staleFreshness = {
  _tag: "stale",
  pluginHealth: {
    _tag: "unavailable",
    checkedAt: "2026-07-14T10:15:00.000Z",
    failureClass: "outage",
    retryAt: "2026-07-14T10:20:00.000Z",
    safeMessage: "Jira did not answer the latest health check."
  },
  provenance: {
    _tag: "cache",
    cachedAt: "2026-07-14T10:05:00.000Z",
    sourceRevision
  },
  sourceObservedAt: "2026-07-14T10:02:00.000Z",
  staleAfterSeconds: 300,
  synchronizedAt: "2026-07-14T10:06:00.000Z"
}

const disabledFreshness = {
  _tag: "stale",
  evaluatedAt: "2026-07-14T10:16:00.000Z",
  pluginHealth: { _tag: "healthy", checkedAt: "2026-07-14T10:04:00.000Z" },
  provenance: {
    _tag: "cache",
    cachedAt: "2026-07-14T10:03:00.000Z",
    sourceRevision
  },
  sourceObservedAt: "2026-07-14T10:02:00.000Z",
  staleAfterSeconds: 300,
  synchronizedAt: "2026-07-14T10:03:00.000Z"
}

const unavailableFreshness = {
  _tag: "unavailable",
  pluginHealth: {
    _tag: "unavailable",
    checkedAt: "2026-07-14T10:15:00.000Z",
    failureClass: "outage",
    retryAt: "2026-07-14T10:20:00.000Z",
    safeMessage: "Jira did not answer the latest health check."
  },
  provenance: { _tag: "none", pluginConnectionId },
  sourceObservedAt: null,
  staleAfterSeconds: 300,
  synchronizedAt: null
}

const healthyPlugin = { _tag: "healthy", checkedAt: "2026-07-14T10:04:00.000Z" }
const unavailablePlugin = {
  _tag: "unavailable",
  checkedAt: "2026-07-14T10:15:00.000Z",
  failureClass: "outage",
  retryAt: "2026-07-14T10:20:00.000Z",
  safeMessage: "Jira did not answer the latest health check."
}

const emptyStage = (state: string, progress: null | { readonly _tag: "percent"; readonly value: number } = null) => ({
  evidenceIds: [],
  factIds: [],
  progress,
  state
})

const referenceReadiness = (verdict: ReadinessVerdict) => {
  const stages = verdict === "blocked"
    ? {
      build: emptyStage("succeeded"),
      verify: emptyStage("failed"),
      production: emptyStage("not-started")
    }
    : verdict === "ready"
    ? {
      build: emptyStage("succeeded"),
      verify: emptyStage("passed"),
      production: emptyStage("waiting")
    }
    : verdict === "deploying"
    ? {
      build: emptyStage("succeeded"),
      verify: emptyStage("passed"),
      production: emptyStage("deploying", { _tag: "percent", value: 64 })
    }
    : verdict === "building"
    ? {
      build: emptyStage("running", { _tag: "percent", value: 42 }),
      verify: emptyStage("pending"),
      production: emptyStage("not-started")
    }
    : verdict === "shipped"
    ? {
      build: emptyStage("succeeded"),
      verify: emptyStage("passed"),
      production: emptyStage("succeeded")
    }
    : {
      build: emptyStage("held"),
      verify: emptyStage("held"),
      production: emptyStage("held")
    }
  const primaryFinding = verdict === "blocked"
    ? { code: "check-failed", subject: { _tag: "candidate" }, evidenceIds: [] }
    : verdict === "held"
    ? { code: "relationship-missing", subject: { _tag: "candidate" }, evidenceIds: [] }
    : null
  return {
    authority: "authoritative",
    blockerCount: verdict === "blocked" ? 1 : 0,
    evaluatedAt: "2026-07-14T10:12:00.000Z",
    gapCount: verdict === "held" ? 2 : 0,
    primaryFinding,
    stages,
    verdict,
    warningCount: verdict === "building" ? 1 : 0
  }
}

const referenceRelease = (
  verdict: ReadinessVerdict,
  index: number,
  serviceName: string,
  version: string
) => {
  const releaseId = `01890f6f-6d6a-7cc0-98d2-${String(index + 11).padStart(12, "0")}`
  return {
    collaboratorCount: 2,
    collaborators: [
      {
        avatarFallback: "AB",
        displayName: "Avery Bell",
        personId: "01890f6f-6d6a-7cc0-98d2-000000000021",
        role: "release-owner"
      },
      {
        avatarFallback: "MS",
        displayName: "Mara Singh",
        personId: "01890f6f-6d6a-7cc0-98d2-000000000022",
        role: "release-approver"
      }
    ],
    freshness: currentFreshness,
    lifecycle: verdict === "shipped" ? "released" : verdict === "deploying" ? "deploying" : "candidate",
    readiness: referenceReadiness(verdict),
    relationships: {
      issues: 6,
      pipelineExecutions: verdict === "building" ? 1 : 2,
      pullRequests: verdict === "held" ? 0 : 3,
      truncated: false
    },
    relay: deriveReleaseRelay(Schema.decodeUnknownSync(ReleaseId)(releaseId)),
    releaseId,
    serviceName,
    sourceRevisionCount: 4,
    targetEnvironmentIds: ["01890f6f-6d6a-7cc0-98d2-000000000031"],
    updatedAt: "2026-07-14T10:03:00.000Z",
    version
  }
}

const referenceReleases = [
  referenceRelease("blocked", 0, "payments-api", "2.18.0-rc.1"),
  referenceRelease("ready", 1, "ledger-api", "4.7.2"),
  referenceRelease("deploying", 2, "checkout-web", "8.3.0"),
  referenceRelease("building", 3, "risk-worker", "1.14.0-rc.3"),
  referenceRelease("shipped", 4, "identity-api", "5.2.1"),
  referenceRelease("held", 5, "reporting-api", "3.9.0-rc.2")
]

/** Build a Schema-decoded portfolio fixture without bypassing the public API contract. */
export const makePortfolioSnapshot = (
  state: PortfolioFixtureState = "current",
  eventCursor = 10
): PortfolioSnapshot => {
  const releases = state === "empty"
    ? []
    : state === "six-state"
    ? referenceReleases
    : [{
      collaboratorCount: state === "unassigned" ? 0 : state === "capped" ? 51 : 2,
      collaborators: state === "unassigned"
        ? []
        : [
          {
            avatarFallback: "AB",
            displayName: "Avery Bell",
            personId: "01890f6f-6d6a-7cc0-98d2-000000000021",
            role: "release-owner"
          },
          {
            avatarFallback: state === "dual-role" ? "AB" : "MS",
            displayName: state === "dual-role" ? "Avery Bell" : "Mara Singh",
            personId: state === "dual-role"
              ? "01890f6f-6d6a-7cc0-98d2-000000000021"
              : "01890f6f-6d6a-7cc0-98d2-000000000022",
            role: "release-approver"
          }
        ],
      freshness: state === "stale"
        ? staleFreshness
        : state === "disabled"
        ? disabledFreshness
        : state === "unavailable"
        ? unavailableFreshness
        : currentFreshness,
      lifecycle: "candidate",
      readiness: null,
      relationships: { issues: 0, pipelineExecutions: 0, pullRequests: 0, truncated: false },
      sourceRevisionCount: 1,
      relay: { algorithm: "relay/v1", codename: "Copper Finch", symbolIndices: [6, 3, 7] },
      releaseId: "01890f6f-6d6a-7cc0-98d2-000000000011",
      serviceName: "payments-api",
      targetEnvironmentIds: ["01890f6f-6d6a-7cc0-98d2-000000000031"],
      updatedAt: "2026-07-14T10:03:00.000Z",
      version: "2.18.0-rc.1"
    }]
  const plugins = state === "empty" || state === "missing-source"
    ? []
    : [{
      displayName: "Payments Jira",
      health: state === "stale" || state === "unavailable" || state === "unhealthy"
        ? unavailablePlugin
        : healthyPlugin,
      isEnabled: state !== "disabled",
      pluginConnectionId,
      providerId: "jira",
      updatedAt: "2026-07-14T10:15:00.000Z"
    }]

  return Schema.decodeUnknownSync(PortfolioSnapshot)({
    eventCursor,
    generatedAt: "2026-07-14T10:16:00.000Z",
    plugins,
    releases,
    workspaceId
  })
}
