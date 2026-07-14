import type {
  RlyFreshnessState,
  RlyPerson,
  RlyReleaseRelaySymbolIndices,
  RlyService,
  RlyStage
} from "@knpkv/rly/patterns"
import type { RlyStateTone } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"

import type { PortfolioReleaseRole, PortfolioSnapshot } from "../../api/portfolio.js"
import type { PluginHealth } from "../../domain/freshness.js"
import type { ReleaseLifecycle } from "../../domain/release.js"

const READINESS_STAGES: ReadonlyArray<string> = ["Build", "Verify", "Production"]

const lifecyclePresentation: Readonly<
  Record<ReleaseLifecycle, { readonly label: string; readonly tone: RlyStateTone }>
> = {
  assembling: { label: "Assembling", tone: "progress" },
  candidate: { label: "Candidate", tone: "neutral" },
  deploying: { label: "Deploying", tone: "progress" },
  released: { label: "Released", tone: "positive" },
  cancelled: { label: "Cancelled", tone: "caution" }
}

const releaseRoleLabels: Readonly<Record<PortfolioReleaseRole, string>> = {
  "release-owner": "Release owner",
  "release-approver": "Release approver"
}

interface SourceHealthPresentation {
  readonly label: string
  readonly message: string | null
  readonly tone: RlyStateTone
  readonly isUnhealthy: boolean
}

export interface PortfolioSourcePresentation {
  readonly displayName: string
  readonly freshness: RlyFreshnessState
  readonly freshnessDateTime: string | null
  readonly freshnessTime: string | null
  readonly healthLabel: string
  readonly healthTone: RlyStateTone
  readonly service: RlyService | null
  readonly warning: string | null
}

export interface PortfolioReleasePresentation {
  readonly collaborators: ReadonlyArray<RlyPerson>
  readonly collaboratorCount: number
  readonly facts: ReadonlyArray<{ readonly id: string; readonly label: string; readonly value: string }>
  readonly id: string
  readonly lifecycleLabel: string
  readonly lifecycleTone: RlyStateTone
  readonly readinessReason: string
  readonly relay: {
    readonly algorithm: string
    readonly codename: string
    readonly symbolIndices: RlyReleaseRelaySymbolIndices
  }
  readonly serviceName: string
  readonly source: PortfolioSourcePresentation
  readonly stages: ReadonlyArray<RlyStage>
  readonly version: string
}

export interface PortfolioPresentation {
  readonly generatedAt: string
  readonly generatedTime: string
  readonly releases: ReadonlyArray<PortfolioReleasePresentation>
}

const serviceForProvider = (providerId: PortfolioSnapshot["plugins"][number]["providerId"]): RlyService => {
  switch (providerId) {
    case "codecommit":
      return "codecommit"
    case "codepipeline":
      return "codepipeline"
    case "jira":
      return "jira"
    case "confluence":
      return "confluence"
    case "clockify":
      return "clockify"
  }
}

const healthPresentation = (health: PluginHealth | null): SourceHealthPresentation => {
  if (health === null) {
    return { label: "Not checked", message: null, tone: "neutral", isUnhealthy: false }
  }
  switch (health._tag) {
    case "healthy":
      return { label: "Healthy", message: null, tone: "positive", isUnhealthy: false }
    case "degraded":
      return { label: "Degraded", message: health.safeMessage, tone: "caution", isUnhealthy: true }
    case "unavailable":
      return { label: "Unavailable", message: health.safeMessage, tone: "critical", isUnhealthy: true }
    case "disabled":
      return {
        label: "Disabled",
        message: "This source connection is disabled.",
        tone: "neutral",
        isUnhealthy: true
      }
  }
}

const freshnessState = (freshness: PortfolioSnapshot["releases"][number]["freshness"]): RlyFreshnessState => {
  switch (freshness._tag) {
    case "current":
      return freshness.provenance._tag === "cache" ? "cached" : "current"
    case "stale":
      return "stale"
    case "missing":
      return "missing"
    case "unavailable":
      return "unavailable"
  }
}

const sourceConnectionId = (
  freshness: PortfolioSnapshot["releases"][number]["freshness"]
): PortfolioSnapshot["plugins"][number]["pluginConnectionId"] =>
  freshness.provenance._tag === "none"
    ? freshness.provenance.pluginConnectionId
    : freshness.provenance.sourceRevision.pluginConnectionId

const freshnessTimestamp = (
  release: PortfolioSnapshot["releases"][number]
): PortfolioSnapshot["releases"][number]["updatedAt"] | null =>
  release.freshness.sourceObservedAt ?? release.freshness.synchronizedAt

const formattedTime = (timestamp: PortfolioSnapshot["generatedAt"]): string =>
  DateTime.formatUtc(timestamp, {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    locale: "en-GB",
    minute: "2-digit",
    month: "short",
    timeZoneName: "short"
  })

const sourcePresentation = (
  release: PortfolioSnapshot["releases"][number],
  plugins: PortfolioSnapshot["plugins"]
): PortfolioSourcePresentation => {
  const connectionId = sourceConnectionId(release.freshness)
  const plugin = plugins.find(({ pluginConnectionId }) => pluginConnectionId === connectionId)
  const health = plugin === undefined
    ? {
      label: "Unavailable",
      message: "The source connection is missing from the current portfolio snapshot.",
      tone: "critical",
      isUnhealthy: true
    } satisfies SourceHealthPresentation
    : healthPresentation(plugin.health)
  const freshness = freshnessState(release.freshness)
  const timestamp = freshnessTimestamp(release)
  const hasStaleFacts = release.freshness._tag === "stale"
  const warning = hasStaleFacts
    ? health.message ?? "The source is not current. Preserved facts remain visible from the last successful sync."
    : health.isUnhealthy
    ? health.message ?? "The source needs attention. Saved release facts remain visible."
    : null

  return {
    displayName: plugin?.displayName ?? "Source connection unavailable",
    freshness,
    freshnessDateTime: timestamp === null ? null : DateTime.formatIso(timestamp),
    freshnessTime: timestamp === null ? null : formattedTime(timestamp),
    healthLabel: health.label,
    healthTone: health.tone,
    service: plugin === undefined ? null : serviceForProvider(plugin.providerId),
    warning
  }
}

const readinessStages = (): ReadonlyArray<RlyStage> =>
  READINESS_STAGES.map((name) => ({
    id: name.toLocaleLowerCase("en-US"),
    name,
    reason: "No readiness evidence has been evaluated yet.",
    state: "Not evaluated",
    tone: "neutral"
  }))

const releasePresentation = (
  release: PortfolioSnapshot["releases"][number],
  plugins: PortfolioSnapshot["plugins"]
): PortfolioReleasePresentation => {
  const lifecycle = lifecyclePresentation[release.lifecycle]
  return {
    collaborators: release.collaborators.map(({ avatarFallback, displayName, personId, role }) => ({
      avatarFallback,
      id: `${personId}:${role}`,
      name: displayName,
      role: releaseRoleLabels[role]
    })),
    collaboratorCount: release.collaboratorCount,
    facts: [
      { id: "targets", label: "Targets", value: String(release.targetEnvironmentIds.length) },
      { id: "relationships", label: "Related facts", value: String(release.relatedEntityCount) }
    ],
    id: release.releaseId,
    lifecycleLabel: lifecycle.label,
    lifecycleTone: lifecycle.tone,
    readinessReason: "No readiness evidence has been evaluated yet.",
    relay: {
      algorithm: release.relay.algorithm,
      codename: release.relay.codename,
      symbolIndices: release.relay.symbolIndices
    },
    serviceName: release.serviceName,
    source: sourcePresentation(release, plugins),
    stages: readinessStages(),
    version: release.version
  }
}

/** Map one authoritative API snapshot into explicit rly component props without deriving readiness. */
export const presentPortfolio = (snapshot: PortfolioSnapshot): PortfolioPresentation => ({
  generatedAt: DateTime.formatIso(snapshot.generatedAt),
  generatedTime: formattedTime(snapshot.generatedAt),
  releases: snapshot.releases.map((release) => releasePresentation(release, snapshot.plugins))
})
