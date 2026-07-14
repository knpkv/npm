import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import type { PortfolioReleaseCollaborator, PortfolioReleaseRole, PortfolioSnapshot } from "../../api/portfolio.js"
import { derivePersonInitials, type Role } from "../../domain/actors.js"
import { evaluateFreshnessAt } from "../../domain/freshness.js"
import type { Release } from "../../domain/release.js"
import { ApplicationServiceUnavailable, PortfolioSnapshots } from "../api/ApplicationServices.js"
import { Persistence, type PersistenceService } from "../persistence/Persistence.js"
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

/** Construct the bird's-eye projection from persisted facts only. */
export const makePortfolioSnapshots = Effect.gen(function*() {
  const persistence = yield* Persistence

  return PortfolioSnapshots.of({
    snapshot: Effect.fn("PortfolioSnapshots.snapshot")(function*(workspaceId) {
      const releases = yield* persistence.releases.list(workspaceId, MAXIMUM_PORTFOLIO_RELEASES).pipe(
        Effect.mapError(() => unavailable())
      )
      const plugins = yield* listPluginConnectionSummaries(persistence, workspaceId)
      const generatedAt = DateTime.makeUnsafe(yield* Effect.clockWith((clock) => clock.currentTimeMillis))
      const releaseSummaries = yield* Effect.forEach(releases, ({ release }) =>
        Effect.gen(function*() {
          const collaboratorProjection = yield* releaseCollaborators(persistence, release)
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
            sourceRevisionCount: release.sourceRevisions.length,
            updatedAt: release.updatedAt
          }
        }))
      return {
        workspaceId,
        generatedAt,
        releases: releaseSummaries,
        plugins
      } satisfies PortfolioSnapshot
    })
  })
})

/** Live portfolio projection layer. */
export const portfolioSnapshotsLayer = Layer.effect(PortfolioSnapshots, makePortfolioSnapshots)
