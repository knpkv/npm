import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import type {
  PortfolioReadinessSummary,
  PortfolioRelationshipCounts,
  PortfolioReleaseCollaborator,
  PortfolioReleaseRole,
  PortfolioSnapshot
} from "../../api/portfolio.js"
import { derivePersonInitials, type Role } from "../../domain/actors.js"
import { evaluateFreshnessAt } from "../../domain/freshness.js"
import type { Release } from "../../domain/release.js"
import { ApplicationServiceUnavailable, PortfolioSnapshots } from "../api/ApplicationServices.js"
import { Persistence, type PersistenceService } from "../persistence/Persistence.js"
import type { CurrentReleaseReadinessAssessmentRecord } from "../persistence/repositories/readinessRepository.js"
import { listPluginConnectionSummaries } from "./pluginAdministration.js"

const MAXIMUM_PORTFOLIO_RELEASES = 200
const MAXIMUM_COMPACT_COLLABORATORS = 50

const unavailable = (): ApplicationServiceUnavailable => new ApplicationServiceUnavailable({ retryAt: null })

const isPortfolioReleaseRole = (role: Role): role is PortfolioReleaseRole =>
  role === "release-owner" || role === "release-approver"

const roleOrder = (role: PortfolioReleaseRole): number => role === "release-owner" ? 0 : 1

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

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
  return {
    authority,
    verdict: assessment.verdict,
    stages: assessment.stages,
    blockerCount: assessment.blockers.length,
    warningCount: assessment.warnings.length,
    gapCount: assessment.gaps.length,
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

/** Construct the bird's-eye projection from persisted facts only. */
export const makePortfolioSnapshots = Effect.gen(function*() {
  const persistence = yield* Persistence

  return PortfolioSnapshots.of({
    snapshot: Effect.fn("PortfolioSnapshots.snapshot")(function*(workspaceId) {
      return yield* persistence.transact(Effect.gen(function*() {
        const releases = yield* persistence.releases.list(workspaceId, MAXIMUM_PORTFOLIO_RELEASES)
        const plugins = yield* listPluginConnectionSummaries(persistence, workspaceId)
        const { headCursor: eventCursor } = yield* persistence.events.streamState(workspaceId)
        const generatedAt = DateTime.makeUnsafe(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
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
        const releaseSummaries = yield* Effect.forEach(releases, ({ release }) =>
          Effect.gen(function*() {
            const collaboratorProjection = yield* releaseCollaborators(persistence, release)
            const relationships = yield* releaseRelationships(persistence, release)
            const freshness = yield* evaluateFreshnessAt(release.freshness, generatedAt).pipe(
              Effect.mapError(() => unavailable())
            )
            return {
              releaseId: release.id,
              serviceName: release.serviceName,
              version: release.version,
              lifecycle: release.lifecycle,
              relay: release.relay,
              freshness,
              targetEnvironmentIds: release.targetEnvironmentIds,
              collaborators: collaboratorProjection.collaborators,
              collaboratorCount: collaboratorProjection.collaboratorCount,
              readiness: readinessByReleaseId.get(release.id) ?? null,
              relationships,
              sourceRevisionCount: release.sourceRevisions.length,
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
