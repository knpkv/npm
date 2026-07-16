import * as Schema from "effect/Schema"

import { PortfolioSnapshot } from "../src/api/portfolio.js"
import { ReleaseId } from "../src/domain/identifiers.js"
import type { ReadinessVerdict } from "../src/domain/readiness/model.js"
import { deriveReleaseRelay } from "../src/domain/releaseRelay.js"

const pluginConnectionId = "01890f6f-6d6a-7cc0-98d2-000000000091"
const targetEnvironmentId = "01890f6f-6d6a-7cc0-98d2-000000000031"

const stage = (state: string, progress: null | { readonly _tag: "percent"; readonly value: number } = null) => ({
  evidenceIds: [],
  factIds: [],
  progress,
  state
})

const readiness = (verdict: ReadinessVerdict) => ({
  authority: "authoritative",
  blockerCount: verdict === "blocked" ? 1 : 0,
  evaluatedAt: "2026-07-14T10:12:00.000Z",
  gapCount: verdict === "held" ? 1 : 0,
  primaryFinding: verdict === "blocked"
    ? { code: "check-failed", evidenceIds: [], subject: { _tag: "candidate" } }
    : verdict === "held"
    ? { code: "relationship-missing", evidenceIds: [], subject: { _tag: "candidate" } }
    : null,
  stages: verdict === "blocked"
    ? { build: stage("succeeded"), verify: stage("failed"), production: stage("not-started") }
    : verdict === "ready"
    ? { build: stage("succeeded"), verify: stage("passed"), production: stage("waiting") }
    : verdict === "deploying"
    ? {
      build: stage("succeeded"),
      verify: stage("passed"),
      production: stage("deploying", { _tag: "percent", value: 64 })
    }
    : verdict === "building"
    ? {
      build: stage("running", { _tag: "percent", value: 42 }),
      verify: stage("pending"),
      production: stage("not-started")
    }
    : verdict === "shipped"
    ? { build: stage("succeeded"), verify: stage("passed"), production: stage("succeeded") }
    : { build: stage("held"), verify: stage("held"), production: stage("held") },
  verdict,
  warningCount: verdict === "building" ? 1 : 0
})

const release = (
  ordinal: number,
  verdict: ReadinessVerdict,
  serviceName: string,
  version: string
) => {
  const releaseId = `01890f6f-6d6a-7cc0-98d2-${String(ordinal + 11).padStart(12, "0")}`
  const ownerName = ordinal === 0 ? "Avery Bell" : `Owner ${String(ordinal + 1)}`
  const approverName = ordinal === 0 ? "Mara Singh" : `Approver ${String(ordinal + 1)}`
  return {
    collaboratorCount: 2,
    collaborators: [
      {
        avatarFallback: ordinal === 0 ? "AB" : `O${String(ordinal + 1)}`,
        displayName: ownerName,
        personId: `01890f6f-6d6a-7cc0-98d3-${String(ordinal * 2 + 21).padStart(12, "0")}`,
        role: "release-owner"
      },
      {
        avatarFallback: ordinal === 0 ? "MS" : `A${String(ordinal + 1)}`,
        displayName: approverName,
        personId: `01890f6f-6d6a-7cc0-98d3-${String(ordinal * 2 + 22).padStart(12, "0")}`,
        role: "release-approver"
      }
    ],
    freshness: {
      _tag: "current",
      pluginHealth: { _tag: "healthy", checkedAt: "2026-07-14T10:04:00.000Z" },
      provenance: {
        _tag: "provider",
        sourceRevision: {
          firstObservedAt: "2026-07-14T10:00:00.000Z",
          lastObservedAt: "2026-07-14T10:02:00.000Z",
          normalizationSchemaVersion: 1,
          pluginConnectionId,
          providerId: "jira",
          revision: `jira-revision-${String(ordinal + 7)}`,
          sourceUrl: null,
          synchronizedAt: "2026-07-14T10:03:00.000Z",
          vendorImmutableId: `release-${serviceName}-${version}`
        }
      },
      sourceObservedAt: "2026-07-14T10:02:00.000Z",
      staleAfterSeconds: 300,
      synchronizedAt: "2026-07-14T10:03:00.000Z"
    },
    lifecycle: verdict === "shipped" ? "released" : verdict === "deploying" ? "deploying" : "candidate",
    readiness: readiness(verdict),
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
    targetEnvironmentIds: [targetEnvironmentId],
    updatedAt: "2026-07-14T10:03:00.000Z",
    version
  }
}

/** Six Schema-decoded releases covering every authoritative portfolio state for browser acceptance. */
export const releasePortfolioFixture = Schema.decodeUnknownSync(PortfolioSnapshot)({
  eventCursor: 10,
  generatedAt: "2026-07-14T10:16:00.000Z",
  plugins: [
    {
      displayName: "Payments Jira",
      health: { _tag: "healthy", checkedAt: "2026-07-14T10:04:00.000Z" },
      isEnabled: true,
      pluginConnectionId,
      providerId: "jira",
      updatedAt: "2026-07-14T10:15:00.000Z"
    }
  ],
  releases: [
    release(0, "blocked", "payments-api", "2.18.0-rc.1"),
    release(1, "ready", "ledger-api", "4.7.2"),
    release(2, "deploying", "checkout-web", "8.3.0"),
    release(3, "building", "risk-worker", "1.14.0-rc.3"),
    release(4, "shipped", "identity-api", "5.2.1"),
    release(5, "held", "reporting-api", "3.9.0-rc.2")
  ],
  workspaceId: "01890f6f-6d6a-7cc0-98d2-000000000001"
})
