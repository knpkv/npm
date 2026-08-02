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
  GovernedActionAuthorizationId,
  GovernedActionId,
  GovernedActionTransitionId,
  type ReleaseId,
  type WorkspaceId
} from "../../domain/identifiers.js"
import { ProposePluginActionRequestV1 } from "../../domain/plugins/index.js"
import { Revision } from "../../domain/sourceRevision.js"
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
import { Persistence } from "../persistence/Persistence.js"
import { GovernedActionCommitInput } from "../persistence/repositories/governedActionRepository.js"
import { PluginConnection } from "../plugins/PluginConnection.js"
import { PluginConnectionMap } from "../plugins/PluginConnectionMap.js"

export class ReleasePublicationSubmissionError extends Schema.TaggedErrorClass<ReleasePublicationSubmissionError>()(
  "ReleasePublicationSubmissionError",
  { reason: Schema.Literals(["unauthorized", "conflict", "forbidden", "invalid-request", "unavailable"]) }
) {}

interface SubmitInput {
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

    const release = yield* persistence.releases.get(input.workspaceId, input.releaseId).pipe(mapFailure)
    const publicationTitle = input.useReleaseIdentity === true
      ? input.request.provider === "jira" ? release.release.version : `${release.release.version} release`
      : input.request.title
    const publicationMarkdown = input.useReleaseIdentity === true
      ? `Release ${release.release.version} for ${release.release.serviceName}. Published by Relay after human confirmation.`
      : input.request.markdown
    const sources = release.release.sourceRevisions.filter(({ providerId }) => providerId === input.request.provider)
    if (sources.length > 1) return yield* failure("conflict")
    const releaseSource = sources[0]
    const workspaceConnections = releaseSource === undefined
      ? yield* persistence.pluginConnections.list(input.workspaceId).pipe(mapFailure)
      : []
    const fallbackConnection = releaseSource === undefined
      ? workspaceConnections.find(({ isEnabled, providerId }) => providerId === input.request.provider && isEnabled)
      : undefined
    const workspaceEntities = releaseSource === undefined && fallbackConnection !== undefined
      ? yield* persistence.entities.list(input.workspaceId).pipe(mapFailure)
      : []
    const fallbackEntity = fallbackConnection === undefined
      ? undefined
      : workspaceEntities.find(
        ({ sourceRevision }) =>
          sourceRevision.providerId === input.request.provider &&
          sourceRevision.pluginConnectionId === fallbackConnection.pluginConnectionId
      )
    const source = releaseSource ?? fallbackEntity?.sourceRevision
    if (source === undefined || connections.proposalContextEffect === undefined) {
      return yield* failure("unavailable")
    }
    const lease = yield* connections.proposalContextEffect({
      workspaceId: input.workspaceId,
      pluginConnectionId: source.pluginConnectionId
    }).pipe(mapFailure)
    const connection = Context.get(lease.context, PluginConnection)
    const connectionRecord = yield* persistence.pluginConnections.get(
      input.workspaceId,
      source.pluginConnectionId
    ).pipe(mapFailure)
    if (!connectionRecord.isEnabled) return yield* failure("conflict")
    // Governed actions are intentionally scoped to a current normalized
    // provider entity. A release projection is not itself an entity, so bind
    // the action to an existing current entity from the same provider scope;
    // the immutable provider request below still carries the exact release
    // destination (project version or Confluence space).
    const publicationAnchor = (yield* persistence.entities.list(input.workspaceId).pipe(mapFailure)).find(
      (entity) =>
        entity.sourceRevision.pluginConnectionId === source.pluginConnectionId &&
        entity.sourceRevision.providerId === source.providerId
    )
    if (publicationAnchor === undefined) return yield* failure("conflict")
    const capability = connection.descriptor.capabilities.find(({ capabilityId }) => capabilityId === "action.execute")
    if (capability === undefined) return yield* failure("conflict")

    const configuration = yield* persistence.pluginConfigurations.get(
      input.workspaceId,
      source.pluginConnectionId
    ).pipe(mapFailure)
    if (Option.isNone(configuration)) return yield* failure("conflict")
    const destination = configuration.value.values.find(({ key }) =>
      input.request.provider === "jira" ? key === "projectId" : key === "spaceId"
    )
    if (destination === undefined || destination._tag === "secret-reference" || typeof destination.value !== "string") {
      return yield* failure("conflict")
    }
    const providerRequest = yield* Schema.decodeUnknownEffect(ProposePluginActionRequestV1)({
      actionKind: input.request.provider === "jira" ? "create-release-version" : "create-page",
      target: {
        entityType: input.request.provider === "jira" ? "jira.project-version" : "release-page",
        vendorImmutableId: destination.value
      },
      expectedRevision: Revision.make("0"),
      payload: input.request.provider === "jira"
        ? {
          _tag: "create-release-version",
          projectId: destination.value,
          name: publicationTitle,
          description: publicationMarkdown
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
    const providerProposal = yield* connection.proposeAction(providerRequest).pipe(mapFailure)
    const digest = yield* digestCanonicalGovernedActionJson({
      schemaVersion: 1,
      workspaceId: input.workspaceId,
      releaseId: input.releaseId,
      provider: input.request.provider,
      title: publicationTitle,
      markdown: publicationMarkdown,
      parentId: input.request.parentId,
      targetEntityId: publicationAnchor.entityId
    }).pipe(Effect.provideService(Crypto.Crypto, cryptoService))
    const idempotencyKey = GovernedActionIdempotencyKey.make("release-publication:v1:" + digest)
    const existing = yield* persistence.governedActions.readByIdempotencyKey({
      workspaceId: input.workspaceId,
      pluginConnectionId: source.pluginConnectionId,
      idempotencyKey
    }).pipe(
      Effect.map(Option.some),
      Effect.catchTag("RecordNotFoundError", () => Effect.succeed(Option.none())),
      mapFailure
    )
    if (Option.isSome(existing)) {
      if (
        existing.value.envelope.proposal.payloadDigest !== providerProposal.payloadDigest ||
        !Equal.equals(existing.value.envelope.proposal.request, providerProposal.request)
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
      pluginConnectionId: source.pluginConnectionId,
      pluginConnectionRevision: GovernedActionPluginConnectionRevision.make(connectionRecord.revision),
      pluginConnectionAuthorityDigest: GovernedActionPluginConnectionAuthorityDigest.make(
        lease.runtimeAuthorityToken
      ),
      pluginId: connection.descriptor.descriptor.pluginId,
      pluginContractVersion: connection.descriptor.descriptor.contractVersion,
      pluginAdapterVersion: connection.descriptor.descriptor.adapterVersion,
      providerId: input.request.provider,
      capability: { capabilityId: "action.execute", version: capability.version },
      targetEntityId: publicationAnchor.entityId,
      proposal: providerProposal,
      evidence,
      evidenceSetDigest,
      policy,
      origin: { _tag: "human", actor, sessionId: input.session.sessionId },
      proposalExpiresAt: DateTime.addDuration(checkedAt, Duration.minutes(10)),
      causationId: null,
      correlationId: null
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
      pluginConnectionId: source.pluginConnectionId,
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
        pluginConnectionId: source.pluginConnectionId,
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
