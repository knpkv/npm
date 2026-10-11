import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import type {
  PortfolioReadinessSummary,
  PortfolioRelationshipCounts,
  PortfolioReleaseCollaborator,
  PortfolioReleasePageAwareness,
  PortfolioReleaseRole,
  PortfolioReleaseSummary,
  PortfolioSnapshot
} from "../../api/portfolio.js"
import { derivePersonInitials, type Role } from "../../domain/actors.js"
import { evaluateReleaseFreshnessAt, failureStreakStartedAt, type ReleaseSourceHealth } from "../../domain/freshness.js"
import type { PluginConnectionId, ReleaseId } from "../../domain/identifiers.js"
import { releaseGateWaivers } from "../../domain/readiness/model.js"
import type { Release } from "../../domain/release.js"
import { ApplicationServiceUnavailable, PortfolioSnapshots } from "../api/ApplicationServices.js"
import { Persistence, type PersistenceService } from "../persistence/Persistence.js"
import type { GovernedActionRecord } from "../persistence/repositories/governed-action/contract.js"
import type { CurrentReleaseReadinessAssessmentRecord } from "../persistence/repositories/readinessRepository.js"
import { listPluginConnectionSummaries } from "./pluginAdministration.js"
import {
  digestReleaseSourceRevisions,
  latestConfluencePublicationReference,
  type ReleasePublicationReceiptCandidate,
  releasePublicationReceiptCandidatesFromRecords
} from "./releasePublicationMetadata.js"
import { inspectReleaseTargets, readReleaseTargetCatalog } from "./releaseTargetConfiguration.js"

const MAXIMUM_PORTFOLIO_RELEASES = 200
const MAXIMUM_COMPACT_COLLABORATORS = 50

const unavailable = (): ApplicationServiceUnavailable => new ApplicationServiceUnavailable({ retryAt: null })

const isPortfolioReleaseRole = (role: Role): role is PortfolioReleaseRole =>
  role === "release-owner" || role === "release-approver"

const roleOrder = (role: PortfolioReleaseRole): number => role === "release-owner" ? 0 : 1

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

/** Include every retained revision source and the release's primary provenance. */
const releaseSourceConnectionIds = (release: Release): ReadonlyArray<PluginConnectionId> => {
  const primary = release.freshness.provenance._tag === "none"
    ? release.freshness.provenance.pluginConnectionId
    : release.freshness.provenance.sourceRevision.pluginConnectionId
  return Array.from(new Set([primary, ...release.sourceRevisions.map(({ pluginConnectionId }) => pluginConnectionId)]))
}

const releaseCollaborators = Effect.fn("PortfolioSnapshots.releaseCollaborators")(function*(
  persistence: PersistenceService,
  release: Release
) {
  const collaborators = new Map<string, PortfolioReleaseCollaborator>()
  for (const assignment of release.roleAssignments) {
    if (
      assignment.actor._tag !== "human" ||
      assignment.lifecycle._tag !== "active" ||
      assignment.scope._tag !== "release" ||
      !isPortfolioReleaseRole(assignment.role)
    ) continue
    const person = yield* persistence.people.getPerson(release.workspaceId, assignment.actor.personId).pipe(
      Effect.mapError(() => unavailable())
    )
    const avatarFallback = person.person.avatar._tag === "initials"
      ? person.person.avatar.text
      : derivePersonInitials(person.person.displayName)
    const collaborator = {
      personId: person.person.personId,
      displayName: person.person.displayName,
      avatarFallback,
      role: assignment.role
    } satisfies PortfolioReleaseCollaborator
    collaborators.set(`${collaborator.personId}\u0000${collaborator.role}`, collaborator)
  }
  const sorted = Array.from(collaborators.values()).sort(
    (left, right) => roleOrder(left.role) - roleOrder(right.role) || compareText(left.displayName, right.displayName)
  )
  return {
    collaborators: sorted.slice(0, MAXIMUM_COMPACT_COLLABORATORS),
    collaboratorCount: sorted.length
  }
})

const summarizeReleaseReadiness = (
  current: CurrentReleaseReadinessAssessmentRecord
): PortfolioReadinessSummary => {
  const { assessment, authority } = current
  const gateWaivers = releaseGateWaivers(assessment)
  return {
    authority,
    verdict: assessment.verdict,
    stages: assessment.stages,
    blockerCount: assessment.blockers.length,
    warningCount: assessment.warnings.length,
    gapCount: assessment.gaps.length,
    ...(gateWaivers.length > 0 && { gateWaivers }),
    primaryFinding: assessment.blockers[0] ?? assessment.gaps[0] ?? assessment.warnings[0] ?? null,
    evaluatedAt: assessment.evaluatedAt
  }
}

const releaseRelationships = Effect.fn("PortfolioSnapshots.releaseRelationships")(function*(
  persistence: PersistenceService,
  release: Release
) {
  const result = yield* persistence.deliveryGraph.read(release.workspaceId, {
    _tag: "releaseSummary",
    releaseId: release.id
  }).pipe(Effect.mapError(() => unavailable()))
  if (result._tag !== "releaseSummary") return yield* Effect.die("unexpected delivery graph result")
  return {
    ...result.value,
    truncated: false
  } satisfies PortfolioRelationshipCounts
})

/** Compare the synchronized release projection with the latest successful page publication. */
export const classifyReleasePageAwareness = (
  releaseUpdatedAt: Release["updatedAt"],
  lastPublishedAt: Release["updatedAt"] | null
): PortfolioReleasePageAwareness["state"] =>
  lastPublishedAt === null
    ? "not-published"
    : DateTime.Order(releaseUpdatedAt, lastPublishedAt) > 0
    ? "stale"
    : "current"

const unknownPageAwareness = (): PortfolioReleasePageAwareness => ({
  state: "unknown",
  lastPublishedAt: null
})
const notPublishedPageAwareness = (): PortfolioReleasePageAwareness => ({
  state: "not-published",
  lastPublishedAt: null
})

/** Fail closed when successful publication history has no supported durable receipt locator. */
export const classifyReleasePublicationAwareness = (
  release: Release,
  publications: ReadonlyArray<ReleasePublicationReceiptCandidate>,
  currentSourceRevisionDigest: ReleasePublicationReceiptCandidate["sourceRevisionDigest"]
): PortfolioReleasePageAwareness => {
  const page = latestConfluencePublicationReference(publications, release.id)
  if (page === null) {
    return publications.length === 0
      ? { state: "not-published", lastPublishedAt: null }
      : unknownPageAwareness()
  }
  return {
    state: page.sourceRevisionDigest === currentSourceRevisionDigest ? "current" : "stale",
    lastPublishedAt: page.publishedAt,
    publicationActionId: page.publicationActionId
  }
}

const releasePageAwareness = Effect.fn("PortfolioSnapshots.releasePageAwareness")(function*(
  release: Release,
  records: ReadonlyArray<GovernedActionRecord>
) {
  const candidates = releasePublicationReceiptCandidatesFromRecords(records)
  if (records.length > 0 && candidates.length === 0) return unknownPageAwareness()
  if (candidates.length === 0) return notPublishedPageAwareness()
  const currentSourceRevisionDigest = yield* digestReleaseSourceRevisions(release.sourceRevisions)
  return classifyReleasePublicationAwareness(release, candidates, currentSourceRevisionDigest)
})

/**
 * Load release publication awareness with one indexed history projection.
 *
 * Any projection failure makes every requested release unknown so callers
 * cannot mistake unavailable or malformed history for permission to republish.
 */
export const loadReleasePageAwareness = Effect.fn(
  "PortfolioSnapshots.loadReleasePageAwareness"
)(function*(
  history: Pick<
    PersistenceService["governedActions"],
    "readLatestTerminalReleasePublications"
  >,
  releases: ReadonlyArray<Release>
) {
  const firstRelease = releases[0]
  if (firstRelease === undefined) return new Map<ReleaseId, PortfolioReleasePageAwareness>()
  return yield* history.readLatestTerminalReleasePublications({
    workspaceId: firstRelease.workspaceId,
    providerId: "confluence",
    releaseIds: releases.map(({ id }) => id)
  }).pipe(
    Effect.flatMap((records) => {
      const recordsByReleaseId = new Map<ReleaseId, typeof records>()
      for (const record of records) {
        const releaseId = record.envelope.releasePublication?.releaseId
        if (releaseId === undefined) continue
        recordsByReleaseId.set(releaseId, [record])
      }
      return Effect.forEach(releases, (release) =>
        Effect.map(
          releasePageAwareness(release, recordsByReleaseId.get(release.id) ?? []),
          (awareness) => [release.id, awareness] satisfies readonly [ReleaseId, PortfolioReleasePageAwareness]
        )).pipe(Effect.map((entries) => new Map(entries)))
    }),
    Effect.catch((error) =>
      Effect.logWarning("Could not read release page awareness; showing it as unknown", error).pipe(
        Effect.as(new Map(releases.map((release) => [release.id, unknownPageAwareness()])))
      )
    )
  )
})

/** Construct the bird's-eye projection from persisted facts only. */
export const makePortfolioSnapshots = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const persistence = yield* Persistence

  return PortfolioSnapshots.of({
    snapshot: Effect.fn("PortfolioSnapshots.snapshot")(function*(workspaceId) {
      return yield* persistence.transact(Effect.gen(function*() {
        const releases = yield* persistence.releases.list(workspaceId, MAXIMUM_PORTFOLIO_RELEASES)
        const plugins = yield* listPluginConnectionSummaries(persistence, workspaceId)
        const { headCursor: eventCursor } = yield* persistence.events.streamState(workspaceId)
        const generatedAt = DateTime.makeUnsafe(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
        const settings = yield* persistence.workspaceSettings.get(workspaceId)
        const targetCatalogue = yield* readReleaseTargetCatalog(persistence, workspaceId, settings.settings).pipe(
          Effect.provideService(Crypto.Crypto, cryptoService),
          Effect.mapError(() => unavailable())
        )
        const sourceConnectionIds = new Set(releases.flatMap(({ release }) => releaseSourceConnectionIds(release)))
        const sourceHealths = yield* Effect.forEach(
          plugins.filter((plugin) => sourceConnectionIds.has(plugin.pluginConnectionId)),
          (plugin) =>
            Effect.gen(function*() {
              const health = plugin.health
              if (health === null) return null
              const unavailableSince = health._tag === "degraded" || health._tag === "unavailable"
                ? failureStreakStartedAt(
                  yield* persistence.events.readPluginHealthHistory(
                    workspaceId,
                    plugin.pluginConnectionId,
                    128
                  )
                )
                : null
              return {
                pluginConnectionId: plugin.pluginConnectionId,
                health,
                unavailableSince
              } satisfies ReleaseSourceHealth
            })
        )
        const healthByConnectionId = new Map(
          sourceHealths.flatMap((source) =>
            source === null
              ? []
              : [
                [source.pluginConnectionId, source] satisfies readonly [
                  typeof source.pluginConnectionId,
                  ReleaseSourceHealth
                ]
              ]
          )
        )
        const currentReadiness = yield* persistence.readiness.readCurrentReleases({
          workspaceId,
          releaseIds: releases.map(({ release }) => release.id)
        }).pipe(Effect.mapError(() => unavailable()))
        const readinessByReleaseId = new Map(
          currentReadiness.map((record) => [
            record.assessment.candidate.scope.releaseId,
            summarizeReleaseReadiness(record)
          ])
        )
        const readinessOutcomes = yield* persistence.events.readLatestReadinessOutcomes(
          workspaceId,
          releases.map(({ release }) => release.id)
        ).pipe(Effect.mapError(() => unavailable()))
        const failures = new Map<ReleaseId, PortfolioReleaseSummary["readinessFailure"]>()
        for (const event of readinessOutcomes) {
          if (
            event.metadata.releaseId !== undefined && event.payload.reason === "readiness-failed" &&
            event.payload.readinessFailure !== undefined
          ) {
            failures.set(event.metadata.releaseId, { ...event.payload.readinessFailure, failedAt: event.occurredAt })
          }
        }
        const pageAwarenessByReleaseId = yield* loadReleasePageAwareness(
          persistence.governedActions,
          releases.map(({ release }) => release)
        ).pipe(Effect.provideService(Crypto.Crypto, cryptoService))
        const releaseSummaries = yield* Effect.forEach(releases, ({ release }) =>
          Effect.gen(function*() {
            const collaboratorProjection = yield* releaseCollaborators(persistence, release)
            const relationships = yield* releaseRelationships(persistence, release)
            const releaseSourceHealths = releaseSourceConnectionIds(release).flatMap((connectionId) => {
              const health = healthByConnectionId.get(connectionId)
              return health === undefined ? [] : [health]
            })
            const freshness = yield* evaluateReleaseFreshnessAt(release.freshness, generatedAt, releaseSourceHealths)
              .pipe(
                Effect.mapError(() => unavailable())
              )
            const readinessFailure = failures.get(release.id)
            const pageAwareness = pageAwarenessByReleaseId.get(release.id) ?? unknownPageAwareness()
            const targetSlice = release.sourceRevisions.some(({ providerId }) => providerId === "jira")
              ? yield* persistence.deliveryGraph.read(workspaceId, {
                _tag: "releaseSlice",
                releaseId: release.id,
                environmentId: null,
                limit: 500
              }) :
              null
            const targetConfiguration = targetSlice?._tag === "releaseSlice"
              ? yield* inspectReleaseTargets(
                persistence,
                release,
                targetSlice.value,
                settings.settings.pipeline.releaseTargets ?? [],
                targetCatalogue
              ).pipe(
                Effect.provideService(Crypto.Crypto, cryptoService),
                Effect.mapError(() => unavailable())
              ) :
              null
            return {
              releaseId: release.id,
              serviceName: release.serviceName,
              version: release.version,
              lifecycle: release.lifecycle,
              relay: release.relay,
              freshness,
              targetEnvironmentIds: release.targetEnvironmentIds,
              ...(!(targetConfiguration === null) && { targetConfiguration }),
              collaborators: collaboratorProjection.collaborators,
              collaboratorCount: collaboratorProjection.collaboratorCount,
              readiness: readinessByReleaseId.get(release.id) ?? null,
              ...(readinessFailure !== undefined && { readinessFailure }),
              relationships,
              sourceRevisionCount: release.sourceRevisions.length,
              releasePageAwareness: pageAwareness,
              updatedAt: release.updatedAt
            }
          }))
        return {
          workspaceId,
          eventCursor,
          generatedAt,
          releases: releaseSummaries,
          plugins
        } satisfies PortfolioSnapshot
      })).pipe(Effect.mapError(() => unavailable()))
    })
  })
})

/** Live portfolio projection layer. */
export const portfolioSnapshotsLayer = Layer.effect(PortfolioSnapshots, makePortfolioSnapshots)
