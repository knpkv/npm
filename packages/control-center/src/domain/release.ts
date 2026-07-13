import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import { RoleAssignment } from "./actors.js"
import { Freshness } from "./freshness.js"
import { EnvironmentId, ReleaseId, WorkspaceId } from "./identifiers.js"
import { deriveReleaseRelay, ReleaseRelayProjection } from "./releaseRelay.js"
import { SourceRevision } from "./sourceRevision.js"
import { UtcTimestamp } from "./utcTimestamp.js"

/** Human-readable service name retained independently of provider identity. */
export const ReleaseServiceName = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(200)
).pipe(Schema.brand("ReleaseServiceName"))

/** Decoded release service name. */
export type ReleaseServiceName = typeof ReleaseServiceName.Type

/** Provider-neutral release version or immutable release label. */
export const ReleaseVersion = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(100)
).pipe(Schema.brand("ReleaseVersion"))

/** Decoded release version. */
export type ReleaseVersion = typeof ReleaseVersion.Type

/** Lifecycle of the release aggregate, separate from readiness and pipeline state. */
export const ReleaseLifecycle = Schema.Literals([
  "assembling",
  "candidate",
  "deploying",
  "released",
  "cancelled"
])

/** Decoded release lifecycle. */
export type ReleaseLifecycle = typeof ReleaseLifecycle.Type

const ReleaseRecord = Schema.Struct({
  createdAt: UtcTimestamp,
  freshness: Freshness,
  id: ReleaseId,
  lifecycle: ReleaseLifecycle,
  relay: ReleaseRelayProjection,
  roleAssignments: Schema.Array(RoleAssignment),
  serviceName: ReleaseServiceName,
  sourceRevisions: Schema.Array(SourceRevision),
  targetEnvironmentIds: Schema.Array(EnvironmentId).check(
    Schema.isUnique({ expected: "unique target environment identifiers" })
  ),
  updatedAt: UtcTimestamp,
  version: ReleaseVersion,
  workspaceId: WorkspaceId
})

/**
 * Foundational release aggregate. Readiness, evidence, stages, and delivery
 * relationships extend this record in their owning slices.
 */
export const Release = ReleaseRecord.check(
  Schema.makeFilter(
    ({ createdAt, updatedAt }) => DateTime.Order(createdAt, updatedAt) <= 0,
    { expected: "release update time to be at or after creation time" }
  ),
  Schema.makeFilter(
    ({ roleAssignments, workspaceId }) => roleAssignments.every(({ scope }) => scope.workspaceId === workspaceId),
    { expected: "every role assignment to belong to the release workspace" }
  ),
  Schema.makeFilter(
    ({ id, roleAssignments }) =>
      roleAssignments.every(({ scope }) =>
        scope._tag === "release" || scope._tag === "environment" ? scope.releaseId === id : true
      ),
    { expected: "release-scoped assignments to name this release" }
  ),
  Schema.makeFilter(
    ({ roleAssignments }) => {
      const assignmentIds = roleAssignments.map(({ assignmentId }) => assignmentId)
      return new Set(assignmentIds).size === assignmentIds.length
    },
    { expected: "unique role assignment identifiers" }
  ),
  Schema.makeFilter(
    ({ sourceRevisions }) => {
      const sourceKeys = sourceRevisions.map(
        ({ pluginConnectionId, providerId, vendorImmutableId }) =>
          `${providerId}\u0000${pluginConnectionId}\u0000${vendorImmutableId}`
      )
      return new Set(sourceKeys).size === sourceKeys.length
    },
    { expected: "one current source revision per provider object" }
  ),
  Schema.makeFilter(
    ({ id, relay }) => {
      const expected = deriveReleaseRelay(id)
      return (
        relay.algorithm === expected.algorithm &&
        relay.codename === expected.codename &&
        relay.symbolIndices.every((symbolIndex, index) => symbolIndex === expected.symbolIndices[index])
      )
    },
    { expected: "persisted relay projection to match the canonical release identifier" }
  )
).annotate({ identifier: "Release" })

/** Decoded foundational release aggregate. */
export type Release = typeof Release.Type
