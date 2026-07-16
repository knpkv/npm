import type {
  RlyFreshnessState,
  RlyPerson,
  RlyReleasePresentation,
  RlyReleaseRelaySymbolIndices,
  RlyService,
  RlyStage
} from "@knpkv/rly/patterns"
import type { RlyStateTone } from "@knpkv/rly/primitives"
import * as DateTime from "effect/DateTime"

import type { PortfolioReleaseRole, PortfolioSnapshot } from "../../api/portfolio.js"
import type { PluginHealth } from "../../domain/freshness.js"
import type {
  ReadinessFinding,
  ReadinessProgress,
  ReadinessStages,
  ReadinessVerdict
} from "../../domain/readiness/model.js"
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

const DISABLED_SOURCE_HEALTH = {
  label: "Disabled",
  message: "This source connection is disabled.",
  tone: "neutral",
  isUnhealthy: true
} satisfies SourceHealthPresentation

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
  readonly id: PortfolioSnapshot["releases"][number]["releaseId"]
  readonly lifecycleLabel: string
  readonly lifecycleTone: RlyStateTone
  readonly readinessVerdict: ReadinessVerdict | "unknown"
  readonly readinessReason: string
  readonly release: RlyReleasePresentation
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
  readonly workspaceId: PortfolioSnapshot["workspaceId"]
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
      return DISABLED_SOURCE_HEALTH
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
    : plugin.isEnabled
    ? healthPresentation(plugin.health)
    : DISABLED_SOURCE_HEALTH
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

const stageStateLabel = (state: string): string =>
  state.split("-").map((part) => `${part.charAt(0).toLocaleUpperCase("en-US")}${part.slice(1)}`).join(" ")

const progressReason = (progress: ReadinessProgress | null): string | undefined => {
  if (progress === null) return undefined
  return progress._tag === "count"
    ? `${String(progress.completed)} of ${String(progress.total)} complete`
    : `${String(progress.value)}% complete`
}

const buildTone = (state: ReadinessStages["build"]["state"]): RlyStateTone => {
  switch (state) {
    case "failed":
      return "critical"
    case "held":
      return "caution"
    case "queued":
    case "running":
      return "progress"
    case "succeeded":
      return "positive"
    case "not-started":
      return "neutral"
  }
}

const verifyTone = (state: ReadinessStages["verify"]["state"]): RlyStateTone => {
  switch (state) {
    case "failed":
      return "critical"
    case "held":
      return "caution"
    case "pending":
      return "progress"
    case "passed":
      return "positive"
    case "not-started":
      return "neutral"
  }
}

const productionTone = (state: ReadinessStages["production"]["state"]): RlyStateTone => {
  switch (state) {
    case "failed":
    case "rolled-back":
      return "critical"
    case "held":
      return "caution"
    case "deploying":
    case "waiting":
      return "progress"
    case "succeeded":
      return "positive"
    case "not-started":
      return "neutral"
  }
}

const unevaluatedStages = (): ReadonlyArray<RlyStage> =>
  READINESS_STAGES.map((name) => ({
    id: name.toLocaleLowerCase("en-US"),
    name,
    reason: "No readiness evidence has been evaluated yet.",
    state: "Not evaluated",
    tone: "neutral"
  }))

const readinessStage = (
  id: string,
  name: string,
  state: string,
  tone: RlyStateTone,
  progress: ReadinessProgress | null
): RlyStage => {
  const reason = progressReason(progress)
  const stage = { id, name, state: stageStateLabel(state), tone }
  return reason === undefined ? stage : { ...stage, reason }
}

const readinessStages = (stages: ReadinessStages): ReadonlyArray<RlyStage> => [
  readinessStage("build", "Build", stages.build.state, buildTone(stages.build.state), stages.build.progress),
  readinessStage("verify", "Verify", stages.verify.state, verifyTone(stages.verify.state), stages.verify.progress),
  readinessStage(
    "production",
    "Production",
    stages.production.state,
    productionTone(stages.production.state),
    stages.production.progress
  )
]

const verdictPresentation: Readonly<
  Record<ReadinessVerdict, { readonly label: string; readonly tone: RlyStateTone }>
> = {
  blocked: { label: "Can't ship", tone: "critical" },
  ready: { label: "Can ship", tone: "positive" },
  deploying: { label: "Deploying", tone: "progress" },
  building: { label: "Building", tone: "progress" },
  shipped: { label: "Shipped", tone: "positive" },
  held: { label: "Needs links", tone: "caution" }
}

const findingReason = (finding: ReadinessFinding): string => {
  switch (finding.code) {
    case "input-incomplete":
      return "Readiness inputs are incomplete."
    case "relationship-missing":
      return "A required delivery link is missing."
    case "relationship-unverified":
      return "A delivery link still needs verification."
    case "relationship-rejected":
      return "A required delivery link was rejected."
    case "relationship-superseded":
      return "A delivery link points to superseded work."
    case "approval-missing":
      return "A required approval is missing."
    case "approval-pending":
      return "A required approval is pending."
    case "approval-rejected":
      return "A required approval was rejected."
    case "approval-expired":
      return "A required approval expired."
    case "check-missing":
      return "A required check is missing."
    case "check-pending":
      return "Required checks are still running."
    case "check-failed":
      return "A required check failed."
    case "check-cancelled":
      return "A required check was cancelled."
    case "execution-missing":
      return "A required pipeline run is missing."
    case "execution-pending":
      return "A required pipeline is still running."
    case "execution-failed":
      return "A required pipeline failed."
    case "execution-stopped":
      return "A required pipeline was stopped."
    case "documentation-missing":
      return "Required release documentation is missing."
    case "documentation-draft":
      return "Release documentation is still a draft."
    case "documentation-stale":
      return "Release documentation is stale."
    case "documentation-superseded":
      return "Release documentation was superseded."
    case "deployment-missing":
      return "Production deployment evidence is missing."
    case "deployment-failed":
      return "Production deployment failed."
    case "deployment-rolled-back":
      return "Production deployment was rolled back."
    case "source-stale":
      return "A required source is stale."
    case "source-missing":
      return "A required source is missing."
    case "source-unavailable":
      return "A required source is unavailable."
    case "plugin-degraded":
      return "A connected service is degraded."
    case "evidence-expired":
      return "Required evidence has expired."
  }
}

const verdictReason = (verdict: ReadinessVerdict): string => {
  switch (verdict) {
    case "blocked":
      return "Required release evidence failed."
    case "ready":
      return "All required evidence is verified."
    case "deploying":
      return "Production rollout is in progress."
    case "building":
      return "Build and verification are in progress."
    case "shipped":
      return "Production deployment is verified."
    case "held":
      return "Waiting for required delivery links."
  }
}

const releasePresentation = (
  release: PortfolioSnapshot["releases"][number],
  plugins: PortfolioSnapshot["plugins"]
): PortfolioReleasePresentation => {
  const lifecycle = lifecyclePresentation[release.lifecycle]
  const source = sourcePresentation(release, plugins)
  const collaborators = release.collaborators.map(({ avatarFallback, displayName, personId, role }) => ({
    avatarFallback,
    id: `${personId}:${role}`,
    name: displayName,
    role: releaseRoleLabels[role]
  }))
  const owner = collaborators.find(({ role }) => role === releaseRoleLabels["release-owner"])
  const approver = collaborators.find(({ role }) => role === releaseRoleLabels["release-approver"])
  const facts = [
    { id: "service", label: "Service", value: release.serviceName },
    { id: "issues", label: "Jira", value: String(release.relationships.issues) },
    { id: "pull-requests", label: "PRs", value: String(release.relationships.pullRequests) },
    { id: "pipelines", label: "Pipelines", value: String(release.relationships.pipelineExecutions) },
    { id: "gaps", label: "Gaps", value: String(release.readiness?.gapCount ?? 0) }
  ]
  const readiness = release.readiness
  const readinessReason = readiness === null
    ? "No readiness evidence has been evaluated yet."
    : readiness.authority === "pending"
    ? "Evidence changed. Rechecking this release."
    : readiness.primaryFinding === null
    ? verdictReason(readiness.verdict)
    : findingReason(readiness.primaryFinding)
  const verdict = readiness === null ? null : verdictPresentation[readiness.verdict]
  return {
    collaborators,
    collaboratorCount: release.collaboratorCount,
    facts,
    id: release.releaseId,
    lifecycleLabel: lifecycle.label,
    lifecycleTone: lifecycle.tone,
    readinessVerdict: readiness?.verdict ?? "unknown",
    readinessReason,
    release: {
      algorithm: release.relay.algorithm,
      ...(approver === undefined ? {} : { approver }),
      codename: release.relay.codename,
      facts,
      freshness: source.freshness,
      ...(source.freshnessDateTime === null || source.freshnessTime === null
        ? {}
        : { freshnessDateTime: source.freshnessDateTime, freshnessTime: source.freshnessTime }),
      id: release.releaseId,
      ...(owner === undefined ? {} : { owner }),
      reason: readinessReason,
      state: readiness?.verdict ?? "unknown",
      symbolIndices: release.relay.symbolIndices,
      tone: verdict?.tone ?? "neutral",
      verdict: verdict?.label ?? "Readiness not evaluated",
      version: release.version
    },
    relay: {
      algorithm: release.relay.algorithm,
      codename: release.relay.codename,
      symbolIndices: release.relay.symbolIndices
    },
    serviceName: release.serviceName,
    source,
    stages: readiness === null ? unevaluatedStages() : readinessStages(readiness.stages),
    version: release.version
  }
}

/** Map one authoritative API snapshot into explicit rly component props without deriving readiness. */
export const presentPortfolio = (snapshot: PortfolioSnapshot): PortfolioPresentation => ({
  generatedAt: DateTime.formatIso(snapshot.generatedAt),
  generatedTime: formattedTime(snapshot.generatedAt),
  releases: snapshot.releases.map((release) => releasePresentation(release, snapshot.plugins)),
  workspaceId: snapshot.workspaceId
})
