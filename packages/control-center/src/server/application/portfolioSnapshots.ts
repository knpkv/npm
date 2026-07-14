import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import type { PortfolioSnapshot } from "../../api/portfolio.js"
import { ApplicationServiceUnavailable, PortfolioSnapshots } from "../api/ApplicationServices.js"
import { Persistence } from "../persistence/Persistence.js"
import { listPluginConnectionSummaries } from "./pluginAdministration.js"

const MAXIMUM_PORTFOLIO_RELEASES = 200

const unavailable = (): ApplicationServiceUnavailable => new ApplicationServiceUnavailable({ retryAt: null })

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
      return {
        workspaceId,
        generatedAt,
        releases: releases.map(({ release }) => ({
          releaseId: release.id,
          serviceName: release.serviceName,
          version: release.version,
          lifecycle: release.lifecycle,
          relay: release.relay,
          freshness: release.freshness,
          targetEnvironmentIds: release.targetEnvironmentIds,
          collaboratorCount: release.roleAssignments.length,
          relatedEntityCount: release.sourceRevisions.length,
          updatedAt: release.updatedAt
        })),
        plugins
      } satisfies PortfolioSnapshot
    })
  })
})

/** Live portfolio projection layer. */
export const portfolioSnapshotsLayer = Layer.effect(PortfolioSnapshots, makePortfolioSnapshots)
