import * as Schema from "effect/Schema"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

import { Freshness } from "../domain/freshness.js"
import { EnvironmentId, ReleaseId, WorkspaceId } from "../domain/identifiers.js"
import { hasMaximumPluginJsonBytes } from "../domain/plugins/bounds.js"
import { ReleaseLifecycle, ReleaseServiceName, ReleaseVersion } from "../domain/release.js"
import { ReleaseRelayProjection } from "../domain/releaseRelay.js"
import { UtcTimestamp } from "../domain/utcTimestamp.js"
import {
  ForbiddenApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError,
  UnauthorizedApiError
} from "./errors.js"
import { PluginConnectionSummary } from "./plugins.js"
import { SessionCookieAuth } from "./session.js"

const MAXIMUM_PORTFOLIO_RELEASES = 200
const MAXIMUM_TARGET_ENVIRONMENTS = 50
const MAXIMUM_SNAPSHOT_JSON_BYTES = 1024 * 1024
const MAXIMUM_COUNT = 1_000_000

const BoundedCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(MAXIMUM_COUNT))

/** Compact release projection for the authenticated bird's-eye portfolio. */
export const PortfolioReleaseSummary = Schema.Struct({
  releaseId: ReleaseId,
  serviceName: ReleaseServiceName,
  version: ReleaseVersion,
  lifecycle: ReleaseLifecycle,
  relay: ReleaseRelayProjection,
  freshness: Freshness,
  targetEnvironmentIds: Schema.Array(EnvironmentId).check(
    Schema.isUnique(),
    Schema.makeFilter((environments) => environments.length <= MAXIMUM_TARGET_ENVIRONMENTS, {
      expected: `at most ${MAXIMUM_TARGET_ENVIRONMENTS} target environments`
    })
  ),
  collaboratorCount: BoundedCount,
  relatedEntityCount: BoundedCount,
  updatedAt: UtcTimestamp
}).annotate({ identifier: "PortfolioReleaseSummary" })

/** Decoded compact release summary. */
export type PortfolioReleaseSummary = typeof PortfolioReleaseSummary.Type

/** Bounded, point-in-time portfolio projection for one authenticated workspace. */
export const PortfolioSnapshot = Schema.Struct({
  workspaceId: WorkspaceId,
  generatedAt: UtcTimestamp,
  releases: Schema.Array(PortfolioReleaseSummary).check(
    Schema.makeFilter((releases) => releases.length <= MAXIMUM_PORTFOLIO_RELEASES, {
      expected: `at most ${MAXIMUM_PORTFOLIO_RELEASES} releases`
    }),
    Schema.makeFilter((releases) => new Set(releases.map(({ releaseId }) => releaseId)).size === releases.length, {
      expected: "unique release identifiers"
    })
  ),
  plugins: Schema.Array(PluginConnectionSummary).check(
    Schema.makeFilter((plugins) => plugins.length <= 100, { expected: "at most 100 plugin connections" }),
    Schema.makeFilter(
      (plugins) => new Set(plugins.map(({ pluginConnectionId }) => pluginConnectionId)).size === plugins.length,
      { expected: "unique plugin connection identifiers" }
    )
  )
})
  .check(hasMaximumPluginJsonBytes(MAXIMUM_SNAPSHOT_JSON_BYTES))
  .annotate({ identifier: "PortfolioSnapshot" })

/** Decoded authenticated portfolio snapshot. */
export type PortfolioSnapshot = typeof PortfolioSnapshot.Type

const snapshot = HttpApiEndpoint.get("snapshot", "/snapshot", {
  success: PortfolioSnapshot,
  error: [UnauthorizedApiError, ForbiddenApiError, RequestTimedOutApiError, ServiceUnavailableApiError]
}).middleware(SessionCookieAuth)

/** Authenticated point-in-time portfolio contract. */
export class PortfolioApiGroup extends HttpApiGroup.make("portfolio").add(snapshot).prefix("/api/v1/portfolio") {}
