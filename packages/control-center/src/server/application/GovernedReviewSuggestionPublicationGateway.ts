/** Governed-action adapter for human-confirmed CodeCommit review comments. @module */
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import { ReviewSuggestionPublicationAuthorityBinding } from "../../api/agent.js"
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
import type { SessionSummary } from "../auth/models.js"
import { digestGovernedActionEvidenceSet, makeGovernedActionEnvelope } from "../governance/governedActionDigests.js"
import {
  GovernedActionPolicyBindingSource,
  GovernedActionProposalAuthority,
  GovernedActionSubmission
} from "../governance/GovernedActionSubmission.js"
import { Persistence } from "../persistence/Persistence.js"
import {
  GovernedActionCommitInput,
  type GovernedActionRecord
} from "../persistence/repositories/governedActionRepository.js"
import { PluginConnection } from "../plugins/PluginConnection.js"
import { PluginConnectionMap } from "../plugins/PluginConnectionMap.js"
import {
  type PublishReviewSuggestionCommand,
  ReviewSuggestionPublicationGateway,
  ReviewSuggestionPublicationGatewayError,
  type ReviewSuggestionPublicationTarget
} from "./ReviewSuggestionPublicationGateway.js"

const unavailable = () => new ReviewSuggestionPublicationGatewayError({ reason: "publication-unavailable" })

const conflict = () => new ReviewSuggestionPublicationGatewayError({ reason: "publication-conflict" })

const rejected = () => new ReviewSuggestionPublicationGatewayError({ reason: "publication-rejected" })

const isGatewayFailure = Schema.is(ReviewSuggestionPublicationGatewayError)
const mapFailure = Effect.catch((failure) =>
  isGatewayFailure(failure) ? Effect.fail(failure) : Effect.fail(unavailable())
)

/** Pure fail-closed preflight used before acquiring any provider proposal capability. */
export const reviewPublicationSessionIsAuthorized = (
  session: SessionSummary,
  workspaceId: ReviewSuggestionPublicationTarget["workspaceId"],
  checkedAt: DateTime.Utc
): boolean =>
  session.actor._tag === "human" &&
  session.workspaceId === workspaceId &&
  session.permission === "workspace-owner" &&
  session.revokedAt === null &&
  DateTime.Order(checkedAt, session.idleExpiresAt) < 0 &&
  DateTime.Order(checkedAt, session.absoluteExpiresAt) < 0

/** Pure retry classifier; execution inspection decides whether recovery is currently eligible. */
export const reviewPublicationActionCanAdvance = (
  state: GovernedActionRecord["head"]["state"]
): boolean =>
  state === "authorized" ||
  state === "started" ||
  state === "unknown" ||
  state === "cancel-requested" ||
  state === "cancel-requested-unknown"

/** Terminal states proving that no review comment was published. */
export const reviewPublicationActionConfirmedNoWrite = (
  state: GovernedActionRecord["head"]["state"]
): boolean =>
  state === "denied" ||
  state === "expired" ||
  state === "cancelled" ||
  state === "failed"

/** Exact immutable proposal request required before an idempotent publication can be recovered. */
export const reviewPublicationProposalRequestMatches = (
  existing: typeof ProposePluginActionRequestV1.Type,
  prepared: typeof ProposePluginActionRequestV1.Type
): boolean => Equal.equals(existing, prepared)

/** Provider location derived from one host-resolved durable review anchor. */
export const reviewSuggestionPublicationLocation = (
  anchor: PublishReviewSuggestionCommand["suggestion"]["anchor"]
): undefined | {
  readonly filePath: string
  readonly filePosition: number
  readonly relativeFileVersion: "BEFORE" | "AFTER"
} =>
  anchor._tag === "changes"
    ? undefined
    : {
      filePath: anchor.path,
      filePosition: anchor.line,
      relativeFileVersion: anchor.relativeFileVersion
    }

const makeGateway = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const connections = yield* PluginConnectionMap
  const persistence = yield* Persistence
  const proposalAuthority = yield* GovernedActionProposalAuthority
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
    return yield* withProposalLease(
      target,
      (connection, runtimeAuthorityToken) =>
        connection.actionActorIdentity === undefined
          ? Effect.fail(
            new ReviewSuggestionPublicationGatewayError({ reason: "identity-unavailable" })
          )
          : connection.actionActorIdentity.pipe(
            Effect.map((actor) => ({
              connectedIdentity: {
                accountId: actor.providerAccountId,
                arn: actor.principal
              },
              authorityBinding: ReviewSuggestionPublicationAuthorityBinding.make(
                runtimeAuthorityToken
              )
            })),
            mapFailure
          )
    )
  })

  const publishedResult = (
    record: GovernedActionRecord,
    connectedIdentity: {
      readonly accountId: string
      readonly arn: string
    }
  ) =>
    record.head.state === "succeeded" &&
      record.head.lineage._tag === "terminal" &&
      record.head.lineage.receipt.status === "succeeded"
      ? Effect.succeed({
        publicationId: record.envelope.actionId,
        receipt: record.head.lineage.receipt,
        publishedAt: record.head.lineage.receipt.observedAt,
        connectedIdentity
      })
      : Effect.fail(
        reviewPublicationActionConfirmedNoWrite(record.head.state)
          ? rejected()
          : unavailable()
      )

  const replay = Effect.fn("ReviewSuggestionPublicationGateway.replay")(function*(command) {
    const checkedAt = yield* DateTime.now
    if (
      !reviewPublicationSessionIsAuthorized(
        command.session,
        command.target.workspaceId,
        checkedAt
      )
    ) return yield* conflict()
    const authority = yield* identity(command.target)
    if (authority.authorityBinding !== command.authorityBinding) return yield* conflict()
    const record = yield* persistence.governedActions.read({
      workspaceId: command.target.workspaceId,
      actionId: command.publicationId
    }).pipe(mapFailure)
    const expectedLocation = command.suggestion.anchor._tag === "changes"
      ? {}
      : {
        location: {
          filePath: command.suggestion.anchor.path,
          filePosition: command.suggestion.anchor.line,
          relativeFileVersion: command.suggestion.anchor.relativeFileVersion
        }
      }
    const expectedRequest = yield* Schema.decodeUnknownEffect(
      ProposePluginActionRequestV1
    )({
      actionKind: "comment",
      target: {
        entityType: "pull-request",
        vendorImmutableId: command.target.subject.pullRequestId
      },
      expectedRevision: Revision.make(command.target.sourceRevision),
      payload: {
        content: command.finalContent,
        ...expectedLocation
      },
      evidenceIds: [
        `pr-review:${command.jobId}:${command.suggestion.suggestionId}:${command.revisionId}`
      ]
    }).pipe(mapFailure)
    if (
      record.envelope.pluginConnectionId !== command.target.pluginConnectionId ||
      record.envelope.targetEntityId !== command.target.entityId ||
      record.envelope.origin._tag !== "human" ||
      record.envelope.origin.actor.personId !== command.session.actor.personId ||
      !reviewPublicationProposalRequestMatches(
        record.envelope.proposal.request,
        expectedRequest
      )
    ) return yield* conflict()
    return yield* publishedResult(record, authority.connectedIdentity)
  })

  const publish = Effect.fn("ReviewSuggestionPublicationGateway.publish")(function*(command) {
    const checkedAt = yield* DateTime.now
    if (
      !reviewPublicationSessionIsAuthorized(
        command.session,
        command.target.workspaceId,
        checkedAt
      )
    ) return yield* conflict()
    if (command.suggestion.state !== "draft") return yield* conflict()

    const prepared = yield* withProposalLease(
      command.target,
      (connection, runtimeAuthorityToken) =>
        Effect.gen(function*() {
          if (runtimeAuthorityToken !== command.authorityBinding) {
            return yield* conflict()
          }
          if (connection.actionActorIdentity === undefined) {
            return yield* new ReviewSuggestionPublicationGatewayError({
              reason: "identity-unavailable"
            })
          }
          const actor = yield* connection.actionActorIdentity.pipe(mapFailure)
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
          const location = reviewSuggestionPublicationLocation(command.suggestion.anchor)
          const proposalRequest = yield* Schema.decodeUnknownEffect(ProposePluginActionRequestV1)({
            actionKind: "comment",
            target: {
              entityType: "pull-request",
              vendorImmutableId: command.target.subject.pullRequestId
            },
            expectedRevision: Revision.make(command.target.sourceRevision),
            payload: {
              content: command.finalContent,
              ...(location === undefined ? {} : { location })
            },
            evidenceIds: [
              `pr-review:${command.jobId}:${command.suggestion.suggestionId}:${command.revisionId}`
            ]
          }).pipe(mapFailure)
          const proposal = yield* connection.proposeAction(proposalRequest).pipe(mapFailure)
          return {
            capability,
            connectionRecord,
            descriptor: connection.descriptor.descriptor,
            connectedIdentity: {
              accountId: actor.providerAccountId,
              arn: actor.principal
            },
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
    const prepareAuthorization = Effect.fn(
      "ReviewSuggestionPublicationGateway.prepareAuthorization"
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
      return GovernedActionCommitInput.make({
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
      })
    })
    const commitWhileAuthorityIsCurrent = <Success, Failure, Requirements>(
      effect: Effect.Effect<Success, Failure, Requirements>
    ) =>
      proposalAuthority.transactCurrent(
        {
          workspaceId: command.target.workspaceId,
          pluginConnectionId: command.target.pluginConnectionId,
          runtimeAuthorityToken: prepared.runtimeAuthorityToken
        },
        () => effect
      ).pipe(
        Effect.catchTag("GovernedActionSubmissionUnavailable", () => conflict()),
        mapFailure
      )
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
      return yield* publishedResult(record, prepared.connectedIdentity)
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
        !reviewPublicationProposalRequestMatches(
          envelope.proposal.request,
          prepared.proposal.request
        ) ||
        Number(envelope.pluginConnectionRevision) !== Number(prepared.connectionRecord.revision) ||
        envelope.pluginConnectionAuthorityDigest !== prepared.runtimeAuthorityToken ||
        envelope.origin._tag !== "human" ||
        envelope.origin.actor.personId !== command.session.actor.personId
      ) return yield* conflict()
      if (record.head.state === "succeeded") {
        return yield* publishedResult(record, prepared.connectedIdentity)
      }
      if (record.head.state === "proposed") {
        const authorization = yield* prepareAuthorization(
          envelope,
          record.headTransition.transitionId
        )
        yield* commitWhileAuthorityIsCurrent(
          persistence.governedActions.commit(authorization)
        )
      } else if (!reviewPublicationActionCanAdvance(record.head.state)) {
        return yield* reviewPublicationActionConfirmedNoWrite(record.head.state)
          ? rejected()
          : unavailable()
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
    const proposalCommit = GovernedActionCommitInput.make({
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
    })
    const authorizationCommit = yield* prepareAuthorization(envelope, proposalTransitionId)
    yield* commitWhileAuthorityIsCurrent(
      Effect.gen(function*() {
        yield* persistence.governedActions.commit(proposalCommit)
        yield* persistence.governedActions.commit(authorizationCommit)
      })
    )
    return yield* advanceAndRead(actionId)
  })

  return ReviewSuggestionPublicationGateway.of({
    identity,
    publish: (command) => publish(command).pipe(mapFailure),
    replay: (command) => replay(command).pipe(mapFailure)
  })
})

/** Live human-confirmed publication layer backed by the durable governed-action engine. */
export const governedReviewSuggestionPublicationGatewayLayer = Layer.effect(
  ReviewSuggestionPublicationGateway,
  makeGateway
)
