import * as Schema from "effect/Schema"

import { PortfolioSnapshot } from "../../src/api/portfolio.js"

export type PortfolioFixtureState =
  | "capped"
  | "current"
  | "dual-role"
  | "empty"
  | "missing-source"
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

/** Build a Schema-decoded portfolio fixture without bypassing the public API contract. */
export const makePortfolioSnapshot = (state: PortfolioFixtureState = "current"): PortfolioSnapshot => {
  const releases = state === "empty"
    ? []
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
        : state === "unavailable"
        ? unavailableFreshness
        : currentFreshness,
      lifecycle: "candidate",
      relatedEntityCount: 6,
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
      isEnabled: true,
      pluginConnectionId,
      providerId: "jira",
      updatedAt: "2026-07-14T10:15:00.000Z"
    }]

  return Schema.decodeUnknownSync(PortfolioSnapshot)({
    generatedAt: "2026-07-14T10:16:00.000Z",
    plugins,
    releases,
    workspaceId
  })
}
