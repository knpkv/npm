/** Governed-action adapter for human-confirmed CodeCommit review comments. @module */
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import {
  GovernedActionAuthorizationV1,
  GovernedActionCommandId,
  GovernedActionEnvelopeMaterialV1,
  type GovernedActionEnvelopeV1,
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
  GovernedActionTransitionId
} from "../../domain/identifiers.js"
import { ProposePluginActionRequestV1 } from "../../domain/plugins/actions.js"
import { Revision } from "../../domain/sourceRevision.js"
import { digestGovernedActionEvidenceSet, makeGovernedActionEnvelope } from "../governance/governedActionDigests.js"
import { GovernedActionPolicyBindingSource, GovernedActionSubmission } from "../governance/GovernedActionSubmission.js"
import { Persistence } from "../persistence/Persistence.js"
import {
  GovernedActionCommitInput,
  type GovernedActionRecord
} from "../persistence/repositories/governedActionRepository.js"
import { PluginConnection } from "../plugins/PluginConnection.js"
import { PluginConnectionMap } from "../plugins/PluginConnectionMap.js"
import {
  ReviewSuggestionPublicationGateway,
  ReviewSuggestionPublicationGatewayError,
  type ReviewSuggestionPublicationTarget
} from "./ReviewSuggestionPublicationGateway.js"

const unavailable = () => new ReviewSuggestionPublicationGatewayError({ reason: "publication-unavailable" })

const conflict = () => new ReviewSuggestionPublicationGatewayError({ reason: "publication-conflict" })

const isGatewayFailure = Schema.is(ReviewSuggestionPublicationGatewayError)
const mapFailure = Effect.catch((failure) =>
  isGatewayFailure(failure) ? Effect.fail(failure) : Effect.fail(unavailable())
)

const makeGateway = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const connections = yield* PluginConnectionMap
  const persistence = yield* Persistence
  const policies = yield* GovernedActionPolicyBindingSource
  const submission = yield* GovernedActionSubmission

  const withProposalLease = <Value, Failure>(
    target: ReviewSuggestionPublicationTarget,
    use: (
      connection: PluginConnection["Service"],
      runtimeAuthorityToken: string
    ) => Effect.Effect<Value, Failure>
  ) =>
    Effect.scoped(Effect.gen(function*() {
      if (connections.proposalContextEffect === undefined) return yield* unavailable()
      const lease = yield* connections.proposalContextEffect(target).pipe(mapFailure)
      return yield* use(
        Context.get(lease.context, PluginConnection),
        lease.runtimeAuthorityToken
      )
    }))

  const identity = Effect.fn("ReviewSuggestionPublicationGateway.identity")(function*(target) {
    return yield* withProposalLease(target, (connection) =>
      connection.actionActorIdentity === undefined
        ? Effect.fail(
          new ReviewSuggestionPublicationGatewayError({ reason: "identity-unavailable" })
        )
        : connection.actionActorIdentity.pipe(
          Effect.map((actor) => ({
            accountId: actor.providerAccountId,
            arn: actor.principal
          })),
          mapFailure
        ))
  })

  const publish = Effect.fn("ReviewSuggestionPublicationGateway.publish")(function*(command) {
    if (
      command.session.actor._tag !== "human" ||
      command.session.workspaceId !== command.target.workspaceId ||
      command.session.revokedAt !== null
    ) return yield* conflict()

    const prepared = yield* withProposalLease(
      command.target,
      (connection, runtimeAuthorityToken) =>
        Effect.gen(function*() {
          const connectionRecord = yield* persistence.pluginConnections.get(
            command.target.workspaceId,
            command.target.pluginConnectionId
          ).pipe(mapFailure)
          if (!connectionRecord.isEnabled || connectionRecord.providerId !== "codecommit") {
            return yield* conflict()
          }
          const capability = connection.descriptor.capabilities.find(
            ({ capabilityId }) => capabilityId === "action.execute"
          )
          if (capability === undefined) return yield* conflict()
          const proposalRequest = yield* Schema.decodeUnknownEffect(ProposePluginActionRequestV1)({
            actionKind: "comment",
            target: {
              entityType: "pull-request",
              vendorImmutableId: command.target.subject.pullRequestId
            },
            expectedRevision: Revision.make(command.target.sourceRevision),
            payload: {
              content: command.finalContent,
              location: {
                filePath: command.suggestion.evidence.path,
                filePosition: command.suggestion.evidence.startLine,
                relativeFileVersion: "AFTER"
              }
            },
            evidenceIds: [
              `pr-review:${command.jobId}:${command.suggestion.suggestionId}`
            ]
          }).pipe(mapFailure)
          const proposal = yield* connection.proposeAction(proposalRequest).pipe(mapFailure)
          return {
            capability,
            connectionRecord,
            descriptor: connection.descriptor.descriptor,
            proposal,
            runtimeAuthorityToken
          }
        })
    )

    const cause = {
      _tag: "human",
      actor: command.session.actor,
      sessionId: command.session.sessionId
    } satisfies GovernedActionTransitionCause
    const publishedResult = (record: GovernedActionRecord) =>
      record.head.state === "succeeded" &&
        record.head.lineage._tag === "terminal" &&
        record.head.lineage.receipt.status === "succeeded"
        ? Effect.succeed({
          publicationId: record.envelope.actionId,
          receipt: record.head.lineage.receipt,
          publishedAt: record.head.lineage.receipt.observedAt
        })
        : Effect.fail(unavailable())
    const authorize = Effect.fn(
      "ReviewSuggestionPublicationGateway.authorize"
    )(function*(
      envelope: GovernedActionEnvelopeV1,
      expectedHeadTransitionId: GovernedActionTransitionId
    ) {
      const authorizedAt = yield* DateTime.now
      const authorizationId = GovernedActionAuthorizationId.make(
        yield* cryptoService.randomUUIDv7
      )
      const authorizationTransitionId = GovernedActionTransitionId.make(
        yield* cryptoService.randomUUIDv7
      )
      const authorizationAuditId = DomainEventId.make(yield* cryptoService.randomUUIDv7)
      const sessionExpiresAt = DateTime.min(
        command.session.idleExpiresAt,
        command.session.absoluteExpiresAt
      )
      const expiresAt = DateTime.min(
        DateTime.addDuration(authorizedAt, Duration.minutes(5)),
        DateTime.min(envelope.proposalExpiresAt, sessionExpiresAt)
      )
      if (DateTime.Order(authorizedAt, expiresAt) >= 0) return yield* conflict()
      const authorization = GovernedActionAuthorizationV1.make({
        schemaVersion: 1,
        authorizationId,
        actionId: envelope.actionId,
        workspaceId: command.target.workspaceId,
        pluginConnectionId: command.target.pluginConnectionId,
        pluginConnectionRevision: envelope.pluginConnectionRevision,
        pluginConnectionAuthorityDigest: envelope.pluginConnectionAuthorityDigest,
        actionEnvelopeDigest: envelope.envelopeDigest,
        idempotencyKey: envelope.idempotencyKey,
        payloadDigest: envelope.proposal.payloadDigest,
        evidenceSetDigest: envelope.evidenceSetDigest,
        policyDigest: envelope.policy.policyDigest,
        expectedRevision: envelope.proposal.request.expectedRevision,
        capabilityVersion: envelope.capability.version,
        actor: command.session.actor,
        sessionId: command.session.sessionId,
        sessionPermission: command.session.permission,
        sessionExpiresAt,
        requiredPermission: envelope.policy.requiredPermission,
        authorizedAt,
        expiresAt
      })
      yield* persistence.governedActions.commit(GovernedActionCommitInput.make({
        envelope,
        expectedHeadTransitionId,
        transitionId: authorizationTransitionId,
        commandId: GovernedActionCommandId.make(
          `review-comment:${envelope.actionId}:authorize`
        ),
        command: { _tag: "authorize", authorizationId },
        cause,
        occurredAt: authorizedAt,
        causationId: null,
        correlationId: null,
        companion: { _tag: "authorization", authorization },
        auditEventId: authorizationAuditId
      })).pipe(mapFailure)
    })
    const advanceAndRead = Effect.fn(
      "ReviewSuggestionPublicationGateway.advanceAndRead"
    )(function*(actionId: GovernedActionId) {
      yield* submission.advance({
        workspaceId: command.target.workspaceId,
        actionId
      }).pipe(mapFailure)
      const record = yield* persistence.governedActions.read({
        workspaceId: command.target.workspaceId,
        actionId
      }).pipe(mapFailure)
      return yield* publishedResult(record)
    })

    const idempotencyKey = GovernedActionIdempotencyKey.make(
      prepared.proposal.proposalKey
    )
    const existing = yield* persistence.governedActions.readByIdempotencyKey({
      workspaceId: command.target.workspaceId,
      pluginConnectionId: command.target.pluginConnectionId,
      idempotencyKey
    }).pipe(
      Effect.map(Option.some),
      Effect.catchTag("RecordNotFoundError", () => Effect.succeed(Option.none())),
      mapFailure
    )
    if (Option.isSome(existing)) {
      const record = existing.value
      const envelope = record.envelope
      if (
        envelope.targetEntityId !== command.target.entityId ||
        envelope.proposal.payloadDigest !== prepared.proposal.payloadDigest ||
        envelope.proposal.request.expectedRevision !== prepared.proposal.request.expectedRevision ||
        Number(envelope.pluginConnectionRevision) !== Number(prepared.connectionRecord.revision) ||
        envelope.pluginConnectionAuthorityDigest !== prepared.runtimeAuthorityToken ||
        envelope.origin._tag !== "human" ||
        envelope.origin.actor.personId !== command.session.actor.personId
      ) return yield* conflict()
      if (record.head.state === "succeeded") return yield* publishedResult(record)
      if (record.head.state === "proposed") {
        yield* authorize(envelope, record.headTransition.transitionId)
      } else if (record.head.state !== "authorized") {
        return yield* unavailable()
      }
      return yield* advanceAndRead(envelope.actionId)
    }

    const actionId = GovernedActionId.make(yield* cryptoService.randomUUIDv7)
    const proposalTransitionId = GovernedActionTransitionId.make(
      yield* cryptoService.randomUUIDv7
    )
    const proposalAuditId = DomainEventId.make(yield* cryptoService.randomUUIDv7)
    const evidence: GovernedActionEvidenceSet = []
    const evidenceSetDigest = yield* digestGovernedActionEvidenceSet(evidence).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService)
    )
    const policy = yield* policies.current.pipe(mapFailure)
    const proposalExpiresAt = DateTime.addDuration(
      prepared.proposal.proposedAt,
      Duration.minutes(10)
    )
    const material = GovernedActionEnvelopeMaterialV1.make({
      schemaVersion: 1,
      actionId,
      idempotencyKey,
      workspaceId: command.target.workspaceId,
      pluginConnectionId: command.target.pluginConnectionId,
      pluginConnectionRevision: GovernedActionPluginConnectionRevision.make(
        prepared.connectionRecord.revision
      ),
      pluginConnectionAuthorityDigest: GovernedActionPluginConnectionAuthorityDigest.make(
        prepared.runtimeAuthorityToken
      ),
      pluginId: prepared.descriptor.pluginId,
      pluginContractVersion: prepared.descriptor.contractVersion,
      pluginAdapterVersion: prepared.descriptor.adapterVersion,
      providerId: "codecommit",
      capability: {
        capabilityId: "action.execute",
        version: prepared.capability.version
      },
      targetEntityId: command.target.entityId,
      proposal: prepared.proposal,
      evidence,
      evidenceSetDigest,
      policy,
      origin: {
        _tag: "human",
        actor: command.session.actor,
        sessionId: command.session.sessionId
      },
      proposalExpiresAt,
      causationId: null,
      correlationId: null
    })
    const envelope = (yield* makeGovernedActionEnvelope(material).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService)
    )).envelope
    yield* persistence.governedActions.commit(GovernedActionCommitInput.make({
      envelope,
      expectedHeadTransitionId: null,
      transitionId: proposalTransitionId,
      commandId: GovernedActionCommandId.make(`review-comment:${actionId}:propose`),
      command: { _tag: "propose" },
      cause,
      occurredAt: prepared.proposal.proposedAt,
      causationId: null,
      correlationId: null,
      companion: { _tag: "none" },
      auditEventId: proposalAuditId
    })).pipe(mapFailure)
    yield* authorize(envelope, proposalTransitionId)
    return yield* advanceAndRead(actionId)
  })

  return ReviewSuggestionPublicationGateway.of({
    identity,
    publish: (command) => publish(command).pipe(mapFailure)
  })
})

/** Live human-confirmed publication layer backed by the durable governed-action engine. */
export const governedReviewSuggestionPublicationGatewayLayer = Layer.effect(
  ReviewSuggestionPublicationGateway,
  makeGateway
)
