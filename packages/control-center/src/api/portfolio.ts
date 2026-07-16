import * as Schema from "effect/Schema"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

import { Freshness } from "../domain/freshness.js"
import { EnvironmentId, EventCursor, PersonId, ReleaseId, WorkspaceId } from "../domain/identifiers.js"
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
const MAXIMUM_RELEASE_COLLABORATORS = 50

const BoundedCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(MAXIMUM_COUNT))

/** Release-scoped human responsibility shown in the compact portfolio. */
export const PortfolioReleaseRole = Schema.Literals(["release-owner", "release-approver"])

/** Decoded compact release responsibility. */
export type PortfolioReleaseRole = typeof PortfolioReleaseRole.Type

/** Named human collaborator resolved from durable workspace identity. */
export const PortfolioReleaseCollaborator = Schema.Struct({
  personId: PersonId,
  displayName: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
  avatarFallback: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(4)),
  role: PortfolioReleaseRole
}).annotate({ identifier: "PortfolioReleaseCollaborator" })

/** Decoded compact release collaborator. */
export type PortfolioReleaseCollaborator = typeof PortfolioReleaseCollaborator.Type

const BoundedReleaseCollaborators = Schema.Array(PortfolioReleaseCollaborator).check(
  Schema.makeFilter((collaborators) => collaborators.length <= MAXIMUM_RELEASE_COLLABORATORS, {
    expected: `at most ${MAXIMUM_RELEASE_COLLABORATORS} release collaborators`
  }),
  Schema.makeFilter(
    (collaborators) =>
      new Set(collaborators.map(({ personId, role }) => `${personId}\u0000${role}`)).size === collaborators.length,
    { expected: "unique person and release-role pairs" }
  )
)

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
  collaborators: BoundedReleaseCollaborators,
  collaboratorCount: BoundedCount,
  sourceRevisionCount: BoundedCount,
  updatedAt: UtcTimestamp
}).annotate({ identifier: "PortfolioReleaseSummary" })

/** Decoded compact release summary. */
export type PortfolioReleaseSummary = typeof PortfolioReleaseSummary.Type

/** Bounded, point-in-time portfolio projection for one authenticated workspace. */
export const PortfolioSnapshot = Schema.Struct({
  workspaceId: WorkspaceId,
  eventCursor: EventCursor,
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
