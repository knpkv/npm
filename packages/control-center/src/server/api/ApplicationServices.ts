import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type * as Stream from "effect/Stream"

import type {
  AgentHistoryMessage,
  AgentPrompt,
  AgentProvider,
  AgentProviderCatalog,
  DismissReviewSuggestionRequest,
  DismissReviewSuggestionResponse,
  EditReviewSuggestionRequest,
  EditReviewSuggestionResponse,
  EnqueuePullRequestReviewRequest,
  EnqueuePullRequestReviewResponse,
  EnqueueReleaseAgentJobRequest,
  EnqueueReleaseAgentJobResponse,
  PublishedReviewComment,
  PublishReviewSuggestionRequest,
  PullRequestReviewState,
  PullRequestReviewThreadPage,
  ReleaseAgentThreadCursor,
  ReleaseAgentThreadPage,
  ReleaseAgentTurnResponse,
  ReviewSuggestionPublicationPreview,
  ReviewSuggestionRevisionPage,
  TargetReviewSuggestionRequest,
  TargetReviewSuggestionResponse
} from "../../api/agent.js"
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
  WorkspaceEntityInspection,
  WorkspaceEntityProjectionIndex
} from "../../api/deliveryGraph.js"
import type { CompleteDiffContentRange, CompleteDiffInventory, CompleteDiffInventoryEntry } from "../../api/diff.js"
import type { ControlCenterLiveEvent } from "../../api/liveEvents.js"
import type { OpaqueMediaId, SafeMediaContentType } from "../../api/media.js"
import type {
  AtlassianOAuthClientConfiguration,
  AtlassianOAuthGrantExchangeResponse,
  AtlassianOAuthGrantId,
  AtlassianOAuthGrantStartResponse,
  AtlassianOAuthProviderIntent,
  AtlassianProfileDiscoveryResponse,
  AwsProfileDiscoveryResponse,
  AwsResourceDiscoveryRequest,
  AwsResourceDiscoveryResponse,
  CreatePluginConnectionRequest,
  CreatePluginConnectionResponse,
  CreatePluginConnectionsResponse,
  DiscoveredAtlassianProfile,
  PatchPluginConfigurationRequest,
  PatchProviderAccountRequest,
  PluginConfiguration,
  PluginConfigurationMetadata,
  PluginConnectionAdministration,
  PluginConnectionSummary,
  PluginConnectionTestResult,
  PluginCredentialReplacement,
  PluginHealthResponse,
  PluginSynchronizationState,
  ProviderAccountSummary
} from "../../api/plugins.js"
import type { PortfolioSnapshot } from "../../api/portfolio.js"
import type {
  AuthorizedShareResolution,
  AuthorizedShareSummary,
  CreateAuthorizedShareRequest
} from "../../api/shares.js"
import type { UpdateWorkspaceSettingsRequest, WorkspaceSettingsReadModel } from "../../api/workspaceSettings.js"
import type { Actor } from "../../domain/actors.js"
import type {
  DeliveryEntityKind,
  DeliveryEntityService,
  DeliveryEntityStatusGroup,
  DeliveryRelationship,
  LedgerRevision
} from "../../domain/deliveryGraph.js"
import type {
  EntityId,
  EnvironmentId,
  EventCursor,
  EvidenceId,
  JobId,
  PersonId,
  PluginConnectionId,
  ProviderAccountId,
  RelationshipId,
  RelationshipRepairProposalId,
  ReleaseId,
  SessionId,
  ShareId,
  WorkspaceId
} from "../../domain/identifiers.js"
import type {
  PluginPipelineArtifactRangeRequestV1,
  PluginPipelineLogPageRequestV1,
  PluginPipelineLogPageV1
} from "../../domain/plugins/index.js"
import type { PrReviewSuggestionId } from "../../domain/prReview.js"
import type {
  PrReviewSuggestionRevisionPageSize,
  PrReviewSuggestionRevisionSequence
} from "../../domain/prReviewRevision.js"
import type { RelationshipRepairProposal } from "../../domain/relationshipRepair.js"
import type { Revision, VendorImmutableId } from "../../domain/sourceRevision.js"
import type { TimelineActorKind, TimelineCursor, TimelineEventDetail, TimelinePage } from "../../domain/timeline.js"
import { UtcTimestamp } from "../../domain/utcTimestamp.js"
import type { SessionSummary } from "../auth/models.js"

/** An authenticated resource does not exist within the caller's workspace. */
export class ApplicationResourceNotFound extends Schema.TaggedError<ApplicationResourceNotFound>()(
  "ApplicationResourceNotFound",
  {}
) {}

/** A bounded application operation cannot currently be served. */
export class ApplicationServiceUnavailable extends Schema.TaggedError<ApplicationServiceUnavailable>()(
  "ApplicationServiceUnavailable",
  { retryAt: Schema.NullOr(UtcTimestamp) }
) {}

/** A provider-specific read budget was exhausted. */
export class ApplicationRateLimited extends Schema.TaggedError<ApplicationRateLimited>()(
  "ApplicationRateLimited",
  { retryAt: Schema.NullOr(UtcTimestamp) }
) {}

/** Durable state changed since the caller read its compare-and-swap revision. */
export class ApplicationConflict extends Schema.TaggedError<ApplicationConflict>()(
  "ApplicationConflict",
  {}
) {}

/** An application-level mutation failed validation after transport decoding. */
export class ApplicationInvalidRequest extends Schema.TaggedError<ApplicationInvalidRequest>()(
  "ApplicationInvalidRequest",
  {}
) {}

/** Authenticated read and owner-only compare-and-swap mutation boundary for workspace settings. */
export class WorkspaceSettingsAdministration extends Context.Service<
  WorkspaceSettingsAdministration,
  {
    readonly read: (
      workspaceId: WorkspaceId
    ) => Effect.Effect<WorkspaceSettingsReadModel, ApplicationServiceUnavailable>
    readonly update: (input: {
      readonly workspaceId: WorkspaceId
      readonly request: UpdateWorkspaceSettingsRequest
      readonly session: SessionSummary
    }) => Effect.Effect<
      WorkspaceSettingsReadModel,
      ApplicationConflict | ApplicationInvalidRequest | ApplicationServiceUnavailable
    >
  }
>()("@knpkv/control-center/server/api/WorkspaceSettingsAdministration") {}

export type PluginAdministrationError =
  | ApplicationRateLimited
  | ApplicationResourceNotFound
  | ApplicationServiceUnavailable

/** Secret-free plugin administration seam. Executor processes are deliberately absent. */
export interface PluginAdministrationService {
  readonly list: (
    workspaceId: WorkspaceId
  ) => Effect.Effect<ReadonlyArray<PluginConnectionSummary>, ApplicationServiceUnavailable>
  readonly accounts?: (
    workspaceId: WorkspaceId
  ) => Effect.Effect<ReadonlyArray<ProviderAccountSummary>, ApplicationServiceUnavailable>
  readonly patchProviderAccount?: (input: {
    readonly workspaceId: WorkspaceId
    readonly providerAccountId: ProviderAccountId
    readonly patch: PatchProviderAccountRequest
  }) => Effect.Effect<
    ProviderAccountSummary,
    ApplicationConflict | ApplicationInvalidRequest | PluginAdministrationError
  >
  readonly discoverAwsProfiles?: () => Effect.Effect<AwsProfileDiscoveryResponse, ApplicationServiceUnavailable>
  readonly discoverAwsResources?: (
    request: AwsResourceDiscoveryRequest
  ) => Effect.Effect<
    AwsResourceDiscoveryResponse,
    ApplicationInvalidRequest | ApplicationRateLimited | ApplicationServiceUnavailable
  >
  readonly discoverAtlassianProfiles?: () => Effect.Effect<
    AtlassianProfileDiscoveryResponse,
    ApplicationServiceUnavailable
  >
  readonly startAtlassianOAuthGrant?: (input: {
    readonly workspaceId: WorkspaceId
    readonly sessionId: SessionId
    readonly providers: AtlassianOAuthProviderIntent
    readonly configuration?: AtlassianOAuthClientConfiguration
  }) => Effect.Effect<
    AtlassianOAuthGrantStartResponse,
    ApplicationConflict | ApplicationServiceUnavailable
  >
  readonly exchangeAtlassianOAuthGrant?: (input: {
    readonly workspaceId: WorkspaceId
    readonly sessionId: SessionId
    readonly grantId: AtlassianOAuthGrantId
    readonly code: string
  }) => Effect.Effect<
    AtlassianOAuthGrantExchangeResponse,
    ApplicationInvalidRequest | PluginAdministrationError
  >
  readonly completeAtlassianOAuthGrant?: (input: {
    readonly workspaceId: WorkspaceId
    readonly sessionId: SessionId
    readonly grantId: AtlassianOAuthGrantId
    readonly cloudId: string
  }) => Effect.Effect<
    DiscoveredAtlassianProfile,
    ApplicationInvalidRequest | PluginAdministrationError
  >
  readonly connectAndTest?: (input: {
    readonly workspaceId: WorkspaceId
    readonly request: CreatePluginConnectionRequest
  }) => Effect.Effect<
    CreatePluginConnectionResponse,
    ApplicationConflict | ApplicationInvalidRequest | PluginAdministrationError
  >
  readonly connectAndTestBatch?: (input: {
    readonly workspaceId: WorkspaceId
    readonly requests: ReadonlyArray<CreatePluginConnectionRequest>
  }) => Effect.Effect<CreatePluginConnectionsResponse>
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
  readonly synchronization?: (input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
  }) => Effect.Effect<
    PluginSynchronizationState,
    ApplicationInvalidRequest | PluginAdministrationError
  >
  readonly synchronizeConnection?: (input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
  }) => Effect.Effect<
    PluginSynchronizationState,
    ApplicationInvalidRequest | PluginAdministrationError
  >
  readonly administration?: (input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
  }) => Effect.Effect<
    PluginConnectionAdministration,
    ApplicationInvalidRequest | PluginAdministrationError
  >
  readonly reauthorizeConnection?: (input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
    readonly expectedRevision: number
    readonly credentials: ReadonlyArray<PluginCredentialReplacement>
  }) => Effect.Effect<
    CreatePluginConnectionResponse,
    ApplicationConflict | ApplicationInvalidRequest | PluginAdministrationError
  >
  readonly revokeConnection?: (input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
    readonly expectedRevision: number
  }) => Effect.Effect<
    PluginConnectionSummary,
    ApplicationConflict | ApplicationInvalidRequest | PluginAdministrationError
  >
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

export type CompleteDiffReadError =
  | ApplicationConflict
  | ApplicationRateLimited
  | ApplicationResourceNotFound
  | ApplicationServiceUnavailable

/** Workspace-scoped application boundary for complete immutable diff reads. */
export class CompleteDiffReads extends Context.Service<CompleteDiffReads, {
  readonly content: (input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
    readonly vendorImmutableId: VendorImmutableId
    readonly revision: Revision
    readonly anchor: CompleteDiffInventoryEntry["anchor"]
    readonly path: CompleteDiffInventoryEntry["path"]
    readonly previousPath: CompleteDiffInventoryEntry["previousPath"]
    readonly status: CompleteDiffInventoryEntry["status"]
    readonly side: "before" | "after"
    readonly offset: number
    readonly length: number
  }) => Effect.Effect<CompleteDiffContentRange, CompleteDiffReadError>
  readonly inventory: (input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
    readonly vendorImmutableId: VendorImmutableId
    readonly revision: Revision
  }) => Effect.Effect<CompleteDiffInventory, CompleteDiffReadError>
}>()("@knpkv/control-center/server/api/CompleteDiffReads") {}

/** Fully authorized artifact bytes with provider storage coordinates removed. */
export interface CodePipelineArtifactRead {
  readonly body: Uint8Array
  readonly contentLength: number
  readonly filename: string
  readonly offset: number
  readonly totalBytes: number
}

/** Workspace-scoped bounded CodePipeline evidence reads. */
export class CodePipelineReads extends Context.Service<CodePipelineReads, {
  readonly logs: (input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
    readonly request: PluginPipelineLogPageRequestV1
  }) => Effect.Effect<PluginPipelineLogPageV1, CompleteDiffReadError>
  readonly artifact: (input: {
    readonly workspaceId: WorkspaceId
    readonly pluginConnectionId: PluginConnectionId
    readonly request: PluginPipelineArtifactRangeRequestV1
  }) => Effect.Effect<CodePipelineArtifactRead, CompleteDiffReadError>
}>()("@knpkv/control-center/server/api/CodePipelineReads") {}

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
  readonly workspaceEntity: (input: {
    readonly workspaceId: WorkspaceId
    readonly entityId: EntityId
  }) => Effect.Effect<
    WorkspaceEntityInspection,
    ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
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
export interface ReleaseAgentTurnAdmission {
  readonly eventCursor: ReleaseAgentTurnResponse["eventCursor"]
  readonly provider: ReleaseAgentTurnResponse["provider"]
  readonly release: ReleaseAgentTurnResponse["release"]
  readonly releaseId: ReleaseAgentTurnResponse["releaseId"]
  readonly workspaceId: WorkspaceId
}

export class ReleaseAgentTurns extends Context.Service<ReleaseAgentTurns, {
  readonly admitTurn?: (input: {
    readonly workspaceId: WorkspaceId
    readonly releaseId: ReleaseId
    readonly provider: AgentProvider
  }) => Effect.Effect<
    ReleaseAgentTurnAdmission,
    ApplicationInvalidRequest | ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
  readonly runTurn: (input: {
    readonly admission?: ReleaseAgentTurnAdmission
    readonly workspaceId: WorkspaceId
    readonly releaseId: ReleaseId
    readonly originPath?: string
    readonly provider: AgentProvider
    readonly prompt: AgentPrompt
    readonly history: ReadonlyArray<AgentHistoryMessage>
    readonly publicationResult?: string
  }) => Effect.Effect<
    ReleaseAgentTurnResponse,
    ApplicationInvalidRequest | ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
}>()("@knpkv/control-center/server/api/ReleaseAgentTurns") {}

/**
 * Provider-neutral durable release-agent boundary. Implementations derive job,
 * context, and workspace ownership server-side and return only browser-safe events.
 */
export class ReleaseAgentJobs extends Context.Service<ReleaseAgentJobs, {
  readonly enqueue: (input: {
    readonly workspaceId: WorkspaceId
    readonly releaseId: ReleaseId
    readonly request: EnqueueReleaseAgentJobRequest
  }) => Effect.Effect<
    EnqueueReleaseAgentJobResponse,
    ApplicationInvalidRequest | ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
  readonly providers: (workspaceId: WorkspaceId) => Effect.Effect<
    AgentProviderCatalog,
    ApplicationServiceUnavailable
  >
  readonly replay: (input: {
    readonly workspaceId: WorkspaceId
    readonly releaseId: ReleaseId
    readonly after: ReleaseAgentThreadCursor
    readonly limit: number
  }) => Effect.Effect<
    ReleaseAgentThreadPage,
    ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
}>()("@knpkv/control-center/server/api/ReleaseAgentJobs") {}

/** Server-owned orchestration for one exact immutable pull-request review. */
export class PullRequestReviews extends Context.Service<PullRequestReviews, {
  readonly thread: (input: {
    readonly workspaceId: WorkspaceId
    readonly entityId: EntityId
    readonly after: ReleaseAgentThreadCursor | null
    readonly before?: ReleaseAgentThreadCursor | null
    readonly limit: number
  }) => Effect.Effect<
    PullRequestReviewThreadPage,
    ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
  readonly current: (input: {
    readonly workspaceId: WorkspaceId
    readonly entityId: EntityId
  }) => Effect.Effect<
    PullRequestReviewState,
    ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
  readonly enqueue: (input: {
    readonly workspaceId: WorkspaceId
    readonly entityId: EntityId
    readonly request: EnqueuePullRequestReviewRequest
  }) => Effect.Effect<
    EnqueuePullRequestReviewResponse,
    ApplicationInvalidRequest | ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
  readonly cancel: (input: {
    readonly workspaceId: WorkspaceId
    readonly entityId: EntityId
    readonly jobId: JobId
  }) => Effect.Effect<
    PullRequestReviewState,
    ApplicationInvalidRequest | ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
  readonly extendBudget: (input: {
    readonly workspaceId: WorkspaceId
    readonly entityId: EntityId
    readonly jobId: JobId
  }) => Effect.Effect<
    PullRequestReviewState,
    ApplicationInvalidRequest | ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
  readonly revisions: (input: {
    readonly workspaceId: WorkspaceId
    readonly entityId: EntityId
    readonly jobId: JobId
    readonly suggestionId: PrReviewSuggestionId
    readonly beforeSequence: PrReviewSuggestionRevisionSequence | null
    readonly limit: PrReviewSuggestionRevisionPageSize
  }) => Effect.Effect<
    ReviewSuggestionRevisionPage,
    ApplicationInvalidRequest | ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
  readonly editSuggestion: (input: {
    readonly workspaceId: WorkspaceId
    readonly entityId: EntityId
    readonly jobId: JobId
    readonly suggestionId: PrReviewSuggestionId
    readonly request: EditReviewSuggestionRequest
    readonly session: SessionSummary
  }) => Effect.Effect<
    EditReviewSuggestionResponse,
    | ApplicationConflict
    | ApplicationInvalidRequest
    | ApplicationResourceNotFound
    | ApplicationServiceUnavailable
  >
  readonly targetSuggestion: (input: {
    readonly workspaceId: WorkspaceId
    readonly entityId: EntityId
    readonly jobId: JobId
    readonly suggestionId: PrReviewSuggestionId
    readonly request: TargetReviewSuggestionRequest
  }) => Effect.Effect<
    TargetReviewSuggestionResponse,
    | ApplicationConflict
    | ApplicationInvalidRequest
    | ApplicationResourceNotFound
    | ApplicationServiceUnavailable
  >
  readonly dismissSuggestion: (input: {
    readonly workspaceId: WorkspaceId
    readonly entityId: EntityId
    readonly jobId: JobId
    readonly suggestionId: PrReviewSuggestionId
    readonly request: DismissReviewSuggestionRequest
    readonly session: SessionSummary
  }) => Effect.Effect<
    DismissReviewSuggestionResponse,
    | ApplicationConflict
    | ApplicationInvalidRequest
    | ApplicationResourceNotFound
    | ApplicationServiceUnavailable
  >
  readonly previewPublication: (input: {
    readonly workspaceId: WorkspaceId
    readonly entityId: EntityId
    readonly jobId: PublishReviewSuggestionRequest["jobId"]
    readonly suggestionId: PublishReviewSuggestionRequest["suggestionId"]
    readonly revisionId: PublishReviewSuggestionRequest["revisionId"]
    readonly operation?: PublishReviewSuggestionRequest["operation"]
    readonly commentId?: PublishReviewSuggestionRequest["commentId"]
    readonly publishingOperator: Extract<Actor, { readonly _tag: "human" }>["personId"]
  }) => Effect.Effect<
    ReviewSuggestionPublicationPreview,
    ApplicationInvalidRequest | ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
  readonly publishSuggestion: (input: {
    readonly workspaceId: WorkspaceId
    readonly entityId: EntityId
    readonly request: PublishReviewSuggestionRequest
    readonly session: SessionSummary
  }) => Effect.Effect<
    PublishedReviewComment,
    ApplicationInvalidRequest | ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
}>()("@knpkv/control-center/server/api/PullRequestReviews") {}

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
