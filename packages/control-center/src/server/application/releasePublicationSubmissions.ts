/** Human-confirmed, append-only release publication boundary for Relay. @module */
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import type { SubmitReleasePublicationRequest, SubmitReleasePublicationResponse } from "../../api/agent.js"
import type { ReleaseDeliveryGraphInspection } from "../../api/deliveryGraph.js"
import { confluenceTaskSummary } from "../../domain/confluenceTasks.js"
import {
  GovernedActionAuthorizationV1,
  GovernedActionCommandId,
  GovernedActionEnvelopeMaterialV1,
  type GovernedActionEvidenceSet,
  GovernedActionIdempotencyKey,
  GovernedActionPluginConnectionAuthorityDigest,
  GovernedActionPluginConnectionRevision,
  type GovernedActionTransitionCause
} from "../../domain/governedAction/index.js"
import {
  DomainEventId,
  type EntityId,
  GovernedActionAuthorizationId,
  GovernedActionId,
  GovernedActionTransitionId,
  type PluginConnectionId,
  type ReleaseId,
  type WorkspaceId
} from "../../domain/identifiers.js"
import { ProposePluginActionRequestV1 } from "../../domain/plugins/index.js"
import { releasePipelineApprovalReadiness } from "../../domain/releasePipelineApproval.js"
import { canonicalReleasePublicationTitle } from "../../domain/releasePublication.js"
import { Revision } from "../../domain/sourceRevision.js"
import type { UtcTimestamp } from "../../domain/utcTimestamp.js"
import type { SessionSummary } from "../auth/models.js"
import {
  digestCanonicalGovernedActionJson,
  digestGovernedActionEvidenceSet,
  makeGovernedActionEnvelope
} from "../governance/governedActionDigests.js"
import {
  GovernedActionPolicyBindingSource,
  GovernedActionProposalAuthority,
  GovernedActionSubmission
} from "../governance/GovernedActionSubmission.js"
import { Persistence, type PersistenceService } from "../persistence/Persistence.js"
import { GovernedActionCommitInput } from "../persistence/repositories/governedActionRepository.js"
import {
  JIRA_RELEASE_VERSION_NAME_MAX_CHARACTERS,
  jiraReleaseVersionDescriptionWithinLimit
} from "../plugins/jira/JiraReleaseVersionLimits.js"
import { PluginConnection } from "../plugins/PluginConnection.js"
import { PluginConnectionMap } from "../plugins/PluginConnectionMap.js"
import {
  digestReleaseSourceRevisions,
  latestConfluencePublicationReference,
  releasePublicationReceiptCandidatesFromRecords,
  releasePublicationTargetEntityId,
  selectReleasePublicationConnection
} from "./releasePublicationMetadata.js"
import { hydrateReleaseRunbookContent } from "./releaseRunbookHydration.js"

export class ReleasePublicationSubmissionError extends Schema.TaggedError<ReleasePublicationSubmissionError>()(
  "ReleasePublicationSubmissionError",
  { reason: Schema.Literals(["unauthorized", "conflict", "forbidden", "invalid-request", "unavailable"]) }
) {}

export interface ConfluenceReleasePublicationHistory {
  readonly hasBlockingPublication: boolean
  readonly latestReference: ReturnType<typeof latestConfluencePublicationReference>
}

export interface ConfluenceEntityPublicationTarget {
  readonly pageId: string
  readonly pageVersion: number
  readonly pluginConnectionId: PluginConnectionId
}

interface ConfluenceTemplatePublicationSource {
  readonly pluginConnectionId: PluginConnectionId
}

/** Bind an explicitly selected related page, continuing its chain only when the latest receipt is for that page. */
export const confluenceEntityPublicationContext = (
  history: ConfluenceReleasePublicationHistory,
  target: ConfluenceEntityPublicationTarget
) => {
  const predecessor = history.latestReference?.pageId === target.pageId
    ? history.latestReference.publicationActionId
    : null
  return {
    historyMatches: true,
    predecessorPublicationActionId: predecessor,
    publication: target
  }
}

/** Require creates to have no history and updates to match the exact latest durable receipt. */
export const confluencePublicationRequestMatchesHistory = (
  request: Pick<SubmitReleasePublicationRequest, "publicationActionId">,
  history: ConfluenceReleasePublicationHistory
): boolean => {
  return request.publicationActionId === undefined
    ? !history.hasBlockingPublication
    : history.latestReference?.publicationActionId === request.publicationActionId
}

/** Preserve the exact referenced page for idempotency while separately checking whether it is still latest. */
export const confluencePublicationRequestContext = (
  request: Pick<SubmitReleasePublicationRequest, "publicationActionId">,
  history: ConfluenceReleasePublicationHistory,
  requestedReference: ConfluenceReleasePublicationHistory["latestReference"]
) => ({
  historyMatches: confluencePublicationRequestMatchesHistory(request, history),
  publication: request.publicationActionId === undefined ? null : requestedReference
})

/** Load enough indexed history to distinguish never-published from malformed successful receipts. */
export const loadConfluenceReleasePublicationHistory = Effect.fn(
  "ReleasePublicationSubmissions.loadConfluenceReleasePublicationHistory"
)(function*(
  history: Pick<
    PersistenceService["governedActions"],
    "readLatestTerminalReleasePublications"
  >,
  workspaceId: WorkspaceId,
  releaseId: ReleaseId
) {
  const records = yield* history.readLatestTerminalReleasePublications({
    workspaceId,
    providerId: "confluence",
    releaseIds: [releaseId]
  })
  return {
    hasBlockingPublication: records.length > 0,
    latestReference: latestConfluencePublicationReference(
      releasePublicationReceiptCandidatesFromRecords(records),
      releaseId
    )
  }
})

/** Resolve one release update target through the bounded indexed publication projection. */
export const loadLatestConfluenceReleasePublication = Effect.fn(
  "ReleasePublicationSubmissions.loadLatestConfluenceReleasePublication"
)(function*(
  history: Pick<
    PersistenceService["governedActions"],
    "readLatestTerminalReleasePublications"
  >,
  workspaceId: WorkspaceId,
  releaseId: ReleaseId
) {
  return (yield* loadConfluenceReleasePublicationHistory(history, workspaceId, releaseId)).latestReference
})

/** Resolve the exact opaque publication action supplied by the client without exposing its provider locator. */
const loadConfluenceReleasePublicationByActionId = Effect.fn(
  "ReleasePublicationSubmissions.loadConfluenceReleasePublicationByActionId"
)(function*(
  history: Pick<PersistenceService["governedActions"], "read">,
  workspaceId: WorkspaceId,
  releaseId: ReleaseId,
  actionId: GovernedActionId
) {
  const record = yield* history.read({ workspaceId, actionId }).pipe(
    Effect.map(Option.some),
    Effect.catchTag("RecordNotFoundError", () => Effect.succeed(Option.none()))
  )
  if (Option.isNone(record)) return null
  const reference = latestConfluencePublicationReference(
    releasePublicationReceiptCandidatesFromRecords([record.value]),
    releaseId
  )
  return reference?.publicationActionId === actionId ? reference : null
})

interface SubmitInput {
  readonly expectedReleaseUpdatedAt?: UtcTimestamp
  readonly releaseId: ReleaseId
  readonly request: SubmitReleasePublicationRequest
  readonly session: SessionSummary
  readonly useReleaseIdentity?: boolean
  readonly workspaceId: WorkspaceId
}

export class ReleasePublicationSubmissions extends Context.Service<
  ReleasePublicationSubmissions,
  {
    readonly submit: (
      input: SubmitInput
    ) => Effect.Effect<SubmitReleasePublicationResponse, ReleasePublicationSubmissionError>
  }
>()("@knpkv/control-center/server/application/ReleasePublicationSubmissions") {}

const failure = (reason: ReleasePublicationSubmissionError["reason"]) =>
  new ReleasePublicationSubmissionError({ reason })

const ConfluencePageVersionFromRevision = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 2_147_483_646 })
)

/** Require the provider revision reviewed by the owner to remain current at submission time. */
export const confluenceTargetRevisionMatches = (
  currentRevision: Revision,
  requestedRevision: Revision
): boolean => currentRevision === requestedRevision

/** Match Jira's release-version name and UTF-8 description limits before provider work. */
export const jiraPublicationPayloadWithinLimits = (title: string, markdown: string): boolean =>
  title.length <= JIRA_RELEASE_VERSION_NAME_MAX_CHARACTERS &&
  jiraReleaseVersionDescriptionWithinLimit(markdown)

const currentRelationship = (
  lifecycle: ReleaseDeliveryGraphInspection["relationships"][number]["lifecycle"]
): boolean => lifecycle._tag !== "missing" && lifecycle._tag !== "rejected" && lifecycle._tag !== "superseded"

/** Prove every task on a directly release-related Confluence page is complete. */
export const releaseConfluenceTaskReadiness = (inspection: ReleaseDeliveryGraphInspection) => {
  const nodeById = new Map(inspection.nodes.map((node) => [node.nodeId, node]))
  const projectionByEntityId = new Map(
    inspection.entityProjections.map(({ projection }) => [projection.entityId, projection])
  )
  const releasePageIds = new Set(
    inspection.relationships.flatMap((relationship): ReadonlyArray<EntityId> => {
      if (
        relationship.kind !== "documented-by" ||
        relationship.sourceNodeKind !== "release" ||
        relationship.targetNodeKind !== "page" ||
        !currentRelationship(relationship.lifecycle)
      ) return []
      const source = nodeById.get(relationship.sourceNodeId)
      const target = nodeById.get(relationship.targetNodeId)
      return source?.resolution._tag === "resolved" &&
          source.resolution.target._tag === "release" &&
          source.resolution.target.releaseId === inspection.releaseId &&
          target?.resolution._tag === "resolved" &&
          target.resolution.target._tag === "entity"
        ? [target.resolution.target.entityId]
        : []
    })
  )
  let completed = 0
  let outstanding = 0
  let unverifiablePages = 0
  for (const entityId of releasePageIds) {
    const projection = projectionByEntityId.get(entityId)
    if (
      projection?.entityState !== "present" ||
      projection.entityType !== "page" ||
      projection.details._tag !== "page"
    ) {
      unverifiablePages += 1
      continue
    }
    if (projection.details.contentState !== "loaded") {
      unverifiablePages += 1
      continue
    }
    const summary = confluenceTaskSummary(projection.details.content?.markdown ?? "")
    completed += summary.completed
    outstanding += summary.outstanding
  }
  return {
    completed,
    outstanding,
    ready: !inspection.truncated && unverifiablePages === 0 && outstanding === 0,
    total: completed + outstanding,
    unverifiablePages
  }
}

const mapFailure = Effect.catch((cause) =>
  Schema.is(ReleasePublicationSubmissionError)(cause)
    ? Effect.fail(cause)
    : Effect.logError("Release publication submission failed", cause).pipe(
      Effect.andThen(Effect.fail(failure("unavailable")))
    )
)

const makeService = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const connections = yield* PluginConnectionMap
  const persistence = yield* Persistence
  const proposalAuthority = yield* GovernedActionProposalAuthority
  const policies = yield* GovernedActionPolicyBindingSource
  const submission = yield* GovernedActionSubmission

  const loadConfluenceEntityPublicationTarget = Effect.fn(
    "ReleasePublicationSubmissions.loadConfluenceEntityPublicationTarget"
  )(function*(
    workspaceId: WorkspaceId,
    releaseId: ReleaseId,
    entityId: NonNullable<SubmitReleasePublicationRequest["targetEntityId"]>,
    targetRevision: NonNullable<SubmitReleasePublicationRequest["targetRevision"]>
  ) {
    const entity = yield* persistence.entities.get(workspaceId, entityId).pipe(mapFailure)
    const graph = yield* persistence.deliveryGraph.read(workspaceId, {
      _tag: "entitySlice",
      entityId,
      limit: 1
    }).pipe(mapFailure)
    if (
      graph._tag !== "entitySlice" ||
      !graph.value.entity.releaseIds.includes(releaseId) ||
      graph.value.entity.projection.entityType !== "page" ||
      graph.value.entity.projection.details._tag !== "page" ||
      entity.sourceRevision.providerId !== "confluence" ||
      !confluenceTargetRevisionMatches(entity.sourceRevision.revision, targetRevision)
    ) return yield* failure("conflict")
    const pageVersion = yield* Schema.decodeUnknownEffect(ConfluencePageVersionFromRevision)(
      entity.sourceRevision.revision
    ).pipe(Effect.mapError(() => failure("invalid-request")))
    return {
      pageId: entity.sourceRevision.vendorImmutableId,
      pageVersion,
      pluginConnectionId: entity.sourceRevision.pluginConnectionId
    } satisfies ConfluenceEntityPublicationTarget
  })

  const loadConfluenceTemplatePublicationSource = Effect.fn(
    "ReleasePublicationSubmissions.loadConfluenceTemplatePublicationSource"
  )(function*(
    workspaceId: WorkspaceId,
    entityId: NonNullable<SubmitReleasePublicationRequest["templateEntityId"]>
  ) {
    const entity = yield* persistence.entities.get(workspaceId, entityId).pipe(mapFailure)
    const graph = yield* persistence.deliveryGraph.read(workspaceId, {
      _tag: "entitySlice",
      entityId,
      limit: 1
    }).pipe(mapFailure)
    if (
      graph._tag !== "entitySlice" ||
      graph.value.entity.projection.entityType !== "page" ||
      graph.value.entity.projection.details._tag !== "page" ||
      entity.sourceRevision.providerId !== "confluence"
    ) return yield* failure("conflict")
    return {
      pluginConnectionId: entity.sourceRevision.pluginConnectionId
    } satisfies ConfluenceTemplatePublicationSource
  })

  const submit = Effect.fn("ReleasePublicationSubmissions.submit")(function*(input: SubmitInput) {
    const checkedAt = yield* DateTime.now
    if (
      input.session.actor._tag !== "human" ||
      input.session.workspaceId !== input.workspaceId ||
      input.session.revokedAt !== null ||
      DateTime.Order(checkedAt, input.session.idleExpiresAt) >= 0 ||
      DateTime.Order(checkedAt, input.session.absoluteExpiresAt) >= 0
    ) return yield* failure("unauthorized")
    if (input.session.permission !== "workspace-owner") return yield* failure("forbidden")
    if (
      input.request.provider !== "confluence" &&
      (
        input.request.publicationActionId !== undefined ||
        input.request.targetEntityId !== undefined ||
        input.request.targetRevision !== undefined ||
        input.request.templateEntityId !== undefined
      )
    ) return yield* failure("conflict")
    const confluenceTargetCount = [
      input.request.publicationActionId,
      input.request.targetEntityId,
      input.request.templateEntityId
    ].filter((value) => value !== undefined).length
    if (confluenceTargetCount > 1) return yield* failure("conflict")
    if ((input.request.targetEntityId === undefined) !== (input.request.targetRevision === undefined)) {
      return yield* failure("invalid-request")
    }

    const release = yield* persistence.releases.get(input.workspaceId, input.releaseId).pipe(mapFailure)
    if (
      input.expectedReleaseUpdatedAt !== undefined &&
      release.release.updatedAt !== input.expectedReleaseUpdatedAt
    ) return yield* failure("conflict")
    const publicationTitle = input.useReleaseIdentity === true
      ? canonicalReleasePublicationTitle(release.release.version)
      : input.request.title
    const publicationMarkdown = input.useReleaseIdentity === true
      ? `Release ${release.release.version} for ${release.release.serviceName}. Published by Relay after human confirmation.`
      : input.request.markdown
    if (
      input.request.provider === "jira" &&
      !jiraPublicationPayloadWithinLimits(publicationTitle, publicationMarkdown)
    ) return yield* failure("invalid-request")
    if (input.request.provider === "jira") {
      const taskInspection = yield* persistence.deliveryGraph.read(input.workspaceId, {
        _tag: "releaseSlice",
        releaseId: input.releaseId,
        environmentId: null,
        limit: 500
      }).pipe(mapFailure)
      if (taskInspection._tag !== "releaseSlice") return yield* failure("conflict")
      const hydratedTaskInspection = yield* hydrateReleaseRunbookContent(
        persistence,
        input.workspaceId,
        taskInspection.value
      ).pipe(mapFailure)
      if (
        !releaseConfluenceTaskReadiness(hydratedTaskInspection).ready ||
        !releasePipelineApprovalReadiness(hydratedTaskInspection).ready
      ) return yield* failure("conflict")
    }
    const sources = release.release.sourceRevisions.filter(({ providerId }) => providerId === input.request.provider)
    if (sources.length > 1) return yield* failure("conflict")
    const releaseSource = sources[0]
    let publicationReceiptConnectionId: PluginConnectionId | undefined
    let confluencePublication: ConfluenceEntityPublicationTarget | null = null
    let confluenceHistoryMatches = true
    let predecessorPublicationActionId = input.request.publicationActionId ?? null
    if (input.request.provider === "confluence") {
      const publicationHistory = yield* loadConfluenceReleasePublicationHistory(
        persistence.governedActions,
        input.workspaceId,
        input.releaseId
      ).pipe(mapFailure)
      if (input.request.templateEntityId !== undefined) {
        const template = yield* loadConfluenceTemplatePublicationSource(
          input.workspaceId,
          input.request.templateEntityId
        )
        confluenceHistoryMatches = true
        predecessorPublicationActionId = null
        publicationReceiptConnectionId = template.pluginConnectionId
      } else if (input.request.targetEntityId !== undefined) {
        if (input.request.targetRevision === undefined) return yield* failure("invalid-request")
        const target = yield* loadConfluenceEntityPublicationTarget(
          input.workspaceId,
          input.releaseId,
          input.request.targetEntityId,
          input.request.targetRevision
        )
        const publicationContext = confluenceEntityPublicationContext(publicationHistory, target)
        confluenceHistoryMatches = publicationContext.historyMatches
        confluencePublication = publicationContext.publication
        predecessorPublicationActionId = publicationContext.predecessorPublicationActionId
      } else {
        const requestedReference = input.request.publicationActionId === undefined
          ? null
          : yield* loadConfluenceReleasePublicationByActionId(
            persistence.governedActions,
            input.workspaceId,
            input.releaseId,
            input.request.publicationActionId
          ).pipe(mapFailure)
        const publicationContext = confluencePublicationRequestContext(
          input.request,
          publicationHistory,
          requestedReference
        )
        confluenceHistoryMatches = publicationContext.historyMatches
        confluencePublication = publicationContext.publication
        if (input.request.publicationActionId !== undefined && confluencePublication === null) {
          return yield* failure("conflict")
        }
      }
      publicationReceiptConnectionId ??= confluencePublication?.pluginConnectionId
    }
    const workspaceConnections = releaseSource === undefined && publicationReceiptConnectionId === undefined
      ? yield* persistence.pluginConnections.list(input.workspaceId).pipe(mapFailure)
      : []
    const enabledFallbackConnections = workspaceConnections.filter(
      ({ isEnabled, providerId }) => providerId === input.request.provider && isEnabled
    )
    const connectionSelection = selectReleasePublicationConnection({
      enabledConnectionIds: enabledFallbackConnections.map(({ pluginConnectionId }) => pluginConnectionId),
      ...(publicationReceiptConnectionId === undefined
        ? {}
        : { publicationReceiptConnectionId }),
      ...(releaseSource === undefined
        ? {}
        : { releaseSourceConnectionId: releaseSource.pluginConnectionId })
    })
    if (connectionSelection._tag === "ambiguous") return yield* failure("conflict")
    if (connectionSelection._tag === "missing") return yield* failure("unavailable")
    const publicationConnectionId = connectionSelection.pluginConnectionId
    if (connections.proposalContextEffect === undefined) {
      return yield* failure("unavailable")
    }
    const lease = yield* connections.proposalContextEffect({
      workspaceId: input.workspaceId,
      pluginConnectionId: publicationConnectionId
    }).pipe(mapFailure)
    const connection = Context.get(lease.context, PluginConnection)
    const connectionRecord = yield* persistence.pluginConnections.get(
      input.workspaceId,
      publicationConnectionId
    ).pipe(mapFailure)
    if (!connectionRecord.isEnabled) return yield* failure("conflict")
    const publicationTargetEntityId = releasePublicationTargetEntityId(input.releaseId)
    const capability = connection.descriptor.capabilities.find(({ capabilityId }) => capabilityId === "action.execute")
    if (capability === undefined) return yield* failure("conflict")

    const configuration = yield* persistence.pluginConfigurations.get(
      input.workspaceId,
      publicationConnectionId
    ).pipe(mapFailure)
    if (Option.isNone(configuration)) return yield* failure("conflict")
    const destination = configuration.value.values.find(({ key }) =>
      input.request.provider === "jira" ? key === "projectId" : key === "spaceId"
    )
    if (destination === undefined || destination._tag === "secret-reference" || typeof destination.value !== "string") {
      return yield* failure("conflict")
    }
    const providerRequest = yield* Schema.decodeUnknownEffect(ProposePluginActionRequestV1)({
      actionKind: input.request.provider === "jira"
        ? "create-release-version"
        : confluencePublication !== null
        ? "update-page"
        : "create-page",
      target: {
        entityType: input.request.provider === "jira"
          ? "jira.project-version"
          : confluencePublication !== null
          ? "page"
          : "release-page",
        vendorImmutableId: input.request.provider === "jira" || confluencePublication === null
          ? destination.value
          : confluencePublication.pageId
      },
      expectedRevision: input.request.provider === "confluence" && confluencePublication !== null
        ? Revision.make(String(confluencePublication.pageVersion))
        // Creation actions have no provider revision; "0" is a sentinel, not a real revision.
        : Revision.make("0"),
      payload: input.request.provider === "jira"
        ? {
          _tag: "create-release-version",
          projectId: destination.value,
          name: publicationTitle,
          description: publicationMarkdown
        }
        : confluencePublication !== null
        ? {
          _tag: "update-page",
          pageId: confluencePublication.pageId,
          spaceId: destination.value,
          title: publicationTitle,
          markdown: publicationMarkdown,
          expectedVersion: confluencePublication.pageVersion,
          versionMessage: "Updated by Relay after an explicit owner confirmation."
        }
        : {
          _tag: "create-page",
          spaceId: destination.value,
          title: publicationTitle,
          markdown: publicationMarkdown,
          parentId: input.request.parentId
        },
      evidenceIds: []
    }).pipe(
      Effect.catch((cause) =>
        Effect.logError("Release publication provider request decoding failed", cause).pipe(
          Effect.andThen(Effect.fail(failure("unavailable")))
        )
      )
    )
    const sourceRevisionDigest = yield* digestReleaseSourceRevisions(release.release.sourceRevisions).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService)
    )
    const digest = yield* digestCanonicalGovernedActionJson({
      schemaVersion: 1,
      workspaceId: input.workspaceId,
      releaseId: input.releaseId,
      provider: input.request.provider,
      actionKind: providerRequest.actionKind,
      title: publicationTitle,
      markdown: publicationMarkdown,
      parentId: input.request.parentId,
      publicationActionId: predecessorPublicationActionId,
      sourceEntityId: input.request.targetEntityId ?? input.request.templateEntityId ?? null,
      pageId: confluencePublication?.pageId ?? null,
      expectedVersion: confluencePublication?.pageVersion ?? null,
      sourceRevisionDigest,
      destination: destination.value,
      targetEntityId: publicationTargetEntityId
    }).pipe(Effect.provideService(Crypto.Crypto, cryptoService))
    const idempotencyKey = GovernedActionIdempotencyKey.make("release-publication:v1:" + digest)
    const existing = yield* persistence.governedActions.readByIdempotencyKey({
      workspaceId: input.workspaceId,
      pluginConnectionId: publicationConnectionId,
      idempotencyKey
    }).pipe(
      Effect.map(Option.some),
      Effect.catchTag("RecordNotFoundError", () => Effect.succeed(Option.none())),
      mapFailure
    )
    if (Option.isSome(existing)) {
      if (
        !Equal.equals(existing.value.envelope.proposal.request, providerRequest)
      ) {
        return yield* failure("conflict")
      }
      if (existing.value.head.state === "proposed") return yield* failure("conflict")
      yield* submission.advance({
        workspaceId: input.workspaceId,
        actionId: existing.value.envelope.actionId
      }).pipe(
        Effect.catchTag("GovernedActionSubmissionUnavailable", () => failure("unavailable")),
        mapFailure
      )
      const record = yield* persistence.governedActions.read({
        workspaceId: input.workspaceId,
        actionId: existing.value.envelope.actionId
      }).pipe(mapFailure)
      return { actionId: record.envelope.actionId, state: record.head.state }
    }
    if (!confluenceHistoryMatches) return yield* failure("conflict")

    const providerProposal = yield* connection.proposeAction(providerRequest).pipe(mapFailure)

    const actor = input.session.actor
    if (actor._tag !== "human") return yield* failure("conflict")
    const actionId = GovernedActionId.make(yield* cryptoService.randomUUIDv7)
    const evidence: GovernedActionEvidenceSet = []
    const evidenceSetDigest = yield* digestGovernedActionEvidenceSet(evidence).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService)
    )
    const policy = yield* policies.forPermission("workspace-owner").pipe(mapFailure)
    const material = GovernedActionEnvelopeMaterialV1.make({
      schemaVersion: 1,
      actionId,
      idempotencyKey,
      workspaceId: input.workspaceId,
      pluginConnectionId: publicationConnectionId,
      pluginConnectionRevision: GovernedActionPluginConnectionRevision.make(connectionRecord.revision),
      pluginConnectionAuthorityDigest: GovernedActionPluginConnectionAuthorityDigest.make(
        lease.runtimeAuthorityToken
      ),
      pluginId: connection.descriptor.descriptor.pluginId,
      pluginContractVersion: connection.descriptor.descriptor.contractVersion,
      pluginAdapterVersion: connection.descriptor.descriptor.adapterVersion,
      providerId: input.request.provider,
      capability: { capabilityId: "action.execute", version: capability.version },
      targetEntityId: publicationTargetEntityId,
      proposal: providerProposal,
      evidence,
      evidenceSetDigest,
      policy,
      origin: { _tag: "human", actor, sessionId: input.session.sessionId },
      proposalExpiresAt: DateTime.addDuration(checkedAt, Duration.minutes(10)),
      causationId: null,
      correlationId: null,
      releasePublication: {
        releaseId: input.releaseId,
        predecessorPublicationActionId,
        ...(input.request.templateEntityId === undefined
          ? {}
          : { templateSourceEntityId: input.request.templateEntityId }),
        sourceRevisionDigest,
        sourceRevisionCount: release.release.sourceRevisions.length
      }
    })
    const envelope = (yield* makeGovernedActionEnvelope(material).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService)
    )).envelope
    const cause: GovernedActionTransitionCause = {
      _tag: "human",
      actor,
      sessionId: input.session.sessionId
    }
    const proposal = GovernedActionCommitInput.make({
      envelope,
      expectedHeadTransitionId: null,
      transitionId: GovernedActionTransitionId.make(yield* cryptoService.randomUUIDv7),
      commandId: GovernedActionCommandId.make("release-publication:" + actionId + ":propose"),
      command: { _tag: "propose" },
      cause,
      occurredAt: providerProposal.proposedAt,
      causationId: null,
      correlationId: null,
      companion: { _tag: "none" },
      auditEventId: DomainEventId.make(yield* cryptoService.randomUUIDv7)
    })
    const authorizedAt = yield* DateTime.now
    const expiresAt = DateTime.min(
      DateTime.addDuration(authorizedAt, Duration.minutes(5)),
      DateTime.min(
        envelope.proposalExpiresAt,
        DateTime.min(input.session.idleExpiresAt, input.session.absoluteExpiresAt)
      )
    )
    if (DateTime.Order(authorizedAt, expiresAt) >= 0) return yield* failure("conflict")
    const authorizationId = GovernedActionAuthorizationId.make(yield* cryptoService.randomUUIDv7)
    const authorization = GovernedActionAuthorizationV1.make({
      schemaVersion: 1,
      authorizationId,
      actionId,
      workspaceId: input.workspaceId,
      pluginConnectionId: publicationConnectionId,
      pluginConnectionRevision: envelope.pluginConnectionRevision,
      pluginConnectionAuthorityDigest: envelope.pluginConnectionAuthorityDigest,
      actionEnvelopeDigest: envelope.envelopeDigest,
      idempotencyKey,
      payloadDigest: envelope.proposal.payloadDigest,
      evidenceSetDigest: envelope.evidenceSetDigest,
      policyDigest: envelope.policy.policyDigest,
      expectedRevision: envelope.proposal.request.expectedRevision,
      capabilityVersion: envelope.capability.version,
      actor,
      sessionId: input.session.sessionId,
      sessionPermission: input.session.permission,
      sessionExpiresAt: DateTime.min(input.session.idleExpiresAt, input.session.absoluteExpiresAt),
      requiredPermission: envelope.policy.requiredPermission,
      authorizedAt,
      expiresAt
    })
    const authorizationCommit = GovernedActionCommitInput.make({
      envelope,
      expectedHeadTransitionId: proposal.transitionId,
      transitionId: GovernedActionTransitionId.make(yield* cryptoService.randomUUIDv7),
      commandId: GovernedActionCommandId.make("release-publication:" + actionId + ":authorize"),
      command: { _tag: "authorize", authorizationId },
      cause,
      occurredAt: authorizedAt,
      causationId: null,
      correlationId: null,
      companion: { _tag: "authorization", authorization },
      auditEventId: DomainEventId.make(yield* cryptoService.randomUUIDv7)
    })
    yield* proposalAuthority.transactCurrent(
      {
        workspaceId: input.workspaceId,
        pluginConnectionId: publicationConnectionId,
        runtimeAuthorityToken: lease.runtimeAuthorityToken
      },
      () =>
        Effect.gen(function*() {
          yield* persistence.governedActions.commit(proposal)
          yield* persistence.governedActions.commit(authorizationCommit)
        })
    ).pipe(
      Effect.catchTag("GovernedActionSubmissionUnavailable", () => failure("unavailable")),
      mapFailure
    )
    yield* submission.advance({ workspaceId: input.workspaceId, actionId }).pipe(
      Effect.catchTag("GovernedActionSubmissionUnavailable", () => failure("unavailable")),
      mapFailure
    )
    const record = yield* persistence.governedActions.read({
      workspaceId: input.workspaceId,
      actionId
    }).pipe(mapFailure)
    return { actionId, state: record.head.state }
  })

  return ReleasePublicationSubmissions.of({
    submit: (input) => Effect.scoped(submit(input)).pipe(mapFailure)
  })
})

export const releasePublicationSubmissionsLayer = Layer.effect(ReleasePublicationSubmissions, makeService)
export const releasePublicationSubmissionsUnavailableLayer = Layer.succeed(
  ReleasePublicationSubmissions,
  ReleasePublicationSubmissions.of({ submit: () => Effect.fail(failure("unavailable")) })
)
