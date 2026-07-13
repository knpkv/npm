import { Schema, SchemaTransformation } from "effect"

const CANONICAL_LOWERCASE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const canonicalUuid7 = <const Brand extends string>(brand: Brand) =>
  Schema.String.check(Schema.isUUID(7)).pipe(
    Schema.decodeTo(
      Schema.String.check(
        Schema.isUUID(7),
        Schema.isPattern(CANONICAL_LOWERCASE_UUID_PATTERN, {
          expected: "a canonical lowercase UUID v7"
        })
      ),
      SchemaTransformation.toLowerCase()
    ),
    Schema.brand(brand)
  )

/** Canonical identifier of an isolated Control Center workspace. */
export const WorkspaceId = canonicalUuid7("WorkspaceId")

/** Decoded workspace identifier. */
export type WorkspaceId = typeof WorkspaceId.Type

/** Canonical identifier of a release aggregate. */
export const ReleaseId = canonicalUuid7("ReleaseId")

/** Decoded release identifier. */
export type ReleaseId = typeof ReleaseId.Type

/** Canonical identifier of a normalized delivery entity. */
export const EntityId = canonicalUuid7("EntityId")

/** Decoded delivery-entity identifier. */
export type EntityId = typeof EntityId.Type

/** Canonical identifier of a human collaborator. */
export const PersonId = canonicalUuid7("PersonId")

/** Decoded person identifier. */
export type PersonId = typeof PersonId.Type

/** Canonical identifier of an automated agent. */
export const AgentId = canonicalUuid7("AgentId")

/** Decoded agent identifier. */
export type AgentId = typeof AgentId.Type

/** Canonical identifier of a deployment environment. */
export const EnvironmentId = canonicalUuid7("EnvironmentId")

/** Decoded environment identifier. */
export type EnvironmentId = typeof EnvironmentId.Type

/** Canonical identifier of a configured plugin connection. */
export const PluginConnectionId = canonicalUuid7("PluginConnectionId")

/** Decoded plugin-connection identifier. */
export type PluginConnectionId = typeof PluginConnectionId.Type

/** Canonical identifier of a collaborator role assignment. */
export const RoleAssignmentId = canonicalUuid7("RoleAssignmentId")

/** Decoded role-assignment identifier. */
export type RoleAssignmentId = typeof RoleAssignmentId.Type
