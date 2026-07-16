import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import {
  AgentId,
  EntityId,
  EnvironmentId,
  PersonId,
  PluginConnectionId,
  ReleaseId,
  RoleAssignmentId,
  WorkspaceId
} from "./identifiers.js"
import { ProviderId, VendorImmutableId } from "./sourceRevision.js"
import { UtcTimestamp } from "./utcTimestamp.js"

const DisplayName = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(200))
const AvatarReferenceValue = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(500)
)
const Initials = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(4))

/** An immutable provider identity associated with a canonical person. */
export const PersonSourceIdentity = Schema.Struct({
  pluginConnectionId: PluginConnectionId,
  providerId: ProviderId,
  vendorPersonId: VendorImmutableId
})

/** Decoded person identity from a provider. */
export type PersonSourceIdentity = typeof PersonSourceIdentity.Type

/** Avatar media reference or deterministic initials fallback. */
export const PersonAvatar = Schema.TaggedUnion({
  initials: {
    text: Initials
  },
  reference: {
    reference: AvatarReferenceValue
  }
})

/** Decoded person avatar representation. */
export type PersonAvatar = typeof PersonAvatar.Type

/**
 * Derives a stable one- or two-token initials fallback from a display name.
 * The first code point of the first and last non-empty tokens is used.
 */
export const derivePersonInitials = (displayName: string): string => {
  const tokens = displayName.trim().split(/\s+/u).filter(Boolean)
  const firstToken = tokens.at(0) ?? ""
  const lastToken = tokens.at(-1) ?? ""
  const firstInitial = Array.from(firstToken).at(0) ?? ""
  const lastInitial = tokens.length > 1 ? (Array.from(lastToken).at(0) ?? "") : ""
  return `${firstInitial}${lastInitial}`.toLocaleUpperCase("en-US")
}

const PersonSchema = Schema.Struct({
  avatar: PersonAvatar,
  displayName: DisplayName,
  isActive: Schema.Boolean,
  personId: PersonId,
  sourceIdentities: Schema.Array(PersonSourceIdentity)
}).check(
  Schema.makeFilter(
    ({ avatar, displayName }) => avatar._tag === "reference" || avatar.text === derivePersonInitials(displayName),
    { expected: "initials avatar to match the deterministic display-name fallback" }
  ),
  Schema.makeFilter(
    ({ sourceIdentities }) => {
      const identityKeys = sourceIdentities.map(
        ({ pluginConnectionId, providerId, vendorPersonId }) =>
          `${providerId}\u0000${pluginConnectionId}\u0000${vendorPersonId}`
      )
      return new Set(identityKeys).size === identityKeys.length
    },
    { expected: "person source identities to be unique" }
  )
)

/** Canonical person with provider identities and an accessible avatar fallback. */
export const Person = PersonSchema

/** Decoded canonical person. */
export type Person = typeof Person.Type

/** Human collaborator responsible for a domain action. */
export const HumanActor = Schema.TaggedStruct("human", {
  personId: PersonId
})

/** Decoded human actor. */
export type HumanActor = typeof HumanActor.Type

/** Automated agent responsible for a domain action. */
export const AgentActor = Schema.TaggedStruct("agent", {
  agentId: AgentId
})

/** Decoded agent actor. */
export type AgentActor = typeof AgentActor.Type

/** Human or agent responsible for a domain action. */
export const Actor = Schema.Union([HumanActor, AgentActor]).pipe(Schema.toTaggedUnion("_tag"))

/** Decoded human or agent actor. */
export type Actor = typeof Actor.Type

/** Explicit collaboration role stored with an assignment. */
export const Role = Schema.Literals([
  "workspace-owner",
  "workspace-approver",
  "release-owner",
  "release-approver",
  "change-owner",
  "issue-owner",
  "issue-assignee",
  "page-owner",
  "author",
  "contributor",
  "reviewer",
  "operator",
  "deployment-approver",
  "merge-approver",
  "watcher"
])

/** Decoded collaboration role. */
export type Role = typeof Role.Type

/** Exact domain scope to which a role assignment applies. */
export const RoleScope = Schema.TaggedUnion({
  entity: {
    entityId: EntityId,
    workspaceId: WorkspaceId
  },
  environment: {
    environmentId: EnvironmentId,
    releaseId: ReleaseId,
    workspaceId: WorkspaceId
  },
  release: {
    releaseId: ReleaseId,
    workspaceId: WorkspaceId
  },
  workspace: {
    workspaceId: WorkspaceId
  }
})

/** Decoded role-assignment scope. */
export type RoleScope = typeof RoleScope.Type

const ActiveAssignmentLifecycle = Schema.TaggedStruct("active", {
  assignedAt: UtcTimestamp
})

const EndedAssignmentLifecycle = Schema.TaggedStruct("ended", {
  assignedAt: UtcTimestamp,
  endedAt: UtcTimestamp
}).check(
  Schema.makeFilter(
    ({ assignedAt, endedAt }) => DateTime.Order(assignedAt, endedAt) <= 0,
    { expected: "assignment end time to be at or after assignment time" }
  )
)

const RevokedAssignmentLifecycle = Schema.TaggedStruct("revoked", {
  assignedAt: UtcTimestamp,
  revokedAt: UtcTimestamp
}).check(
  Schema.makeFilter(
    ({ assignedAt, revokedAt }) => DateTime.Order(assignedAt, revokedAt) <= 0,
    { expected: "assignment revocation time to be at or after assignment time" }
  )
)

/** Lifecycle and chronological bounds of a role assignment. */
export const AssignmentLifecycle = Schema.Union([
  ActiveAssignmentLifecycle,
  EndedAssignmentLifecycle,
  RevokedAssignmentLifecycle
]).pipe(Schema.toTaggedUnion("_tag"))

/** Decoded assignment lifecycle. */
export type AssignmentLifecycle = typeof AssignmentLifecycle.Type

/** Persisted binding of a human or agent role to one exact domain scope. */
export const RoleAssignment = Schema.Struct({
  actor: Actor,
  assignmentId: RoleAssignmentId,
  lifecycle: AssignmentLifecycle,
  role: Role,
  scope: RoleScope
})

/** Decoded role assignment. */
export type RoleAssignment = typeof RoleAssignment.Type
