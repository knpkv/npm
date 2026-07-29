import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Schema from "effect/Schema"

import type { SessionSummary } from "../../api/session.js"
import type { Role } from "../../domain/actors.js"
import { governedActionPermissionGrants } from "../../domain/governedAction/index.js"
import { PersonId, SessionId, WorkspaceId, WorkspaceSettingsMutationId } from "../../domain/identifiers.js"
import type { UtcTimestamp } from "../../domain/utcTimestamp.js"
import { GovernedWorkspaceSettingsSections, WorkspaceSettingsV1 } from "../../domain/workspaceSettings.js"
import { ContentBlobDigest, RecordRevision } from "../persistence/repositories/models.js"

/** Provider-neutral D03 policy input shared by local and plugin mutations. */
export interface GovernedHumanMutationPolicyInput {
  readonly requiredPermission: Role
  readonly session: SessionSummary
  readonly workspaceId: WorkspaceId
}

/** Evaluate the common human-session permission and workspace rules. */
export const governedHumanMutationPolicyAllows = (
  input: GovernedHumanMutationPolicyInput
): boolean =>
  input.session.actor._tag === "human" &&
  input.session.workspaceId === input.workspaceId &&
  governedActionPermissionGrants(
    input.session.permission,
    input.requiredPermission
  )

export const WorkspaceSettingsGovernanceRequest = Schema.Struct({
  workspaceId: WorkspaceId,
  mutationId: WorkspaceSettingsMutationId,
  expectedRevision: RecordRevision,
  settings: WorkspaceSettingsV1,
  acknowledgedGovernedSections: GovernedWorkspaceSettingsSections,
  actorPersonId: PersonId,
  sessionId: SessionId
})

export type WorkspaceSettingsGovernanceRequest = typeof WorkspaceSettingsGovernanceRequest.Type

const WorkspaceSettingsGovernanceRequestJson = Schema.fromJsonString(
  WorkspaceSettingsGovernanceRequest
)
const encodeRequest = Schema.encodeEffect(WorkspaceSettingsGovernanceRequestJson)

/** Digest one exact attributable settings request using the D03 digest convention. */
export const digestWorkspaceSettingsGovernanceRequest = Effect.fn(
  "GovernedHumanMutationPolicyEvaluator.digestWorkspaceSettingsRequest"
)(function*(request: WorkspaceSettingsGovernanceRequest) {
  const encoded = yield* encodeRequest(request)
  const bytes = yield* Effect.fromResult(
    Encoding.decodeBase64(Encoding.encodeBase64(encoded))
  )
  const cryptoService = yield* Crypto.Crypto
  const digest = yield* cryptoService.digest("SHA-256", bytes)
  return ContentBlobDigest.make(Encoding.encodeHex(digest))
})

const issuedAuthorities = new WeakSet<object>()

/**
 * Nominal, process-local proof that the common D03 human policy authorized one
 * exact governed settings request. It cannot be constructed from HTTP or JSON.
 */
export class WorkspaceSettingsGovernanceAuthority {
  readonly authorizedAt: UtcTimestamp
  readonly requestDigest: ContentBlobDigest

  constructor(
    requestDigest: ContentBlobDigest,
    authorizedAt: UtcTimestamp
  ) {
    this.authorizedAt = authorizedAt
    this.requestDigest = requestDigest
  }
}

/** Issue a nominal authority only for an exact current human-owner request. */
export const authorizeWorkspaceSettingsGovernanceRequest = Effect.fn(
  "GovernedHumanMutationPolicyEvaluator.authorizeWorkspaceSettingsRequest"
)(function*(
  session: SessionSummary,
  request: WorkspaceSettingsGovernanceRequest,
  authorizedAt: UtcTimestamp
) {
  if (
    !governedHumanMutationPolicyAllows({
      requiredPermission: "workspace-owner",
      session,
      workspaceId: request.workspaceId
    }) ||
    session.actor._tag !== "human" ||
    session.actor.personId !== request.actorPersonId ||
    session.sessionId !== request.sessionId
  ) {
    return null
  }
  const authority = new WorkspaceSettingsGovernanceAuthority(
    yield* digestWorkspaceSettingsGovernanceRequest(request),
    authorizedAt
  )
  issuedAuthorities.add(authority)
  return authority
})

/** Verify that an authority was issued here for the exact persisted request. */
export const workspaceSettingsGovernanceAuthorityMatches = (
  authority: WorkspaceSettingsGovernanceAuthority | null,
  requestDigest: ContentBlobDigest,
  authorizedAt: UtcTimestamp
): boolean =>
  authority !== null &&
  issuedAuthorities.has(authority) &&
  authority.requestDigest === requestDigest &&
  DateTime.Equivalence(authority.authorizedAt, authorizedAt)
