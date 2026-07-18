import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type * as Stream from "effect/Stream"

import type { AgentHistoryMessage, AgentPrompt, AgentProvider, ReleaseAgentTurnResponse } from "../../api/agent.js"
import type {
  ApplyRelationshipRepairProposalResponse,
  CreateRelationshipRepairProposalRequest,
  EvidenceInspection,
  RelationshipHistoryInspection,
  RelationshipRepairCandidates,
  RelationshipRepairProposalDraft,
  RelationshipRepairProposalList,
  ReleaseDeliveryGraphInspection,
  ReviewRelationshipRepairProposalRequest,
  WorkspaceEntityProjectionIndex
} from "../../api/deliveryGraph.js"
import type { ControlCenterLiveEvent } from "../../api/liveEvents.js"
import type { OpaqueMediaId, SafeMediaContentType } from "../../api/media.js"
import type {
  CreatePluginConnectionRequest,
  CreatePluginConnectionResponse,
  PatchPluginConfigurationRequest,
  PluginConfiguration,
  PluginConfigurationMetadata,
  PluginConnectionSummary,
  PluginConnectionTestResult,
  PluginHealthResponse
} from "../../api/plugins.js"
import type { PortfolioSnapshot } from "../../api/portfolio.js"
import type {
  AuthorizedShareResolution,
  AuthorizedShareSummary,
  CreateAuthorizedShareRequest
} from "../../api/shares.js"
import type { Actor } from "../../domain/actors.js"
import type {
  DeliveryEntityKind,
  DeliveryEntityService,
  DeliveryEntityStatusGroup,
  DeliveryRelationship,
  LedgerRevision
} from "../../domain/deliveryGraph.js"
import type {
  EnvironmentId,
  EventCursor,
  EvidenceId,
  PersonId,
  PluginConnectionId,
  RelationshipId,
  RelationshipRepairProposalId,
  ReleaseId,
  SessionId,
  ShareId,
  WorkspaceId
} from "../../domain/identifiers.js"
import type { RelationshipRepairProposal } from "../../domain/relationshipRepair.js"
import type { TimelineActorKind, TimelineCursor, TimelineEventDetail, TimelinePage } from "../../domain/timeline.js"
import { UtcTimestamp } from "../../domain/utcTimestamp.js"

/** An authenticated resource does not exist within the caller's workspace. */
export class ApplicationResourceNotFound extends Schema.TaggedErrorClass<ApplicationResourceNotFound>()(
  "ApplicationResourceNotFound",
  {}
) {}

/** A bounded application operation cannot currently be served. */
export class ApplicationServiceUnavailable extends Schema.TaggedErrorClass<ApplicationServiceUnavailable>()(
  "ApplicationServiceUnavailable",
  { retryAt: Schema.NullOr(UtcTimestamp) }
) {}

/** A provider-specific read budget was exhausted. */
export class ApplicationRateLimited extends Schema.TaggedErrorClass<ApplicationRateLimited>()(
  "ApplicationRateLimited",
  { retryAt: Schema.NullOr(UtcTimestamp) }
) {}

/** Durable state changed since the caller read its compare-and-swap revision. */
export class ApplicationConflict extends Schema.TaggedErrorClass<ApplicationConflict>()(
  "ApplicationConflict",
  {}
) {}

/** An application-level mutation failed validation after transport decoding. */
export class ApplicationInvalidRequest extends Schema.TaggedErrorClass<ApplicationInvalidRequest>()(
  "ApplicationInvalidRequest",
  {}
) {}

export type PluginAdministrationError =
  | ApplicationRateLimited
  | ApplicationResourceNotFound
  | ApplicationServiceUnavailable

/** Secret-free plugin administration seam. Executor processes are deliberately absent. */
export interface PluginAdministrationService {
  readonly list: (
    workspaceId: WorkspaceId
  ) => Effect.Effect<ReadonlyArray<PluginConnectionSummary>, ApplicationServiceUnavailable>
  readonly connectAndTest?: (input: {
    readonly workspaceId: WorkspaceId
    readonly request: CreatePluginConnectionRequest
  }) => Effect.Effect<
    CreatePluginConnectionResponse,
    ApplicationConflict | ApplicationInvalidRequest | PluginAdministrationError
  >
  readonly setConnectionEnabled?: (input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
    readonly isEnabled: boolean
  }) => Effect.Effect<
    PluginConnectionSummary,
    ApplicationConflict | ApplicationInvalidRequest | PluginAdministrationError
  >
  readonly health: (input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
  }) => Effect.Effect<typeof PluginHealthResponse.Type, PluginAdministrationError>
  readonly testConnection: (input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
  }) => Effect.Effect<PluginConnectionTestResult, PluginAdministrationError>
  readonly configurationMetadata: (input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
  }) => Effect.Effect<PluginConfigurationMetadata, PluginAdministrationError>
  readonly configuration: (input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
  }) => Effect.Effect<typeof PluginConfiguration.Type, PluginAdministrationError>
  readonly patchConfiguration: (input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
    readonly patch: typeof PatchPluginConfigurationRequest.Type
  }) => Effect.Effect<
    typeof PluginConfiguration.Type,
    | ApplicationConflict
    | ApplicationInvalidRequest
    | PluginAdministrationError
  >
}

/** Injectable plugin query boundary used by the HTTP handlers. */
export class PluginAdministration extends Context.Service<
  PluginAdministration,
  PluginAdministrationService
>()("@knpkv/control-center/server/api/PluginAdministration") {}

/** Injectable bird's-eye portfolio projection boundary. */
export class PortfolioSnapshots extends Context.Service<PortfolioSnapshots, {
  readonly snapshot: (
    workspaceId: WorkspaceId
  ) => Effect.Effect<PortfolioSnapshot, ApplicationServiceUnavailable>
}>()("@knpkv/control-center/server/api/PortfolioSnapshots") {}

/** Injectable, default-redacted workspace Timeline read boundary. */
export class TimelineReads extends Context.Service<TimelineReads, {
  readonly page: (input: {
    readonly workspaceId: WorkspaceId
    readonly actorKind: TimelineActorKind | null
    readonly before: TimelineCursor | null
    readonly from: UtcTimestamp | null
    readonly limit: number
    readonly to: UtcTimestamp | null
  }) => Effect.Effect<TimelinePage, ApplicationServiceUnavailable>
  readonly detail: (input: {
    readonly workspaceId: WorkspaceId
    readonly eventKey: string
  }) => Effect.Effect<
    TimelineEventDetail,
    ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
}>()("@knpkv/control-center/server/api/TimelineReads") {}

/** Durable attribution boundary for successfully collected Timeline downloads. */
export class TimelineExportAudits extends Context.Service<TimelineExportAudits, {
  readonly record: (input: {
    readonly workspaceId: WorkspaceId
    readonly personId: PersonId
    readonly sessionId: SessionId
    readonly format: "csv" | "json"
    readonly actorKind: TimelineActorKind | null
    readonly from: UtcTimestamp | null
    readonly to: UtcTimestamp | null
    readonly requestedLimit: number
    readonly returnedCount: number
    readonly truncated: boolean
  }) => Effect.Effect<void, ApplicationServiceUnavailable>
}>()("@knpkv/control-center/server/api/TimelineExportAudits") {}

/** Exact-entity authenticated share creation, resolution, and revocation boundary. */
export class AuthorizedShares extends Context.Service<AuthorizedShares, {
  readonly create: (input: {
    readonly workspaceId: WorkspaceId
    readonly request: CreateAuthorizedShareRequest
    readonly createdByPersonId: PersonId
    readonly sessionId: SessionId
  }) => Effect.Effect<
    AuthorizedShareSummary,
    ApplicationConflict | ApplicationInvalidRequest | ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
  readonly resolve: (input: {
    readonly workspaceId: WorkspaceId
    readonly shareId: ShareId
    readonly actor: Actor
  }) => Effect.Effect<
    AuthorizedShareResolution,
    ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
  readonly revoke: (input: {
    readonly workspaceId: WorkspaceId
    readonly shareId: ShareId
    readonly revokedByPersonId: PersonId
    readonly sessionId: SessionId
  }) => Effect.Effect<void, ApplicationResourceNotFound | ApplicationServiceUnavailable>
}>()("@knpkv/control-center/server/api/AuthorizedShares") {}

/** Workspace-scoped read boundary for relationship, lifecycle, and evidence inspection. */
export class DeliveryGraphInspection extends Context.Service<DeliveryGraphInspection, {
  readonly workspaceEntityProjections: (
    input: {
      readonly workspaceId: WorkspaceId
      readonly owner: PersonId | null
      readonly query: string | null
      readonly service: DeliveryEntityService | null
      readonly status: DeliveryEntityStatusGroup | null
      readonly type: DeliveryEntityKind | null
    }
  ) => Effect.Effect<
    WorkspaceEntityProjectionIndex,
    ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
  readonly releaseSlice: (input: {
    readonly workspaceId: WorkspaceId
    readonly releaseId: ReleaseId
    readonly environmentId: EnvironmentId | null
  }) => Effect.Effect<
    ReleaseDeliveryGraphInspection,
    ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
  readonly repairCandidates: (input: {
    readonly workspaceId: WorkspaceId
    readonly releaseId: ReleaseId
    readonly environmentId: EnvironmentId | null
  }) => Effect.Effect<
    RelationshipRepairCandidates,
    ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
  readonly repairProposalDraft: (input: {
    readonly workspaceId: WorkspaceId
    readonly releaseId: ReleaseId
    readonly environmentId: EnvironmentId | null
    readonly relationshipId: RelationshipId
    readonly revision: LedgerRevision
  }) => Effect.Effect<
    RelationshipRepairProposalDraft,
    ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
  readonly relationship: (input: {
    readonly workspaceId: WorkspaceId
    readonly relationshipId: RelationshipId
    readonly revision: LedgerRevision | null
  }) => Effect.Effect<
    DeliveryRelationship,
    ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
  readonly relationshipHistory: (input: {
    readonly workspaceId: WorkspaceId
    readonly relationshipId: RelationshipId
  }) => Effect.Effect<
    RelationshipHistoryInspection,
    ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
  readonly evidence: (input: {
    readonly workspaceId: WorkspaceId
    readonly evidenceId: EvidenceId
  }) => Effect.Effect<
    EvidenceInspection,
    ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
}>()("@knpkv/control-center/server/api/DeliveryGraphInspection") {}

/** Authenticated mutation boundary for durable relationship-repair proposals. */
export class RelationshipRepairProposals extends Context.Service<RelationshipRepairProposals, {
  readonly create: (input: {
    readonly workspaceId: WorkspaceId
    readonly releaseId: ReleaseId
    readonly relationshipId: RelationshipId
    readonly request: CreateRelationshipRepairProposalRequest
    readonly actor: Actor
    readonly sessionId: SessionId
  }) => Effect.Effect<
    RelationshipRepairProposal,
    ApplicationConflict | ApplicationInvalidRequest | ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
  readonly get: (input: {
    readonly workspaceId: WorkspaceId
    readonly proposalId: RelationshipRepairProposalId
  }) => Effect.Effect<
    RelationshipRepairProposal,
    ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
  readonly list: (input: {
    readonly workspaceId: WorkspaceId
    readonly releaseId: ReleaseId
    readonly environmentId: EnvironmentId | null
    readonly status: RelationshipRepairProposal["status"] | null
  }) => Effect.Effect<
    RelationshipRepairProposalList,
    ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
  readonly review: (input: {
    readonly workspaceId: WorkspaceId
    readonly proposalId: RelationshipRepairProposalId
    readonly request: ReviewRelationshipRepairProposalRequest
    readonly actor: Actor
    readonly sessionId: SessionId
  }) => Effect.Effect<
    RelationshipRepairProposal,
    ApplicationConflict | ApplicationInvalidRequest | ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
  readonly apply: (input: {
    readonly workspaceId: WorkspaceId
    readonly proposalId: RelationshipRepairProposalId
    readonly actor: Actor
    readonly sessionId: SessionId
  }) => Effect.Effect<
    ApplyRelationshipRepairProposalResponse,
    ApplicationConflict | ApplicationInvalidRequest | ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
}>()("@knpkv/control-center/server/api/RelationshipRepairProposals") {}

/**
 * Release-aware conversational boundary. Implementations own context projection,
 * provider selection, prompt hardening, cancellation, and provider error redaction.
 */
export class ReleaseAgentTurns extends Context.Service<ReleaseAgentTurns, {
  readonly runTurn: (input: {
    readonly workspaceId: WorkspaceId
    readonly releaseId: ReleaseId
    readonly provider: AgentProvider
    readonly prompt: AgentPrompt
    readonly history: ReadonlyArray<AgentHistoryMessage>
  }) => Effect.Effect<
    ReleaseAgentTurnResponse,
    ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
}>()("@knpkv/control-center/server/api/ReleaseAgentTurns") {}

/** Injectable durable replay boundary used by the authenticated SSE handler. */
export class LiveEvents extends Context.Service<LiveEvents, {
  readonly open: (input: {
    readonly workspaceId: WorkspaceId
    readonly after: EventCursor | undefined
  }) => Effect.Effect<Stream.Stream<ControlCenterLiveEvent>, ApplicationServiceUnavailable, Scope.Scope>
}>()("@knpkv/control-center/server/api/LiveEvents") {}

/** Fully authorized media stream whose provider address and storage key remain private. */
export interface MediaRead {
  readonly body: Stream.Stream<Uint8Array>
  readonly contentLength: number
  readonly contentType: SafeMediaContentType
}

/** Injectable opaque media boundary; implementations must authorize before returning a stream. */
export class MediaReads extends Context.Service<MediaReads, {
  readonly read: (input: {
    readonly workspaceId: WorkspaceId
    readonly mediaId: OpaqueMediaId
  }) => Effect.Effect<MediaRead, ApplicationResourceNotFound | ApplicationServiceUnavailable>
}>()("@knpkv/control-center/server/api/MediaReads") {}
